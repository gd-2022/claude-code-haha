import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { getConfiguredWorkDir, loadConfig } from '../config.js'

describe('adapter config defaults', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalAdapterDefaultWorkDir = process.env.CLAUDE_ADAPTER_DEFAULT_WORK_DIR
  const originalPwd = process.env.PWD

  afterEach(() => {
    restoreEnv('CLAUDE_CONFIG_DIR', originalConfigDir)
    restoreEnv('CLAUDE_ADAPTER_DEFAULT_WORK_DIR', originalAdapterDefaultWorkDir)
    restoreEnv('PWD', originalPwd)
  })

  it('uses the user shell working directory when no default project is configured', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-config-'))
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-workdir-'))
    try {
      process.env.CLAUDE_CONFIG_DIR = configDir
      delete process.env.CLAUDE_ADAPTER_DEFAULT_WORK_DIR
      process.env.PWD = workDir

      const config = loadConfig()

      expect(config.telegram.defaultWorkDir).toBe(fs.realpathSync(workDir))
      expect(config.feishu.defaultWorkDir).toBe(fs.realpathSync(workDir))
      expect(config.wechat.defaultWorkDir).toBe(fs.realpathSync(workDir))
      expect(getConfiguredWorkDir(config, config.wechat)).toBe(fs.realpathSync(workDir))
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true })
      fs.rmSync(workDir, { recursive: true, force: true })
    }
  })

  it('keeps the explicit default project ahead of the platform default work dir', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-config-'))
    const defaultProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-project-'))
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-workdir-'))
    try {
      fs.writeFileSync(
        path.join(configDir, 'adapters.json'),
        JSON.stringify({ defaultProjectDir }),
      )
      process.env.CLAUDE_CONFIG_DIR = configDir
      process.env.CLAUDE_ADAPTER_DEFAULT_WORK_DIR = workDir

      const config = loadConfig()

      expect(getConfiguredWorkDir(config, config.wechat)).toBe(defaultProjectDir)
      expect(config.wechat.defaultWorkDir).toBe(fs.realpathSync(workDir))
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true })
      fs.rmSync(defaultProjectDir, { recursive: true, force: true })
      fs.rmSync(workDir, { recursive: true, force: true })
    }
  })
})

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}
