/**
 * Adapters API — IM Adapter 配置读写
 *
 * GET  /api/adapters  → 返回配置（敏感字段脱敏）
 * PUT  /api/adapters  → 更新配置（浅合并），返回更新后的脱敏配置
 */

import { adapterService } from '../services/adapterService.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import {
  pollWechatLoginWithQr,
  startWechatLoginWithQr,
  WECHAT_DEFAULT_BASE_URL,
} from '../../../adapters/wechat/protocol.js'

const ALLOWED_TOP_KEYS = new Set(['serverUrl', 'defaultProjectDir', 'telegram', 'feishu', 'wechat', 'pairing'])

export async function handleAdaptersApi(
  req: Request,
  _url: URL,
  _segments: string[],
): Promise<Response> {
  try {
    const tail = _segments.slice(2)
    if (tail[0] === 'wechat') {
      return handleWechatAdaptersApi(req, tail.slice(1))
    }

    if (req.method === 'GET') {
      const config = await adapterService.getConfig()
      return Response.json(config)
    }

    if (req.method === 'PUT') {
      const body = (await req.json()) as Record<string, unknown>
      // Basic validation: only allow known top-level keys
      for (const key of Object.keys(body)) {
        if (!ALLOWED_TOP_KEYS.has(key)) {
          throw ApiError.badRequest(`Unknown config key: ${key}`)
        }
      }
      await adapterService.updateConfig(body)
      const config = await adapterService.getConfig()
      return Response.json(config)
    }

    throw new ApiError(405, `Method ${req.method} not allowed`, 'METHOD_NOT_ALLOWED')
  } catch (error) {
    return errorResponse(error)
  }
}

async function handleWechatAdaptersApi(req: Request, tail: string[]): Promise<Response> {
  if (req.method === 'POST' && tail[0] === 'login' && tail[1] === 'start') {
    const result = await startWechatLoginWithQr({ force: true })
    return Response.json(result)
  }

  if (req.method === 'POST' && tail[0] === 'login' && tail[1] === 'poll') {
    const body = (await req.json()) as { sessionKey?: string }
    if (!body.sessionKey) throw ApiError.badRequest('Missing sessionKey')
    const result = await pollWechatLoginWithQr({ sessionKey: body.sessionKey })
    if (result.connected) {
      const pairedUsers = result.userId
        ? [{ userId: result.userId, displayName: 'WeChat User', pairedAt: Date.now() }]
        : []
      await adapterService.updateConfig({
        wechat: {
          accountId: result.accountId,
          botToken: result.botToken,
          baseUrl: result.baseUrl || WECHAT_DEFAULT_BASE_URL,
          userId: result.userId,
          pairedUsers,
          allowedUsers: [],
        },
      })
    }
    return Response.json(result.connected ? await adapterService.getConfig() : result)
  }

  if (req.method === 'POST' && tail[0] === 'unbind') {
    await adapterService.updateConfig({
      wechat: {
        accountId: undefined,
        botToken: undefined,
        baseUrl: WECHAT_DEFAULT_BASE_URL,
        userId: undefined,
        pairedUsers: [],
        allowedUsers: [],
      },
    })
    return Response.json(await adapterService.getConfig())
  }

  throw new ApiError(404, 'Unknown WeChat adapter endpoint', 'NOT_FOUND')
}
