import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { canBypassRemoteAuthForLocalBrowser, startServer } from '../index.js'
import { H5AccessService } from '../services/h5AccessService.js'
import { ProviderService } from '../services/providerService.js'

let server: ReturnType<typeof Bun.serve> | undefined
let baseUrl = ''
let wsBaseUrl = ''
let tmpDir = ''
let originalConfigDir: string | undefined
let originalAnthropicApiKey: string | undefined
let originalServerPort = 3456

async function waitForServer(url: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
    } catch {}

    await Bun.sleep(50)
  }

  throw new Error(`Timed out waiting for server at ${url}`)
}

function randomPort(): number {
  return 18000 + Math.floor(Math.random() * 10000)
}

async function startRemoteServer(): Promise<void> {
  const port = randomPort()
  server = startServer(port, '0.0.0.0')
  baseUrl = `http://127.0.0.1:${port}`
  wsBaseUrl = `ws://127.0.0.1:${port}`
  await waitForServer(`${baseUrl}/health`)
}

function makeUpgradeHeaders(origin?: string): HeadersInit {
  return {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    ...(origin ? { Origin: origin } : {}),
  }
}

async function enableH5Access(options: {
  allowedOrigins?: string[]
} = {}): Promise<string> {
  const service = new H5AccessService()
  if (options.allowedOrigins) {
    await service.updateSettings({ allowedOrigins: options.allowedOrigins })
  }
  const { token } = await service.enable()
  if (options.allowedOrigins) {
    await service.updateSettings({ allowedOrigins: options.allowedOrigins })
  }
  return token
}

function expectWebSocketOpen(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error(`Timed out opening websocket: ${url}`))
    }, 5000)

    ws.addEventListener('open', () => {
      clearTimeout(timeout)
      ws.close()
      resolve()
    })

    ws.addEventListener('error', () => {
      clearTimeout(timeout)
      reject(new Error(`WebSocket failed to open: ${url}`))
    })
  })
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'h5-access-auth-test-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
  originalServerPort = ProviderService.getServerPort()
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  delete process.env.ANTHROPIC_API_KEY
  await startRemoteServer()
})

afterEach(async () => {
  server?.stop(true)
  server = undefined
  ProviderService.setServerPort(originalServerPort)

  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir

  if (originalAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey

  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('remote H5 auth and CORS integration', () => {
  test('rejects /api/status when H5 is disabled and no Anthropic key exists', async () => {
    const response = await fetch(`${baseUrl}/api/status`)

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Unauthorized',
    })
  })

  test('allows localhost WebUI origin without H5 token for browser development', async () => {
    const response = await fetch(`${baseUrl}/api/status`, {
      headers: {
        Origin: 'http://127.0.0.1:5179',
      },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://127.0.0.1:5179')
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
    })
  })

  test('only lets localhost WebUI origin bypass H5 auth for loopback or private server hosts', () => {
    expect(canBypassRemoteAuthForLocalBrowser('http://127.0.0.1:5179', '127.0.0.1')).toBe(true)
    expect(canBypassRemoteAuthForLocalBrowser('http://localhost:5179', '192.168.0.102')).toBe(true)
    expect(canBypassRemoteAuthForLocalBrowser('http://localhost:5179', '10.0.0.5')).toBe(true)
    expect(canBypassRemoteAuthForLocalBrowser('http://localhost:5179', '172.20.1.8')).toBe(true)
    expect(canBypassRemoteAuthForLocalBrowser('http://localhost:5179', 'public.example.com')).toBe(false)
    expect(canBypassRemoteAuthForLocalBrowser('http://192.168.0.50:5179', '192.168.0.102')).toBe(false)
  })

  test('rejects /api/status when H5 is enabled and bearer token is wrong', async () => {
    await enableH5Access()

    const response = await fetch(`${baseUrl}/api/status`, {
      headers: {
        Authorization: 'Bearer wrong-token',
      },
    })

    expect(response.status).toBe(401)
  })

  test('allows /api/status when H5 is enabled and bearer token is correct', async () => {
    const token = await enableH5Access()

    const response = await fetch(`${baseUrl}/api/status`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
    })
  })

  test('rejects unlisted CORS origins', async () => {
    const token = await enableH5Access({
      allowedOrigins: ['https://allowed.example.com'],
    })

    const response = await fetch(`${baseUrl}/api/status`, {
      method: 'OPTIONS',
      headers: {
        ...makeUpgradeHeaders('https://blocked.example.com'),
        Authorization: `Bearer ${token}`,
        'Access-Control-Request-Method': 'GET',
      },
    })

    expect(response.status).toBe(403)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  test('allows configured CORS origins and includes Vary: Origin', async () => {
    const token = await enableH5Access({
      allowedOrigins: ['https://allowed.example.com'],
    })

    const response = await fetch(`${baseUrl}/api/status`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://allowed.example.com',
        Authorization: `Bearer ${token}`,
        'Access-Control-Request-Method': 'GET',
      },
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://allowed.example.com',
    )
    expect(response.headers.get('Vary')).toBe('Origin')
  })

  test('rejects websocket upgrade without a valid H5 token and accepts the correct token', async () => {
    const token = await enableH5Access()

    const missingTokenResponse = await fetch(`${baseUrl}/ws/h5-auth-test`, {
      headers: makeUpgradeHeaders(),
    })
    expect(missingTokenResponse.status).toBe(401)

    const wrongTokenResponse = await fetch(`${baseUrl}/ws/h5-auth-test?token=wrong-token`, {
      headers: makeUpgradeHeaders(),
    })
    expect(wrongTokenResponse.status).toBe(401)

    await expectWebSocketOpen(`${wsBaseUrl}/ws/h5-auth-test?token=${token}`)
  })
})
