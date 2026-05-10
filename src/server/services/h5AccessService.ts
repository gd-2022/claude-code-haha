import { createHash, randomBytes } from 'node:crypto'
import { ApiError } from '../middleware/errorHandler.js'
import { ManagedSettingsService } from './managedSettingsService.js'

export type H5AccessSettings = {
  enabled: boolean
  tokenPreview: string | null
  allowedOrigins: string[]
  publicBaseUrl: string | null
}

export type H5AccessEnableResult = {
  settings: H5AccessSettings
  token: string
}

type StoredH5AccessSettings = H5AccessSettings & {
  tokenHash: string | null
}

const DEFAULT_STORED_SETTINGS: StoredH5AccessSettings = {
  enabled: false,
  tokenHash: null,
  tokenPreview: null,
  allowedOrigins: [],
  publicBaseUrl: null,
}

const TOKEN_HASH_RE = /^[a-f0-9]{64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function toPublicSettings(settings: StoredH5AccessSettings): H5AccessSettings {
  return {
    enabled: settings.enabled,
    tokenPreview: settings.tokenPreview,
    allowedOrigins: settings.allowedOrigins,
    publicBaseUrl: settings.publicBaseUrl,
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function createToken(): string {
  return `h5_${randomBytes(32).toString('base64url')}`
}

function createTokenPreview(token: string): string {
  return `${token.slice(0, 7)}...${token.slice(-4)}`
}

function normalizeOriginInput(origin: string, fieldName = 'allowedOrigins'): string {
  if (origin.includes('*')) {
    throw ApiError.badRequest(`${fieldName} must not contain wildcard origins`)
  }

  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw ApiError.badRequest(`Invalid origin: ${origin}`)
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw ApiError.badRequest(`Invalid origin protocol: ${origin}`)
  }

  if (parsed.username || parsed.password) {
    throw ApiError.badRequest(`Invalid origin credentials: ${origin}`)
  }

  return parsed.origin
}

function normalizeAllowedOrigins(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw ApiError.badRequest('allowedOrigins must be an array of strings')
  }

  const normalized = input.map((origin) => {
    if (typeof origin !== 'string') {
      throw ApiError.badRequest('allowedOrigins must be an array of strings')
    }
    return normalizeOriginInput(origin)
  })

  return [...new Set(normalized)]
}

function normalizePublicBaseUrl(input: unknown): string | null {
  if (input === null || input === undefined || input === '') {
    return null
  }

  if (typeof input !== 'string') {
    throw ApiError.badRequest('publicBaseUrl must be a string or null')
  }

  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    throw ApiError.badRequest(`Invalid publicBaseUrl: ${input}`)
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw ApiError.badRequest(`Invalid publicBaseUrl protocol: ${input}`)
  }

  if (parsed.username || parsed.password) {
    throw ApiError.badRequest(`Invalid publicBaseUrl credentials: ${input}`)
  }

  const normalizedPath = parsed.pathname.replace(/\/+$/, '')
  return `${parsed.origin}${normalizedPath === '/' ? '' : normalizedPath}`
}

function normalizeStoredSettings(value: unknown): StoredH5AccessSettings {
  if (!isRecord(value)) {
    return { ...DEFAULT_STORED_SETTINGS }
  }

  const allowedOrigins = Array.isArray(value.allowedOrigins)
    ? [...new Set(value.allowedOrigins.flatMap((origin) => {
        if (typeof origin !== 'string') {
          return []
        }

        try {
          return [normalizeOriginInput(origin)]
        } catch {
          return []
        }
      }))]
    : []

  let publicBaseUrl: string | null = null
  if (typeof value.publicBaseUrl === 'string') {
    try {
      publicBaseUrl = normalizePublicBaseUrl(value.publicBaseUrl)
    } catch {
      publicBaseUrl = null
    }
  }

  const tokenHash = typeof value.tokenHash === 'string' && TOKEN_HASH_RE.test(value.tokenHash)
    ? value.tokenHash
    : null

  return {
    enabled: value.enabled === true && tokenHash !== null,
    tokenHash,
    tokenPreview: tokenHash && typeof value.tokenPreview === 'string' ? value.tokenPreview : null,
    allowedOrigins,
    publicBaseUrl,
  }
}

export class H5AccessService {
  private managedSettingsService = new ManagedSettingsService()

  private async readStoredSettings(): Promise<{
    managedSettings: Record<string, unknown>
    h5Access: StoredH5AccessSettings
  }> {
    const managedSettings = await this.managedSettingsService.readSettings()
    return {
      managedSettings,
      h5Access: normalizeStoredSettings(managedSettings.h5Access),
    }
  }

  private async setToken(
    managedSettings: Record<string, unknown>,
    current: StoredH5AccessSettings,
  ): Promise<{
    settings: Record<string, unknown>
    result: H5AccessEnableResult
  }> {
    const token = createToken()
    const nextSettings: StoredH5AccessSettings = {
      ...current,
      enabled: true,
      tokenHash: hashToken(token),
      tokenPreview: createTokenPreview(token),
    }

    return {
      settings: {
        ...managedSettings,
        h5Access: nextSettings,
      },
      result: {
        settings: toPublicSettings(nextSettings),
        token,
      },
    }
  }

  async getSettings(): Promise<H5AccessSettings> {
    const { h5Access } = await this.readStoredSettings()
    return toPublicSettings(h5Access)
  }

  async enable(): Promise<H5AccessEnableResult> {
    return this.managedSettingsService.updateSettings(async (current) => {
      return this.setToken(current, normalizeStoredSettings(current.h5Access))
    })
  }

  async disable(): Promise<H5AccessSettings> {
    return this.managedSettingsService.updateSettings(async (current) => {
      const h5Access = normalizeStoredSettings(current.h5Access)
      const nextSettings: StoredH5AccessSettings = {
        ...h5Access,
        enabled: false,
        tokenHash: null,
        tokenPreview: null,
      }

      return {
        settings: {
          ...current,
          h5Access: nextSettings,
        },
        result: toPublicSettings(nextSettings),
      }
    })
  }

  async regenerateToken(): Promise<H5AccessEnableResult> {
    return this.managedSettingsService.updateSettings(async (current) => {
      return this.setToken(current, normalizeStoredSettings(current.h5Access))
    })
  }

  async updateSettings(input: {
    allowedOrigins?: string[]
    publicBaseUrl?: string | null
  }): Promise<H5AccessSettings> {
    return this.managedSettingsService.updateSettings(async (current) => {
      const h5Access = normalizeStoredSettings(current.h5Access)
      const nextSettings: StoredH5AccessSettings = {
        ...h5Access,
        allowedOrigins: input.allowedOrigins === undefined
          ? h5Access.allowedOrigins
          : normalizeAllowedOrigins(input.allowedOrigins),
        publicBaseUrl: input.publicBaseUrl === undefined
          ? h5Access.publicBaseUrl
          : normalizePublicBaseUrl(input.publicBaseUrl),
      }

      return {
        settings: {
          ...current,
          h5Access: nextSettings,
        },
        result: toPublicSettings(nextSettings),
      }
    })
  }

  async validateToken(token: string | null | undefined): Promise<boolean> {
    if (!token) {
      return false
    }

    const { h5Access } = await this.readStoredSettings()
    if (!h5Access.enabled || !h5Access.tokenHash) {
      return false
    }

    return hashToken(token) === h5Access.tokenHash
  }

  async isOriginAllowed(origin: string | null | undefined): Promise<boolean> {
    if (!origin) {
      return false
    }

    const { h5Access } = await this.readStoredSettings()
    if (!h5Access.enabled) {
      return false
    }

    try {
      const normalizedOrigin = normalizeOriginInput(origin, 'origin')
      return h5Access.allowedOrigins.includes(normalizedOrigin)
    } catch {
      return false
    }
  }
}
