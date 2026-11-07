import { describe, expect, it } from 'vitest'
import {
  eventType, extractText, isEvent, isMessage, parseFrame, pingFrame, respondFrame, stripMention,
  subscribeFrame, welcomeFrame, type MessageBody,
} from '../src/wecom-protocol.ts'

const body = (extra: Partial<MessageBody> = {}): MessageBody => ({
  msgid: 'm1', msgtype: 'text', chattype: 'single', from: { userid: 'u1' }, ...extra,
})

describe('extractText', () => {
  it('reads a text message', () => {
    expect(extractText(body({ text: { content: '你好' } }))).toBe('你好')
  })

  it('joins a mixed message', () => {
    expect(extractText(body({ msgtype: 'mixed', mixed: { msg_item: [{ msgtype: 'text', text: { content: 'A' } }, { msgtype: 'image' }] } }))).toBe('A\n[附件]')
  })

  it('returns nothing for an unknown type', () => {
    expect(extractText(body({ msgtype: 'file' }))).toBe('')
  })
})

describe('stripMention', () => {
  it('removes a leading mention', () => {
    expect(stripMention('@扣子 帮我改一下')).toBe('帮我改一下')
  })

  it('keeps text without a mention', () => {
    expect(stripMention('直接说需求')).toBe('直接说需求')
  })
})

describe('parseFrame', () => {
  it('parses a message callback', () => {
    const frame = parseFrame(JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: 'r1' }, body: { msgid: 'm1' } }))
    expect(frame?.cmd).toBe('aibot_msg_callback')
    expect(isMessage(frame!)).toBe(true)
  })

  it('returns undefined for broken JSON', () => {
    expect(parseFrame('{not json')).toBeUndefined()
  })

  it('recognizes an event callback', () => {
    const frame = parseFrame(JSON.stringify({ cmd: 'aibot_event_callback', headers: { req_id: 'r2' }, body: { event: { eventtype: 'enter_chat' } } }))
    expect(isEvent(frame!)).toBe(true)
    expect(eventType(frame!)).toBe('enter_chat')
  })

  it('reports an unknown event as other', () => {
    const frame = parseFrame(JSON.stringify({ cmd: 'aibot_event_callback', body: { event: { eventtype: 'x' } } }))
    expect(eventType(frame!)).toBe('other')
  })
})

describe('frames', () => {
  it('builds a subscribe frame', () => {
    const frame = subscribeFrame('bot', 'secret')
    expect(frame.cmd).toBe('aibot_subscribe')
    expect((frame.body as { bot_id: string }).bot_id).toBe('bot')
  })

  it('builds a ping frame', () => {
    expect(pingFrame('p1').cmd).toBe('ping')
  })

  it('builds a stream reply', () => {
    const frame = respondFrame('r1', 's1', '内容', true)
    expect(frame.cmd).toBe('aibot_respond_msg')
    expect((frame.body as { stream: { content: string } }).stream.content).toBe('内容')
  })

  it('builds a welcome frame', () => {
    expect(welcomeFrame('r1', 'hi').cmd).toBe('aibot_respond_welcome_msg')
  })
})
