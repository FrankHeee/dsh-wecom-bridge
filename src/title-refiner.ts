/**
 * 会话标题提炼：从最近的消息里抽出一个主题标题，并清理模型思维链标签。
 *
 * 两条硬规则：
 *   1. 标题来源是 `user` 的会话（人在界面上手动改过标题）永不覆盖；
 *   2. 模型返回的 `<think>…</think>` 思维链不能进标题。
 */

/** 标题事件在会话日志里的形状。 */
export interface TitleEvent {
  type: string
  seq: number
  data?: { title?: string; source?: { kind?: string } }
}

/** `<think>` / `<thinking>` / `<reasoning>` 及其闭标签；未闭合的开标签会把后面全部吃掉。 */
const THINK_BLOCK = /<(think|thinking|reasoning|thought)>[\s\S]*?(?:<\/\1>|$)/gi
/** 其它常见的推理包装标签。 */
const OTHER_BLOCK = /<(reflection|scratchpad)>[\s\S]*?(?:<\/\1>|$)/gi
/** 行内标签，如 `<｜｜>` 之类的控制符。 */
const CONTROL_TAGS = /<[|｜][^|>]*[|｜]>/g

/**
 * 去掉模型输出里的思维链与控制标签，只留下可展示的正文。
 * 思维链常出现在标题请求的首行，不去掉就会变成 "<<think>We need output titl…"。
 */
export function stripReasoning(text: string): string {
  return text
    .replace(THINK_BLOCK, ' ')
    .replace(OTHER_BLOCK, ' ')
    .replace(CONTROL_TAGS, ' ')
    .replace(/<\/?[a-z][a-z0-9_-]*>/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/**
 * 从模型输出里取一行标题。
 * 取第一段非空行，剥掉思维链，剥掉常见的引号和前缀。
 */
export function titleFromOutput(text: string): string {
  const cleaned = stripReasoning(text)
  const line = cleaned.split(/\r?\n/).map(item => item.trim()).find(item => item.length > 0) ?? ''
  return line
    .replace(/^["'「『《【]+/, '')
    .replace(/["'」』》】]+$/, '')
    .replace(/^(标题|题目|title)\s*[:：]\s*/i, '')
    .trim()
}

/** 标题的最大字符数。 */
export const MAX_TITLE_CHARS = 32

/**
 * 把标题收敛到可展示的形态：单行、长度受限、去掉首尾空白。
 * 超过上限时按字符切，不切断代理对（surrogate pair）。
 */
export function normalizeTitle(title: string, maxChars = MAX_TITLE_CHARS): string {
  const single = title.replace(/\s+/g, ' ').trim()
  const chars = Array.from(single)
  return chars.length <= maxChars ? single : chars.slice(0, maxChars).join('').trimEnd()
}

/** 一个会话的标题状态。 */
export interface TitleState {
  /** 当前标题；没有标题事件时为空。 */
  title: string
  /** 当前标题的来源：`user` 表示人手动改过，`provider` 表示模型生成，`fallback` 表示首句截断。 */
  source: 'user' | 'provider' | 'fallback' | 'none'
}

/**
 * 折叠会话日志里的标题事件，得到最新标题及其来源。
 * 规则与 DSH 的 session-title 服务一致：后出现的事件覆盖先前的。
 */
export function foldTitle(events: readonly TitleEvent[]): TitleState {
  let title = ''
  let source: TitleState['source'] = 'none'
  for (const event of events) {
    if (event.type !== 'session/title') continue
    const kind = event.data?.source?.kind
    source = kind === 'user' ? 'user' : kind === 'provider' ? 'provider' : kind === 'fallback' ? 'fallback' : source
    const value = event.data?.title
    if (typeof value === 'string') title = value
  }
  return { title, source }
}

/**
 * 这个会话能不能被自动提炼改标题。
 * 人手动改过的标题（source 为 `user`）永远保留。
 */
export function mayRefine(state: TitleState): boolean {
  return state.source !== 'user'
}

/**
 * 判断一个标题是不是"被思维链污染的"。
 * 污染的标题需要立即修复，即使之后被人手动改过——人改名时通常会覆盖整个标题，
 * 但历史脏标题仍值得清理，因此这里只判断内容，不判断来源。
 */
export function isPolluted(title: string): boolean {
  return /<(think|thinking|reasoning|thought|reflection|scratchpad)>/i.test(title)
}

/** 提炼的触发条件。 */
export interface RefineTrigger {
  /** 自上次提炼以来新增的人消息数。 */
  messages: number
  /** 达到多少条消息就提炼。 */
  every: number
  /** 距上次提炼至少间隔多少毫秒。 */
  sinceMs: number
}

/** 是否该提炼：消息数够了，且距上次也够久（两者取先到者）。 */
export function shouldRefine(trigger: RefineTrigger, now: number, lastRefinedAt: number): boolean {
  if (trigger.messages < trigger.every) return false
  if (lastRefinedAt === 0) return true
  return now - lastRefinedAt >= trigger.sinceMs
}

/**
 * 构造提炼请求的提示词。
 * 只把最近的若干条消息交给模型，让它给出一个主题标题。
 */
export function refinePrompt(messages: readonly { role: string; text: string }[], maxChars = MAX_TITLE_CHARS): string {
  const transcript = messages
    .slice(-20)
    .map(item => `${item.role === 'user' ? '用户' : '助手'}: ${item.text.slice(0, 500)}`)
    .join('\n')
  return [
    '根据下面的对话，用一句不超过 ' + maxChars + ' 个字的中文短语概括这段对话的主题。',
    '要求：直接输出短语本身，不要引号，不要前缀（如"标题："），不要解释，不要标点结尾。',
    '只反映对话正在讨论的实质内容，不要写"闲聊""帮助用户"这类空泛的说法。',
    '',
    transcript,
  ].join('\n')
}

/**
 * 从模型输出里取出可用的标题；不可用时返回 undefined。
 */
export function refineResult(output: string, maxChars = MAX_TITLE_CHARS): string | undefined {
  const title = normalizeTitle(titleFromOutput(output), maxChars)
  return title.length > 0 ? title : undefined
}
