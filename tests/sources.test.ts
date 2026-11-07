import { describe, expect, it } from 'vitest'
import { inScope, wecomThreadId, wecomTrigger, WeComConfigSchema } from '../src/sources/wecom.ts'

const config = WeComConfigSchema.parse({ botId: 'b', secret: 's' })

const body = (extra: Record<string, unknown> = {}) => ({
  msgid: 'm1', msgtype: 'text', chattype: 'single' as const, from: { userid: 'u1' },
  text: { content: '@扣子 帮我改一下' }, ...extra,
})

describe('inScope', () => {
  it('accepts a direct message when direct messages are on', () => {
    expect(inScope(body() as never, config)).toBe(true)
  })

  it('rejects a direct message when they are off', () => {
    expect(inScope(body() as never, { ...config, directMessages: false })).toBe(false)
  })

  it('accepts a listed group', () => {
    const listed = { ...config, chats: [{ chatId: 'g1' }] }
    expect(inScope(body({ chattype: 'group', chatid: 'g1' }) as never, listed)).toBe(true)
  })

  it('rejects an unlisted group by default', () => {
    expect(inScope(body({ chattype: 'group', chatid: 'g2' }) as never, config)).toBe(false)
  })

  it('accepts an unlisted group when other chats take mentions', () => {
    const open = { ...config, otherChats: 'mentions' as const }
    expect(inScope(body({ chattype: 'group', chatid: 'g2' }) as never, open)).toBe(true)
  })
})

describe('wecomTrigger', () => {
  it('builds a deterministic trigger', () => {
    const trigger = wecomTrigger(body() as never)
    expect(trigger.id).toBe(wecomTrigger(body() as never).id)
  })

  it('strips the mention from the text', () => {
    expect(wecomTrigger(body() as never).text).toBe('帮我改一下')
  })

  it('marks a direct message as addressed', () => {
    expect(wecomTrigger(body() as never).addressed).toBe('direct')
  })

  it('records the sender and message id', () => {
    const trigger = wecomTrigger(body() as never)
    expect(trigger.actor.id).toBe('u1')
    expect(trigger.meta.msgid).toBe('m1')
  })

  it('uses the group id as the thread of a group message', () => {
    expect(wecomThreadId(body({ chattype: 'group', chatid: 'g1' }) as never)).toBe('g1')
  })

  it('uses the user id as the thread of a direct message', () => {
    expect(wecomThreadId(body() as never)).toBe('u1')
  })
})
