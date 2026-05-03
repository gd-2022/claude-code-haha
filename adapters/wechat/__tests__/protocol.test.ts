import { describe, expect, it } from 'bun:test'
import { buildClientVersion, extractWechatText } from '../protocol.js'

describe('WeChat protocol helpers', () => {
  it('encodes iLink client versions like the OpenClaw Weixin plugin', () => {
    expect(buildClientVersion('2.1.7')).toBe((2 << 16) | (1 << 8) | 7)
    expect(buildClientVersion('1.0.11')).toBe(65547)
  })

  it('extracts plain text from WeChat message items', () => {
    expect(extractWechatText([
      { type: 1, text_item: { text: 'hello' } },
    ])).toBe('hello')
  })

  it('extracts voice transcription when text items are absent', () => {
    expect(extractWechatText([
      { type: 3, voice_item: { text: 'voice text' } },
    ])).toBe('voice text')
  })

  it('preserves quoted text context', () => {
    expect(extractWechatText([
      {
        type: 1,
        text_item: { text: 'reply' },
        ref_msg: {
          title: 'quote title',
          message_item: { type: 1, text_item: { text: 'quoted body' } },
        },
      },
    ])).toBe('[引用: quote title | quoted body]\nreply')
  })
})
