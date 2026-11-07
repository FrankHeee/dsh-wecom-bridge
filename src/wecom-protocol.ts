/**
 * 企业微信智能机器人长连接协议：帧格式、消息解析、回复构造。
 *
 * 协议见 https://developer.work.weixin.qq.com/document/path/101463
 * 长连接不需要公网回调地址、不需要 EncodingAESKey，消息是明文。
 */
import { z } from 'zod'

/** 长连接网关地址。 */
export const WS_URL = 'wss://openws.work.weixin.qq.com'
/** 建议心跳间隔；服务端会断开没有心跳的连接。 */
export const PING_INTERVAL_MS = 30_000

/** 一帧请求/响应的公共形状。 */
const FrameSchema = z.looseObject({
  cmd: z.string().optional(),
  headers: z.looseObject({ req_id: z.string().optional() }).optional(),
  errcode: z.number().optional(),
  errmsg: z.string().optional(),
  body: z.unknown().optional(),
})
export type Frame = z.infer<typeof FrameSchema>

/** 消息回调体；企微把文本放在 `text.content`，多模态放在 `mixed.msg_item`。 */
export const MessageBodySchema = z.looseObject({
  msgid: z.string(),
  aibotid: z.string().optional(),
  chatid: z.string().optional(),
  chattype: z.enum(['single', 'group']).optional(),
  from: z.looseObject({ userid: z.string().optional() }).optional(),
  msgtype: z.string(),
  text: z.looseObject({ content: z.string().optional() }).optional(),
  mixed: z.looseObject({
    msg_item: z.array(z.looseObject({
      msgtype: z.string().optional(),
      text: z.looseObject({ content: z.string().optional() }).optional(),
    })).optional(),
  }).optional(),
  voice: z.looseObject({ content: z.string().optional() }).optional(),
})
export type MessageBody = z.infer<typeof MessageBodySchema>

/** 事件回调体；`enter_chat` 是用户当天首次进入单聊会话。 */
export const EventBodySchema = z.looseObject({
  event: z.looseObject({ eventtype: z.string().optional() }).optional(),
})
export type EventBody = z.infer<typeof EventBodySchema>

/** 从一帧里取出文本内容；非文本消息返回空字符串。 */
export function extractText(body: MessageBody): string {
  if (body.msgtype === 'text') return body.text?.content ?? ''
  if (body.msgtype === 'mixed') {
    return (body.mixed?.msg_item ?? [])
      .map(item => (item.msgtype === 'text' ? item.text?.content ?? '' : '[附件]'))
      .join('\n')
  }
  if (body.msgtype === 'voice') return body.voice?.content ?? ''
  return ''
}

/**
 * 去掉文本里 @机器人的前缀。企微把 `@BotName` 直接写进文本内容，
 * 群聊里不剥掉会让模型把机器人名字当成用户需求的一部分。
 */
export function stripMention(text: string): string {
  return text.replace(/@\S+\s*/g, '').trim()
}

/** 生成一个请求 id；企微用它把响应关联回请求。 */
export function reqId(prefix = 'dsh'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** 订阅帧：连接建立后必须先订阅，否则收不到消息。 */
export const subscribeFrame = (botId: string, secret: string, id = reqId('sub')): Frame => ({
  cmd: 'aibot_subscribe',
  headers: { req_id: id },
  body: { bot_id: botId, secret },
})

/** 心跳帧。 */
export const pingFrame = (id = reqId('ping')): Frame => ({ cmd: 'ping', headers: { req_id: id } })

/** 流式回复帧；`finish` 结束流，企微最多允许刷新 10 分钟。 */
export const respondFrame = (reqId: string, streamId: string, content: string, finish = true): Frame => ({
  cmd: 'aibot_respond_msg',
  headers: { req_id: reqId },
  body: { msgtype: 'stream', stream: { id: streamId, finish, content } },
})

/** 欢迎语帧；只对 `enter_chat` 事件有效，5 秒内必须发出。 */
export const welcomeFrame = (reqId: string, content: string): Frame => ({
  cmd: 'aibot_respond_welcome_msg',
  headers: { req_id: reqId },
  body: { msgtype: 'text', text: { content } },
})

/** 主动推送帧；`chatType` 1 为单聊、2 为群聊。 */
export const pushFrame = (chatId: string, content: string, chatType: 1 | 2 = 1, id = reqId('push')): Frame => ({
  cmd: 'aibot_send_msg',
  headers: { req_id: id },
  body: { chatid: chatId, chat_type: chatType, msgtype: 'markdown', markdown: { content } },
})

/** 解析一帧；无法解析返回 undefined，而不是抛出。 */
export function parseFrame(raw: string): Frame | undefined {
  try {
    const parsed = FrameSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/** 判断一帧是否是消息回调。 */
export function isMessage(frame: Frame): boolean {
  return frame.cmd === 'aibot_msg_callback'
}

/** 判断一帧是否是事件回调。 */
export function isEvent(frame: Frame): boolean {
  return frame.cmd === 'aibot_event_callback'
}

/** 判断一帧是不是订阅成功的响应。 */
export function isSubscribeAck(frame: Frame): boolean {
  return frame.cmd === undefined && frame.errcode === 0 && frame.headers?.req_id !== undefined
}

/** 事件类型。 */
export type EventType = 'enter_chat' | 'disconnected_event' | 'template_card_event' | 'feedback_event' | 'other'

/** 取出事件类型。 */
export function eventType(frame: Frame): EventType {
  const parsed = EventBodySchema.safeParse(frame.body)
  const type = parsed.success ? parsed.data.event?.eventtype : undefined
  if (type === 'enter_chat' || type === 'disconnected_event' || type === 'template_card_event' || type === 'feedback_event') return type
  return 'other'
}
