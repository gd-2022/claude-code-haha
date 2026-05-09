import { create } from 'zustand'
import { settingsApi } from '../api/settings'
import { modelsApi } from '../api/models'
import { h5AccessApi } from '../api/h5Access'
import type { H5AccessSettings, PermissionMode, EffortLevel, ModelInfo, ThemeMode, WebSearchSettings } from '../types/settings'
import type { Locale } from '../i18n'
import { useUIStore } from './uiStore'

const LOCALE_STORAGE_KEY = 'cc-haha-locale'
let desktopNotificationsSaveQueue: Promise<void> = Promise.resolve()

function getStoredLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (stored === 'en' || stored === 'zh') return stored
  } catch { /* localStorage unavailable */ }
  return 'zh'
}

type SettingsStore = {
  permissionMode: PermissionMode
  currentModel: ModelInfo | null
  effortLevel: EffortLevel
  thinkingEnabled: boolean
  availableModels: ModelInfo[]
  activeProviderName: string | null
  locale: Locale
  theme: ThemeMode
  skipWebFetchPreflight: boolean
  desktopNotificationsEnabled: boolean
  webSearch: WebSearchSettings
  h5Access: H5AccessSettings
  h5AccessGeneratedToken: string | null
  isLoading: boolean
  error: string | null

  fetchAll: () => Promise<void>
  fetchH5Access: () => Promise<void>
  setPermissionMode: (mode: PermissionMode) => Promise<void>
  setModel: (modelId: string) => Promise<void>
  setEffort: (level: EffortLevel) => Promise<void>
  setThinkingEnabled: (enabled: boolean) => Promise<void>
  setLocale: (locale: Locale) => void
  setTheme: (theme: ThemeMode) => Promise<void>
  setSkipWebFetchPreflight: (enabled: boolean) => Promise<void>
  setDesktopNotificationsEnabled: (enabled: boolean) => Promise<void>
  setWebSearch: (settings: WebSearchSettings) => Promise<void>
  enableH5Access: () => Promise<void>
  disableH5Access: () => Promise<void>
  regenerateH5AccessToken: () => Promise<void>
  updateH5AccessSettings: (input: {
    allowedOrigins?: string[]
    publicBaseUrl?: string | null
  }) => Promise<void>
  clearH5AccessGeneratedToken: () => void
}

const DEFAULT_H5_ACCESS_SETTINGS: H5AccessSettings = {
  enabled: false,
  tokenPreview: null,
  allowedOrigins: [],
  publicBaseUrl: null,
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  permissionMode: 'default',
  currentModel: null,
  effortLevel: 'medium',
  thinkingEnabled: true,
  availableModels: [],
  activeProviderName: null,
  locale: getStoredLocale(),
  theme: useUIStore.getState().theme,
  skipWebFetchPreflight: true,
  desktopNotificationsEnabled: false,
  webSearch: { mode: 'auto', tavilyApiKey: '', braveApiKey: '' },
  h5Access: DEFAULT_H5_ACCESS_SETTINGS,
  h5AccessGeneratedToken: null,
  isLoading: false,
  error: null,

  fetchAll: async () => {
    set({ isLoading: true, error: null })
    try {
      const [{ mode }, modelsRes, { model }, { level }, userSettings, h5AccessRes] = await Promise.all([
        settingsApi.getPermissionMode(),
        modelsApi.list(),
        modelsApi.getCurrent(),
        modelsApi.getEffort(),
        settingsApi.getUser(),
        h5AccessApi.get().catch(() => ({ settings: DEFAULT_H5_ACCESS_SETTINGS })),
      ])
      const theme = userSettings.theme === 'dark' ? 'dark' : 'light'
      useUIStore.getState().setTheme(theme)
      set({
        permissionMode: mode,
        availableModels: modelsRes.models,
        activeProviderName: modelsRes.provider?.name ?? null,
        currentModel: model,
        effortLevel: level,
        thinkingEnabled: userSettings.alwaysThinkingEnabled !== false,
        theme,
        skipWebFetchPreflight: userSettings.skipWebFetchPreflight !== false,
        desktopNotificationsEnabled: userSettings.desktopNotificationsEnabled === true,
        webSearch: normalizeWebSearchSettings(userSettings.webSearch),
        h5Access: normalizeH5AccessSettings(h5AccessRes.settings),
        h5AccessGeneratedToken: null,
        isLoading: false,
        error: null,
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to load desktop settings'
      set({ isLoading: false, error: message })
      throw error
    }
  },

  fetchH5Access: async () => {
    const { settings } = await h5AccessApi.get()
    set({
      h5Access: normalizeH5AccessSettings(settings),
      h5AccessGeneratedToken: null,
    })
  },

  setPermissionMode: async (mode) => {
    const prev = get().permissionMode
    set({ permissionMode: mode })
    try {
      await settingsApi.setPermissionMode(mode)
    } catch {
      set({ permissionMode: prev })
    }
  },

  setModel: async (modelId) => {
    await modelsApi.setCurrent(modelId)
    const { model } = await modelsApi.getCurrent()
    set({ currentModel: model })
  },

  setEffort: async (level) => {
    const prev = get().effortLevel
    set({ effortLevel: level })
    try {
      await modelsApi.setEffort(level)
    } catch {
      set({ effortLevel: prev })
    }
  },

  setThinkingEnabled: async (enabled) => {
    const prev = get().thinkingEnabled
    set({ thinkingEnabled: enabled })
    try {
      await settingsApi.updateUser({ alwaysThinkingEnabled: enabled ? undefined : false })
    } catch {
      set({ thinkingEnabled: prev })
    }
  },

  setLocale: (locale) => {
    set({ locale })
    try { localStorage.setItem(LOCALE_STORAGE_KEY, locale) } catch { /* noop */ }
  },

  setTheme: async (theme) => {
    const prev = get().theme
    set({ theme })
    useUIStore.getState().setTheme(theme)
    try {
      await settingsApi.updateUser({ theme })
    } catch {
      set({ theme: prev })
      useUIStore.getState().setTheme(prev)
    }
  },

  setSkipWebFetchPreflight: async (enabled) => {
    const prev = get().skipWebFetchPreflight
    set({ skipWebFetchPreflight: enabled })
    try {
      await settingsApi.updateUser({ skipWebFetchPreflight: enabled })
    } catch {
      set({ skipWebFetchPreflight: prev })
    }
  },

  setDesktopNotificationsEnabled: async (enabled) => {
    const prev = get().desktopNotificationsEnabled
    set({ desktopNotificationsEnabled: enabled })
    const save = desktopNotificationsSaveQueue
      .catch(() => undefined)
      .then(async () => {
        if (get().desktopNotificationsEnabled !== enabled) return
        await settingsApi.updateUser({ desktopNotificationsEnabled: enabled })
      })

    desktopNotificationsSaveQueue = save

    try {
      await save
    } catch {
      if (get().desktopNotificationsEnabled === enabled) {
        set({ desktopNotificationsEnabled: prev })
      }
    }
  },

  setWebSearch: async (webSearch) => {
    const prev = get().webSearch
    const next = normalizeWebSearchSettings(webSearch)
    set({ webSearch: next })
    try {
      await settingsApi.updateUser({ webSearch: next })
    } catch {
      set({ webSearch: prev })
    }
  },

  enableH5Access: async () => {
    const { settings, token } = await h5AccessApi.enable()
    set({
      h5Access: normalizeH5AccessSettings(settings),
      h5AccessGeneratedToken: token,
    })
  },

  disableH5Access: async () => {
    const { settings } = await h5AccessApi.disable()
    set({
      h5Access: normalizeH5AccessSettings(settings),
      h5AccessGeneratedToken: null,
    })
  },

  regenerateH5AccessToken: async () => {
    const { settings, token } = await h5AccessApi.regenerate()
    set({
      h5Access: normalizeH5AccessSettings(settings),
      h5AccessGeneratedToken: token,
    })
  },

  updateH5AccessSettings: async (input) => {
    const { settings } = await h5AccessApi.update(input)
    set({
      h5Access: normalizeH5AccessSettings(settings),
    })
  },

  clearH5AccessGeneratedToken: () => {
    set({ h5AccessGeneratedToken: null })
  },
}))

function normalizeWebSearchSettings(settings: WebSearchSettings | undefined): WebSearchSettings {
  return {
    mode: settings?.mode ?? 'auto',
    tavilyApiKey: settings?.tavilyApiKey ?? '',
    braveApiKey: settings?.braveApiKey ?? '',
  }
}

function normalizeH5AccessSettings(settings: H5AccessSettings | undefined): H5AccessSettings {
  return {
    enabled: settings?.enabled === true,
    tokenPreview: settings?.tokenPreview ?? null,
    allowedOrigins: Array.isArray(settings?.allowedOrigins) ? settings.allowedOrigins : [],
    publicBaseUrl: settings?.publicBaseUrl ?? null,
  }
}
