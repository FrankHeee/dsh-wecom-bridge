/**
 * 企业微信 Source：长连接接收消息，转成领域 Trigger；回复走同一条长连接。
 *
 * 与飞书 Source 的差别只有一个：飞书用 `lark-cli` 读事件和发消息，
 * 企微用一条 WebSocket 长连接自己收发。
 */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from './dsh-superagent-core.ts'
import {
  eventType, extractText, isEvent, isMessage, isSubscribeAck, parseFrame, pingFrame, PING_INTERVAL_MS,
  reqId, respondFrame, stripMention, subscribeFrame, welcomeFrame, WS_URL,
  type Frame, type MessageBody,
} from '../wecom-protocol.ts'

export const SOURCE = 'wecom'

/** 配置：机器人的 BotID、Secret，以及接收哪些会话。 */
export const WeComConfigSchema = z.object({
  botId: z.string().trim().default(''),
  secret: z.string().trim().default(''),
  /** 单聊默认开启；群聊需要在 `chats` 里列出。 */
  directMessages: z.boolean().default(true),
  /** 群聊白名单；空表示不接收任何群消息。 */
  chats: z.array(z.object({
    chatId: z.string().trim(),
    name: z.string().trim().max(60).optional(),
  }).strict())
    .refine(chats => new Set(chats.map(chat => chat.chatId)).size === chats.length, 'Duplicate chat IDs')
    .default([]),
  /** 未列出的群是否接收 @机器人的消息。 */
  otherChats: z.enum(['none', 'mentions']).default('none'),
  /** 连接断开后的重连间隔（毫秒）。 */
  reconnectDelayMs: z.number().int().min(1000).max(60000).default(5000),
}).strict()
export type WeComConfig = z.infer<typeof WeComConfigSchema>

/** 确定性 Trigger ID：同一条消息永远得到同一个 ID。 */
export const wecomTriggerId = (msgid: string): string => key(SOURCE, msgid)

/** 群会话 ID 优先用 chatid；单聊用 userid。 */
export const wecomThreadId = (body: MessageBody): string =>
  body.chattype === 'group' ? (body.chatid ?? 'group') : (body.from?.userid ?? 'direct')

/** 构造回复地址：企微回复必须带上原消息的 req_id 和 msgid。 */
export const wecomChannel = (body: MessageBody): ChannelRef => ({
  source: SOURCE,
  thread: `wecom:${wecomThreadId(body)}`,
  address: {
    msgid: body.msgid,
    chatId: body.chatid ?? '',
    userid: body.from?.userid ?? '',
    chattype: body.chattype ?? 'single',
  },
})

/** 把一条消息变成 Trigger。 */
export function wecomTrigger(body: MessageBody): Trigger {
  const direct = body.chattype !== 'group'
  const text = stripMention(extractText(body))
  const thread = wecomThreadId(body)
  return {
    id: wecomTriggerId(body.msgid),
    source: SOURCE,
    threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: body.from?.userid ?? 'unknown' },
    human: true,
    ...(direct ? { addressed: 'direct' as const } : {}),
    at: new Date().toISOString(),
    text,
    channel: wecomChannel(body),
    meta: {
      chatId: body.chatid ?? '',
      userid: body.from?.userid ?? '',
      msgid: body.msgid,
      direct,
      chattype: body.chattype ?? 'single',
    },
  }
}

/** 这个会话是否被接收。 */
export function inScope(body: MessageBody, config: WeComConfig): boolean {
  if (body.chattype === 'group') {
    if (config.chats.some(chat => chat.chatId === body.chatid)) return true
    return config.otherChats === 'mentions'
  }
  return config.directMessages
}

/** 长连接客户端：订阅、收消息、发回复、维持心跳。 */
export class WeComClient {
  private socket?: import('ws').WebSocket
  private timer?: NodeJS.Timeout
  private closed = false
  /** 本次连接订阅帧的 req_id；回执按它对号入座，其他帧的 errcode 不算订阅结果。 */
  private subscribeReqId?: string
  /** 是否已收到订阅成功的回执；收到回执之前连接不算可用。 */
  private subscribeAcked = false
  /** msgid → 原始消息体；回复时要用它的 req_id 和 msgid。 */
  private readonly pending = new Map<string, { body: MessageBody; reqId: string }>()

  constructor(private readonly config: WeComConfig,
    private readonly onMessage: (body: MessageBody, reqId: string) => void,
    private readonly onEvent: (type: string, reqId: string) => void,
    private readonly log: (message: string) => void,
    private readonly onSubscribe?: (errcode: number, errmsg: string | undefined) => void) {}

  /** 是否已收到订阅成功的回执；健康状态以此为准。 */
  get subscribed(): boolean {
    return this.subscribeAcked
  }

  /** 建立连接并订阅。 */
  connect(): void {
    if (this.closed) return
    // 动态 import 让 ws 只在真正连接时加载，插件加载期不占用资源。
    void import('ws').then(({ default: WebSocket }) => {
      if (this.closed) return
      const socket = new WebSocket(WS_URL)
      this.socket = socket
      socket.on('open', () => {
        this.log('企业微信长连接已建立')
        this.subscribeAcked = false
        this.subscribeReqId = reqId('sub')
        try {
          this.send(subscribeFrame(this.config.botId, this.config.secret, this.subscribeReqId))
        } catch (error) {
          this.log(`订阅帧发送失败：${String(error)}`)
        }
        this.timer = setInterval(() => {
          // 心跳帧发不出去说明连接正在关闭，close 事件会负责重连，这里不抛。
          try { this.send(pingFrame()) } catch { /* 连接正在关闭 */ }
        }, PING_INTERVAL_MS)
      })
      socket.on('message', (raw: Buffer | string) => this.onRaw(raw.toString()))
      socket.on('close', () => {
        this.log('企业微信长连接已断开')
        this.subscribeAcked = false
        this.subscribeReqId = undefined
        this.clearTimer()
        if (!this.closed) setTimeout(() => this.connect(), this.config.reconnectDelayMs)
      })
      socket.on('error', (error: Error) => { this.log(`企业微信长连接出错：${error.message}`) })
    }).catch((error: unknown) => { this.log(`企业微信长连接无法启动：${String(error)}`) })
  }

  /** 关闭连接。 */
  close(): void {
    this.closed = true
    this.clearTimer()
    this.socket?.close()
  }

  /** 发送一帧；连接未就绪时抛错，绝不静默丢弃，让调用方知道没发出去。 */
  send(frame: Frame): void {
    if (this.socket?.readyState !== 1) throw new Error('企业微信长连接未就绪，帧未发送')
    this.socket.send(JSON.stringify(frame))
  }

  /** 回复一条消息：流式刷新同一条消息，最后 finish。连接未就绪时 send 的错会穿透出去。 */
  reply(msgid: string, content: string, finish = true): void {
    const entry = this.pending.get(msgid)
    if (!entry) return
    this.send(respondFrame(entry.reqId, `s-${msgid}`, content, finish))
  }

  /** 发送欢迎语；欢迎语只是尽力而为，连接刚断开时记日志而不是抛错。 */
  welcome(reqId: string, content: string): void {
    try {
      this.send(welcomeFrame(reqId, content))
    } catch (error) {
      this.log(`欢迎语发送失败：${String(error)}`)
    }
  }

  /** 取出一条消息的回复目标；测试和诊断用。 */
  target(msgid: string): { body: MessageBody; reqId: string } | undefined {
    return this.pending.get(msgid)
  }

  private clearTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private onRaw(raw: string): void {
    const frame = parseFrame(raw)
    if (!frame) return
    // 订阅回执：无 cmd、带 errcode、且 req_id 与本次订阅帧一致的才是订阅结果；
    // 健康状态以它为准，回执到达之前不算订阅成功。
    if (this.subscribeReqId !== undefined && frame.cmd === undefined
      && frame.headers?.req_id === this.subscribeReqId && typeof frame.errcode === 'number') {
      if (isSubscribeAck(frame)) {
        this.subscribeAcked = true
        this.onSubscribe?.(0, undefined)
      } else if (frame.errcode !== 0) {
        this.log(`企业微信订阅失败：errcode ${frame.errcode}${frame.errmsg ? `：${frame.errmsg}` : ''}`)
        this.onSubscribe?.(frame.errcode, frame.errmsg)
      }
      return
    }
    if (isMessage(frame)) {
      const body = frame.body as MessageBody | undefined
      const req = frame.headers?.req_id
      if (!body?.msgid || !req) return
      this.pending.set(body.msgid, { body, reqId: req })
      this.onMessage(body, req)
      return
    }
    if (isEvent(frame)) {
      const req = frame.headers?.req_id
      if (req) this.onEvent(eventType(frame), req)
    }
  }
}

/** 面板上的配置字段。 */
const fields = [
  { key: 'botId', type: 'text' as const, label: { zh: '机器人 BotID', en: 'Bot BotID' },
    hint: { zh: '企业微信智能机器人的 BotID；机器人的 API 模式必须选「长连接」。', en: 'The BotID of a WeCom smart robot whose API mode is the long connection.' } },
  { key: 'secret', type: 'text' as const, label: { zh: '机器人 Secret', en: 'Bot Secret' },
    hint: { zh: '长连接专用密钥，不是回调地址模式的 Token 或 EncodingAESKey。', en: 'The long-connection secret, not the callback Token or EncodingAESKey.' } },
  { key: 'directMessages', type: 'switch' as const, label: { zh: '接收私聊', en: 'Direct messages' } },
  { key: 'chats', type: 'rows' as const, label: { zh: '接收的群', en: 'Chats' },
    hint: { zh: '群聊的 chatid；企微没有群名查询接口，因此需要手填。', en: 'The chatid of a group; WeCom has no chat-name lookup, so it is entered by hand.' },
    columns: [
      { key: 'chatId', type: 'text' as const, label: { zh: 'chatid', en: 'chatid' } },
      { key: 'name', type: 'text' as const, label: { zh: '名字', en: 'Name' }, optional: true },
    ] },
  { key: 'otherChats', type: 'select' as const, label: { zh: '其他群', en: 'Other chats' },
    options: [{ value: 'none', label: { zh: '不接收', en: 'Not received' } }, { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }] },
  { key: 'reconnectDelayMs', type: 'number' as const, min: 1000, max: 60000, advanced: true,
    label: { zh: '重连间隔 / 毫秒', en: 'Reconnect delay / ms' } },
]

/** Source kind 的注册信息；superagent 在启动时读取它并在面板上生���配置卡片。 */
export const wecomKind = {
  kind: SOURCE,
  title: { zh: '企业微信', en: 'WeCom' },
  description: { zh: '通过长连接接收企业微信智能机器人的消息，并回到同一会话交付结果。', en: 'Receives messages of a WeCom smart robot over a long connection and delivers results back into the same conversation.' },
  schema: WeComConfigSchema,
  fields,
  health: ['wecom'],
  scope({ meta }: { meta: Record<string, unknown> }, config: WeComConfig) {
    const chatId = String(meta.chatId ?? '')
    const direct = meta.direct === true
    if (direct) return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
    const listed = config.chats.some(chat => chat.chatId === chatId)
    if (listed) return { listened: true, observed: false, row: chatId }
    return config.otherChats === 'mentions' ? { listened: true, observed: false, row: 'other' } : { listened: false, reason: 'chat_not_allowed' }
  },
  channel: {
    allowed(address: Record<string, string>, config: WeComConfig) {
      const body = { chattype: address.chattype === 'group' ? 'group' : 'single', chatid: address.chatId } as MessageBody
      return inScope(body, config)
    },
    /**
     * 回复走同一条长连接；消息体由 WeComClient 按 msgid 找回。
     * 回复目标已不存在时返回 'gone'；连接未就绪时 reply 抛错，
     * 由引擎按「这次没送达、可以重试」处理，绝不谎报 'sent'。
     */
    async send(_host: unknown, message: { channel: ChannelRef; text: string }): Promise<'sent' | 'gone'> {
      const client = currentClient
      if (!client) return 'gone'
      const msgid = message.channel.address.msgid
      if (!msgid) return 'gone'
      if (!client.target(msgid)) return 'gone'
      client.reply(msgid, message.text, true)
      return 'sent'
    },
    link(address: Record<string, string>) {
      const id = address.chattype === 'group' ? address.chatId : address.userid
      return { url: 'https://work.weixin.qq.com/', label: { zh: '企业微信会话', en: 'WeCom conversation' }, ...(id ? {} : {}) }
    },
  },
  find: (query: string) => ({ threads: [], terms: [...new Set(query.match(/om_[A-Za-z0-9_-]+/g) ?? [])] }),
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]+$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate user ids').default([]),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows' as const, label: { zh: '能发起工作的企业微信用户', en: 'WeCom users who may originate work' },
        columns: [{ key: 'id', type: 'text' as const, label: { zh: 'userid', en: 'userid' } },
          { key: 'name', type: 'text' as const, label: { zh: '名字', en: 'Name' }, optional: true }] },
    ],
    explicit: { zh: '名单内的人私聊机器���，总是明确的请求。', en: 'Someone on the list who messages the bot directly always makes an explicit request.' },
    rows(stored: Record<string, unknown>) {
      const config = WeComConfigSchema.parse(stored)
      const mentions = { zh: '仅 @', en: '@ only' }
      return [
        ...config.chats.map(chat => ({ id: chat.chatId, label: chat.name || chat.chatId, note: mentions,
          cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } })),
        { id: 'other', label: { zh: '其他群', en: 'Other chats' }, note: config.otherChats === 'mentions' ? mentions : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.otherChats === 'mentions', unlistedUnaddressed: false } },
        { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: config.directMessages ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages, unlistedUnaddressed: false } },
      ]
    },
  },
}

/** 当前的长连接客户端；回复适配器需要它把消息发回去。 */
let currentClient: WeComClient | undefined

export const name = 'dsh-wecom-watch'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(wecomKind as never), 'wecom: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const report = (detail: string): void => {
      try { ctx.orchestrator.context({ kind: SOURCE, health: ['wecom'] }).report('wecom', { state: 'error', detail }) }
      catch { /* 报告本身失败时忽略 */ }
    }
    report('启动中')
    const running = runWeCom(ctx, controller.signal).catch((error: unknown) => {
      report(`后台循环异常退出：${String(error)}`)
    })
    void running
    return () => { controller.abort() }
  })
}

/** 后台循环：连接、订阅、收消息、投递 Trigger。 */
async function runWeCom(ctx: Context, signal: AbortSignal): Promise<void> {
  const log = (message: string): void => { ctx.logger.warn('dsh-wecom: %s', message) }
  log('后台循环已启动')
  while (!signal.aborted) {
    const source = ctx.orchestrator.context({ kind: SOURCE, health: ['wecom'] })
    const config = source.config<WeComConfig>(SOURCE)
    if (!config || !config.botId || !config.secret) {
      source.report('wecom', { state: 'paused', detail: '机器人 BotID 或 Secret 未设置' })
      await delay(5000, undefined, { signal }).catch(() => {})
      continue
    }
    source.report('wecom', { state: 'starting', detail: '正在连接企业微信长连接' })
    await new Promise<void>((resolve) => {
      const client = new WeComClient(config,
        (body, req) => {
          if (!inScope(body, config)) return
          const trigger = wecomTrigger(body)
          void source.receive(trigger)
          void req
        },
        (type, req) => {
          if (type === 'enter_chat') client.welcome(req, '在的，直接说需求或问题就行。')
          if (type === 'disconnected_event') log('长连接被新连接踢下线，等待重连')
        },
        log,
        (errcode, errmsg) => {
          // 健康状态以订阅回执为准：errcode 0 才算 ready，非 0 明确报 error 并带上 errcode。
          if (errcode === 0) {
            source.report('wecom', { state: 'ready', detail: '企业微信长连接已建立' })
          } else {
            source.report('wecom', { state: 'error', detail: `企业微信订阅失败：errcode ${errcode}${errmsg ? `：${errmsg}` : ''}` })
          }
        })
      currentClient = client
      client.connect()
      signal.addEventListener('abort', () => { client.close(); resolve() }, { once: true })
    })
    await delay(1000, undefined, { signal }).catch(() => {})
  }
}

const delay = (ms: number, value?: unknown, options?: { signal?: AbortSignal }): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(value), ms)
    options?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
  })
