import { api } from './client'
import type { AdapterFileConfig } from '../types/adapter'

export const adaptersApi = {
  getConfig() {
    return api.get<AdapterFileConfig>('/api/adapters')
  },

  updateConfig(patch: Partial<AdapterFileConfig>) {
    return api.put<AdapterFileConfig>('/api/adapters', patch)
  },

  startWechatLogin() {
    return api.post<{ qrcodeUrl?: string; message: string; sessionKey: string }>('/api/adapters/wechat/login/start', {})
  },

  pollWechatLogin(sessionKey: string) {
    return api.post<
      | AdapterFileConfig
      | { connected: false; status: string; message: string }
    >('/api/adapters/wechat/login/poll', { sessionKey }, { timeout: 45_000 })
  },

  unbindWechat() {
    return api.post<AdapterFileConfig>('/api/adapters/wechat/unbind', {})
  },
}
