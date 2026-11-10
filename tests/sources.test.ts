import { describe, expect, it, vi } from 'vitest'
import { inScope, wecomKind, wecomThreadId, wecomTrigger, WeComClient, WeComConfigSchema } from '../src/sources/wecom.ts'
import { pingFrame } from '../src/wecom-protocol.ts'

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

/** 可控的假 socket：手动设 readyState，记录发出的帧。 */
const fakeSocket = (readyState = 1) => ({ readyState, send: vi.fn(), close: vi.fn() })
type FakeSocket = ReturnType<typeof fakeSocket>

const attach = (client: WeComClient, socket: FakeSocket): void => {
  (client as unknown as { socket: unknown }).socket = socket
}

const deliver = (client: WeComClient, frame: unknown): void => {
  (client as unknown as { onRaw: (raw: string) => void }).onRaw(JSON.stringify(frame))
}

const noop = (): void => {}

describe('WeComClient.send', () => {
  it('throws when there is no socket', () => {
    const client = new WeComClient(config, noop, noop, noop)
    expect(() => client.send(pingFrame('p1'))).toThrow()
  })

  it('throws when the socket is not open', () => {
    const client = new WeComClient(config, noop, noop, noop)
    attach(client, fakeSocket(3))
    expect(() => client.send(pingFrame('p1'))).toThrow()
  })

  it('writes the frame as JSON to an open socket', () => {
    const client = new WeComClient(config, noop, noop, noop)
    const socket = fakeSocket(1)
    attach(client, socket)
    client.send(pingFrame('p1'))
    expect(socket.send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(socket.send.mock.calls[0]![0] as string).cmd).toBe('ping')
  })
})

describe('WeComClient.reply', () => {
  const messageFrame = {
    cmd: 'aibot_msg_callback', headers: { req_id: 'r1' },
    body: { msgid: 'm1', msgtype: 'text', chattype: 'single', from: { userid: 'u1' }, text: { content: '你好' } },
  }

  const connectedClient = () => {
    const onMessage = vi.fn()
    const client = new WeComClient(config, onMessage, noop, noop)
    const socket = fakeSocket(1)
    attach(client, socket)
    deliver(client, messageFrame)
    return { client, socket, onMessage }
  }

  it('delivers an incoming message to onMessage and keeps its reply target', () => {
    const { client, onMessage } = connectedClient()
    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(client.target('m1')?.reqId).toBe('r1')
  })

  it('writes a respond frame for a known msgid', () => {
    const { client, socket } = connectedClient()
    client.reply('m1', '结果')
    const sent = JSON.parse(socket.send.mock.calls[0]![0] as string)
    expect(sent.cmd).toBe('aibot_respond_msg')
    expect(sent.headers.req_id).toBe('r1')
    expect(sent.body.stream.content).toBe('结果')
  })

  it('throws instead of pretending to send when the socket dropped', () => {
    const { client, socket } = connectedClient()
    socket.readyState = 3
    expect(() => client.reply('m1', '结果')).toThrow()
    expect(socket.send).not.toHaveBeenCalled()
  })

  it('writes nothing for an unknown msgid', () => {
    const { client, socket } = connectedClient()
    client.reply('nope', '结果')
    expect(socket.send).not.toHaveBeenCalled()
  })
})

describe('WeComClient subscribe acknowledgement', () => {
  const setup = () => {
    const onSubscribe = vi.fn()
    const log = vi.fn()
    const client = new WeComClient(config, noop, noop, log, onSubscribe)
    ;(client as unknown as { subscribeReqId?: string }).subscribeReqId = 'sub-1'
    return { client, onSubscribe, log }
  }

  it('reports no subscription result before the ack arrives', () => {
    const { client, onSubscribe } = setup()
    deliver(client, {
      cmd: 'aibot_msg_callback', headers: { req_id: 'r9' },
      body: { msgid: 'm9', msgtype: 'text', chattype: 'single', from: { userid: 'u1' }, text: { content: 'hi' } },
    })
    expect(onSubscribe).not.toHaveBeenCalled()
    expect(client.subscribed).toBe(false)
  })

  it('reports success on an errcode 0 ack for the subscribe request', () => {
    const { client, onSubscribe } = setup()
    deliver(client, { headers: { req_id: 'sub-1' }, errcode: 0 })
    expect(onSubscribe).toHaveBeenCalledWith(0, undefined)
    expect(client.subscribed).toBe(true)
  })

  it('reports failure with the errcode on a nonzero ack and logs it', () => {
    const { client, onSubscribe, log } = setup()
    deliver(client, { headers: { req_id: 'sub-1' }, errcode: 40001, errmsg: 'invalid secret' })
    expect(onSubscribe).toHaveBeenCalledWith(40001, 'invalid secret')
    expect(client.subscribed).toBe(false)
    expect(log.mock.calls.some(([message]) => String(message).includes('40001'))).toBe(true)
  })

  it('ignores acks that belong to another request', () => {
    const { client, onSubscribe } = setup()
    deliver(client, { headers: { req_id: 'resp-1' }, errcode: 0 })
    expect(onSubscribe).not.toHaveBeenCalled()
    expect(client.subscribed).toBe(false)
  })
})

describe('wecomKind.channel', () => {
  it('reports gone when no client is connected', async () => {
    await expect(wecomKind.channel.send(undefined, {
      channel: { source: 'wecom', thread: 'wecom:u1', address: { msgid: 'm1' } },
      text: '结果',
    })).resolves.toBe('gone')
  })
})
