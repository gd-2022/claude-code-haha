import * as path from 'node:path'
import { WsBridge, type ServerMessage } from '../common/ws-bridge.js'
import { MessageDedup } from '../common/message-dedup.js'
import { enqueue } from '../common/chat-queue.js'
import { getConfiguredWorkDir, loadConfig } from '../common/config.js'
import {
  formatImHelp,
  formatImStatus,
  formatPermissionRequest,
  splitMessage,
} from '../common/format.js'
import { SessionStore } from '../common/session-store.js'
import { AdapterHttpClient } from '../common/http-client.js'
import { isAllowedUser } from '../common/pairing.js'
import {
  extractWechatText,
  getWechatUpdates,
  sendWechatText,
  WECHAT_DEFAULT_BASE_URL,
  type WechatMessage,
} from './protocol.js'

const WECHAT_TEXT_LIMIT = 3500
const GET_UPDATES_TIMEOUT_MS = 35_000

const config = loadConfig()
if (!config.wechat.botToken || !config.wechat.accountId) {
  console.error('[WeChat] Missing QR-bound account. Bind WeChat in Desktop Settings > IM.')
  process.exit(1)
}

const baseUrl = config.wechat.baseUrl || WECHAT_DEFAULT_BASE_URL
const accountId = config.wechat.accountId
const botToken = config.wechat.botToken
const bridge = new WsBridge(config.serverUrl, 'wechat')
const dedup = new MessageDedup()
const sessionStore = new SessionStore()
const httpClient = new AdapterHttpClient(config.serverUrl)
const defaultWorkDir = getConfiguredWorkDir(config, config.wechat)
const pendingProjectSelection = new Map<string, boolean>()
const runtimeStates = new Map<string, ChatRuntimeState>()
const accumulatedText = new Map<string, string>()
const contextTokens = new Map<string, string>()
const pendingPermissions = new Map<string, Set<string>>()

let getUpdatesBuf = ''
let stopped = false

type ChatRuntimeState = {
  state: 'idle' | 'thinking' | 'streaming' | 'tool_executing' | 'permission_pending'
  verb?: string
  model?: string
  pendingPermissionCount: number
}

function getRuntimeState(chatId: string): ChatRuntimeState {
  let state = runtimeStates.get(chatId)
  if (!state) {
    state = { state: 'idle', pendingPermissionCount: 0 }
    runtimeStates.set(chatId, state)
  }
  return state
}

async function sendText(chatId: string, text: string): Promise<void> {
  const chunks = splitMessage(text, WECHAT_TEXT_LIMIT)
  const contextToken = contextTokens.get(chatId)
  for (const chunk of chunks) {
    await sendWechatText({
      baseUrl,
      token: botToken,
      to: chatId,
      text: chunk,
      contextToken,
    })
  }
  console.log(`[WeChat] Sent ${chunks.length} message chunk(s) to ${redactChatId(chatId)}`)
}

function clearTransientChatState(chatId: string): void {
  accumulatedText.delete(chatId)
  pendingPermissions.delete(chatId)
  const runtime = getRuntimeState(chatId)
  runtime.state = 'idle'
  runtime.verb = undefined
  runtime.pendingPermissionCount = 0
}

async function ensureExistingSession(chatId: string): Promise<{ sessionId: string; workDir: string } | null> {
  const stored = sessionStore.get(chatId)
  if (!stored) return null

  if (!bridge.hasSession(chatId)) {
    bridge.connectSession(chatId, stored.sessionId)
    bridge.onServerMessage(chatId, (msg) => handleServerMessage(chatId, msg))
    const opened = await bridge.waitForOpen(chatId)
    if (!opened) return null
  }

  return stored
}

async function buildStatusText(chatId: string): Promise<string> {
  const stored = await ensureExistingSession(chatId)
  if (!stored) return formatImStatus(null)

  const runtime = getRuntimeState(chatId)
  let projectName = path.basename(stored.workDir) || stored.workDir
  let branch: string | null = null

  try {
    const gitInfo = await httpClient.getGitInfo(stored.sessionId)
    projectName = gitInfo.repoName || path.basename(gitInfo.workDir) || projectName
    branch = gitInfo.branch
  } catch {
    // Keep IM status best-effort.
  }

  return formatImStatus({
    sessionId: stored.sessionId,
    projectName,
    branch,
    model: runtime.model,
    state: runtime.state,
    verb: runtime.verb,
    pendingPermissionCount: runtime.pendingPermissionCount,
  })
}

async function ensureSession(chatId: string): Promise<boolean> {
  if (bridge.hasSession(chatId)) return true

  const stored = sessionStore.get(chatId)
  if (stored) {
    bridge.connectSession(chatId, stored.sessionId)
    bridge.onServerMessage(chatId, (msg) => handleServerMessage(chatId, msg))
    return await bridge.waitForOpen(chatId)
  }

  const workDir = defaultWorkDir
  if (workDir) return await createSessionForChat(chatId, workDir)

  await showProjectPicker(chatId)
  return false
}

async function createSessionForChat(chatId: string, workDir: string): Promise<boolean> {
  try {
    bridge.resetSession(chatId)
    clearTransientChatState(chatId)
    const sessionId = await httpClient.createSession(workDir)
    sessionStore.set(chatId, sessionId, workDir)
    bridge.connectSession(chatId, sessionId)
    bridge.onServerMessage(chatId, (msg) => handleServerMessage(chatId, msg))
    const opened = await bridge.waitForOpen(chatId)
    if (!opened) {
      await sendText(chatId, '连接服务器超时，请重试。')
      return false
    }
    return true
  } catch (err) {
    await sendText(chatId, `无法创建会话: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

async function showProjectPicker(chatId: string): Promise<void> {
  try {
    const projects = await httpClient.listRecentProjects()
    if (projects.length === 0) {
      await sendText(chatId, `没有找到最近的项目。发送 /new 会使用默认工作目录：${defaultWorkDir}\n也可以发送 /new /path/to/project 指定项目。`)
      return
    }

    const lines = projects.slice(0, 10).map((p, i) =>
      `${i + 1}. ${p.projectName}${p.branch ? ` (${p.branch})` : ''}\n   ${p.realPath}`
    )
    pendingProjectSelection.set(chatId, true)
    await sendText(chatId, `选择项目（回复编号）：\n\n${lines.join('\n\n')}\n\n下次可直接 /new <编号、名称或绝对路径> 快速新建会话`)
  } catch (err) {
    await sendText(chatId, `无法获取项目列表: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function startNewSession(chatId: string, query?: string): Promise<void> {
  bridge.resetSession(chatId)
  sessionStore.delete(chatId)
  clearTransientChatState(chatId)
  pendingProjectSelection.delete(chatId)

  if (query) {
    try {
      const { project, ambiguous } = await httpClient.matchProject(query)
      if (project) {
        const ok = await createSessionForChat(chatId, project.realPath)
        if (ok) await sendText(chatId, `已新建会话：${project.projectName}${project.branch ? ` (${project.branch})` : ''}`)
        return
      }
      if (ambiguous) {
        const list = ambiguous.map((p, i) => `${i + 1}. ${p.projectName} - ${p.realPath}`).join('\n')
        await sendText(chatId, `匹配到多个项目，请更精确：\n\n${list}`)
        return
      }
      await sendText(chatId, `未找到匹配 "${query}" 的项目。发送 /projects 查看完整列表。`)
    } catch (err) {
      await sendText(chatId, err instanceof Error ? err.message : String(err))
    }
    return
  }

  const workDir = defaultWorkDir
  if (workDir) {
    const ok = await createSessionForChat(chatId, workDir)
    if (ok) await sendText(chatId, '已新建会话，可以开始对话了。')
  } else {
    await showProjectPicker(chatId)
  }
}

async function handleServerMessage(chatId: string, msg: ServerMessage): Promise<void> {
  const runtime = getRuntimeState(chatId)

  switch (msg.type) {
    case 'connected':
      break
    case 'status':
      runtime.state = msg.state
      runtime.verb = typeof msg.verb === 'string' ? msg.verb : undefined
      break
    case 'content_delta':
      if (typeof msg.text === 'string' && msg.text) {
        accumulatedText.set(chatId, (accumulatedText.get(chatId) ?? '') + msg.text)
      }
      break
    case 'permission_request': {
      runtime.pendingPermissionCount += 1
      runtime.state = 'permission_pending'
      let pending = pendingPermissions.get(chatId)
      if (!pending) {
        pending = new Set()
        pendingPermissions.set(chatId, pending)
      }
      pending.add(msg.requestId)
      await sendText(
        chatId,
        `${formatPermissionRequest(msg.toolName, msg.input, msg.requestId)}\n\n回复 /allow ${msg.requestId} 允许，或 /deny ${msg.requestId} 拒绝。`,
      )
      break
    }
    case 'message_complete': {
      runtime.state = 'idle'
      runtime.verb = undefined
      const text = accumulatedText.get(chatId)
      accumulatedText.delete(chatId)
      if (text?.trim()) await sendText(chatId, text)
      break
    }
    case 'error':
      runtime.state = 'idle'
      runtime.verb = undefined
      accumulatedText.delete(chatId)
      await sendText(chatId, `错误: ${msg.message}`)
      break
    case 'system_notification':
      if (msg.subtype === 'init' && msg.data && typeof msg.data === 'object') {
        const model = (msg.data as Record<string, unknown>).model
        if (typeof model === 'string' && model.trim()) runtime.model = model
      }
      break
  }
}

async function routeUserMessage(message: WechatMessage): Promise<void> {
  const chatId = message.from_user_id
  if (!chatId) return
  const messageKey = `${message.message_id ?? ''}:${message.seq ?? ''}:${message.create_time_ms ?? ''}`
  if (!dedup.tryRecord(messageKey)) return
  if (message.context_token) contextTokens.set(chatId, message.context_token)

  const text = extractWechatText(message.item_list).trim()
  if (!text) return
  console.log(`[WeChat] Received from ${redactChatId(chatId)}: ${text.slice(0, 80)}`)

  if (!isAllowedUser('wechat', chatId)) {
    await sendText(chatId, '未绑定。请在 Claude Code 桌面端「设置 -> IM 接入 -> 微信」中扫码绑定。')
    return
  }

  enqueue(chatId, async () => {
    if (text === '/help' || text === '帮助') {
      await sendText(chatId, formatImHelp())
      return
    }
    if (text === '/status' || text === '状态') {
      await sendText(chatId, await buildStatusText(chatId))
      return
    }
    if (text === '/projects' || text === '项目列表') {
      await showProjectPicker(chatId)
      return
    }
    if (text === '/new' || text === '新会话' || text.startsWith('/new ')) {
      const arg = text.startsWith('/new ') ? text.slice(5).trim() : ''
      await startNewSession(chatId, arg || undefined)
      return
    }
    if (text === '/stop' || text === '停止') {
      const stored = await ensureExistingSession(chatId)
      if (!stored) {
        await sendText(chatId, formatImStatus(null))
        return
      }
      bridge.sendStopGeneration(chatId)
      await sendText(chatId, '已发送停止信号。')
      return
    }
    if (text === '/clear' || text === '清空') {
      const stored = await ensureExistingSession(chatId)
      if (!stored) {
        await sendText(chatId, formatImStatus(null))
        return
      }
      clearTransientChatState(chatId)
      const sent = bridge.sendUserMessage(chatId, '/clear')
      await sendText(chatId, sent ? '已清空当前会话上下文。' : '无法发送 /clear，请先发送 /new 重新连接会话。')
      return
    }
    if (text.startsWith('/allow ') || text.startsWith('/deny ')) {
      const requestId = text.split(/\s+/)[1]
      if (!requestId) return
      const allowed = text.startsWith('/allow ')
      const sent = bridge.sendPermissionResponse(chatId, requestId, allowed)
      const runtime = getRuntimeState(chatId)
      runtime.pendingPermissionCount = Math.max(0, runtime.pendingPermissionCount - 1)
      pendingPermissions.get(chatId)?.delete(requestId)
      await sendText(chatId, sent ? (allowed ? '已允许。' : '已拒绝。') : '权限响应发送失败，请检查会话状态。')
      return
    }
    if (pendingProjectSelection.has(chatId)) {
      await startNewSession(chatId, text)
      return
    }

    const ready = await ensureSession(chatId)
    if (!ready) return
    const sent = bridge.sendUserMessage(chatId, text)
    if (!sent) await sendText(chatId, '消息发送失败，连接可能已断开。请发送 /new 重新开始。')
  })
}

async function pollLoop(): Promise<void> {
  while (!stopped) {
    try {
      const resp = await getWechatUpdates({
        baseUrl,
        token: botToken,
        getUpdatesBuf,
        timeoutMs: GET_UPDATES_TIMEOUT_MS,
      })
      if (resp.get_updates_buf) getUpdatesBuf = resp.get_updates_buf
      const hasRetError = typeof resp.ret === 'number' && resp.ret !== 0
      const hasErrCode = typeof resp.errcode === 'number' && resp.errcode !== 0
      if (hasRetError || hasErrCode) {
        console.warn(`[WeChat] getupdates error: ${resp.errcode ?? resp.ret} ${resp.errmsg ?? ''}`)
        await sleep(3000)
        continue
      }
      for (const msg of resp.msgs ?? []) {
        await routeUserMessage(msg)
      }
    } catch (err) {
      console.error('[WeChat] poll loop error:', err instanceof Error ? err.message : err)
      await sleep(3000)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function redactChatId(chatId: string): string {
  if (chatId.length <= 12) return chatId
  return `${chatId.slice(0, 6)}...${chatId.slice(-6)}`
}

console.log('[WeChat] Starting adapter...')
console.log(`[WeChat] Account: ${accountId}`)
void pollLoop()

process.on('SIGINT', () => {
  console.log('[WeChat] Shutting down...')
  stopped = true
  bridge.destroy()
  dedup.destroy()
  process.exit(0)
})
