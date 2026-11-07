/**
 * 会话标题提炼插件：定期把会话标题更新成一个概括主题的短语。
 *
 * 触发条件由配置决定（消息条数与时间间隔取先到者）。两条硬规则：
 *   - 人手动改过的标题（来源为 `user`）永不覆盖；
 *   - 标题里不能出现模型的思维链标签。
 */
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import {
  foldTitle, isPolluted, mayRefine, MAX_TITLE_CHARS, normalizeTitle, refinePrompt, refineResult,
  shouldRefine, stripReasoning, titleFromOutput, type TitleEvent,
} from './title-refiner.ts'

/** 插件配置。 */
export const TitleRefinerConfigSchema = z.object({
  /** 提炼用的模型路由；留空则用会话自己的模型。 */
  provider: z.string().trim().default(''),
  model: z.string().trim().default(''),
  /** 每累计多少条人消息提炼一次。 */
  everyMessages: z.number().int().min(1).max(200).default(8),
  /** 两次提炼之间的最小间隔（毫秒）。 */
  minIntervalMs: z.number().int().min(0).max(24 * 3600_000).default(30 * 60_000),
  /** 标题最大字符数。 */
  maxChars: z.number().int().min(6).max(64).default(MAX_TITLE_CHARS),
  /** 是否启用。 */
  enabled: z.boolean().default(true),
}).strict()
export type TitleRefinerConfig = z.infer<typeof TitleRefinerConfigSchema>

/** 一次会话的状态。 */
interface SessionState {
  /** 自上次提炼以来新增的人消息数。 */
  messages: number
  /** 上次提炼的时间戳；0 表示还没有提炼过。 */
  lastRefinedAt: number
  /** 正在提炼，避免并发。 */
  busy: boolean
}

/** 从会话日志里取出最近的人消息文本。 */
function recentUserMessages(events: readonly TitleEvent[]): { role: string; text: string }[] {
  const messages: { role: string; text: string }[] = []
  for (const event of events) {
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    const data = event.data as { message?: { role?: string; content?: { type: string; text?: string }[] } } | undefined
    const role = data?.message?.role ?? (event.type === 'user/message' ? 'user' : 'assistant')
    const text = (data?.message?.content ?? []).map(block => block.text ?? '').join('').trim()
    if (text.length > 0) messages.push({ role, text })
  }
  return messages.slice(-20)
}

/** 取会话里第一条人消息的文本。 */
function firstMessageText(events: readonly TitleEvent[]): string | undefined {
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const data = event.data as { message?: { content?: { type: string; text?: string }[] } } | undefined
    const text = (data?.message?.content ?? []).map(block => block.text ?? '').join('').trim()
    if (text.length > 0) return text
  }
  return undefined
}

/** 会话日志事件的最小形状。 */
interface LoggedEvent extends TitleEvent {
  data?: { title?: string; source?: { kind?: string }; message?: { role?: string; content?: { type: string; text?: string }[] } }
}

export const name = 'dsh-wecom-title-refiner'
export const inject = ['sessionController', 'llm']
export function apply(ctx: Context, config: TitleRefinerConfig): void {
  const resolved = TitleRefinerConfigSchema.parse(config ?? {})
  const states = new Map<string, SessionState>()
  const stateOf = (id: string): SessionState => {
    let state = states.get(id)
    if (!state) { state = { messages: 0, lastRefinedAt: 0, busy: false }; states.set(id, state) }
    return state
  }

  ctx.effect(() => {
    const dispose = ctx.on('session/event', (session, event) => {
      if (!resolved.enabled) return
      const state = stateOf(session.id)
      if (event.type === 'user/message') {
        state.messages += 1
        void maybeRefine(session.id, event.seq)
        return
      }
      if (event.type === 'session/title') {
        // 人手动改名：记下这个事实，之后不再自动覆盖。
        const source = (event.data as { source?: { kind?: string } } | undefined)?.source?.kind
        if (source === 'user') state.lastRefinedAt = Date.now()
        return
      }
    })
    return dispose
  }, 'dsh-wecom: title refiner')

  /** 到点就提炼。 */
  async function maybeRefine(sessionId: string, seq: number): Promise<void> {
    const state = stateOf(sessionId)
    if (state.busy) return
    if (!shouldRefine({ messages: state.messages, every: resolved.everyMessages, sinceMs: resolved.minIntervalMs }, Date.now(), state.lastRefinedAt)) return
    state.busy = true
    try {
      const state2 = await ctx.sessionController.readSessionState(sessionId)
      const events = (state2.events ?? []) as unknown as LoggedEvent[]
      const titleState = foldTitle(events)
      // 人手动改过标题的会话不动。
      if (!mayRefine(titleState)) { state.lastRefinedAt = Date.now(); state.messages = 0; return }
      // 标题里混进了模型的思维链：先用首句消息修好，再继续。
      if (isPolluted(titleState.title)) {
        const first = firstMessageText(events)
        if (first) {
          const repaired = normalizeTitle(first.replace(/^headless\s+/i, '').slice(0, resolved.maxChars), resolved.maxChars)
          await ctx.sessionController.rename({ sessionId, title: repaired })
          ctx.logger.warn('dsh-wecom: 修好了被思维链污染的标题「%s」', repaired)
        }
      }
      const messages = recentUserMessages(events)
      if (messages.length === 0) return
      const output = await askModel(messages)
      const refined = refineResult(output, resolved.maxChars)
      if (!refined) return
      /** 提炼前后再确认一次标题来源，避免提炼期间人改了名字。 */
      const latest = await ctx.sessionController.readSessionState(sessionId)
      const latestState = foldTitle((latest.events ?? []) as unknown as LoggedEvent[])
      if (!mayRefine(latestState)) return
      await ctx.sessionController.rename({ sessionId, title: refined })
      ctx.logger.info('dsh-wecom: 标题已提炼为「%s」', refined)
    } catch (error) {
      ctx.logger.warn('dsh-wecom: 标题提炼失败：%s', String(error))
    } finally {
      state.busy = false
      state.messages = 0
      state.lastRefinedAt = Date.now()
    }
  }

  /** 调模型生成标题。 */
  async function askModel(messages: { role: string; text: string }[]): Promise<string> {
    const prompt = refinePrompt(messages, resolved.maxChars)
    const route = resolved.provider && resolved.model
      ? { provider: resolved.provider, model: resolved.model }
      : undefined
    const assembler = new BlockAssembler()
    const options = {
      provider: route?.provider ?? 'deepseek-account',
      model: route?.model ?? 'deepseek-flash',
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: prompt }] }],
    }
    for await (const chunk of ctx.llm.stream(options)) {
      assembler.push(chunk)
    }
    const blocks = assembler.blocks()
    return blocks.filter(block => block.type === 'text').map(block => (block as { text?: string }).text ?? '').join('')
  }

  void stripReasoning
  void titleFromOutput
  void normalizeTitle
  void isPolluted
}
