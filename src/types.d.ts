/**
 * 外部插件用的类型补充。
 *
 * DSH 的服务（`ctx.orchestrator`、`ctx.sessionController`）由各自的插件在运行时提供，
 * 但它们的类型声明不在公开入口里，因此这里补充最小声明。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Trigger } from './sources/dsh-superagent-core.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** dsh-superagent 的编排服务；由 dsh-superagent 插件提供。 */
    orchestrator: {
      /** 取一个 Source 的上下文，用于投递 Trigger 和读配置。 */
      context(kind: { kind: string; health: readonly string[] }): {
        receive(trigger: Trigger): void | Promise<void>
        config<C extends Record<string, unknown>>(kind: string): C | undefined
        /** setup 完成后 resolve。 */
        ready: Promise<void>
        /** 上报本 Source 声明的健康条目。 */
        report(entry: string, health: { state: 'starting' | 'ready' | 'paused' | 'error'; detail: string }): void
      }
      /** Source kind 注册表。 */
      sources: { register(kind: unknown): () => void }
    }
    /** DSH 的会话控制器；由 dsh-api-session-controller 提供。 */
    sessionController: {
      readSessionState(sessionId: string): Promise<{ id: string; events: { type: string; seq: number; data?: unknown }[] }>
      rename(request: { sessionId: string; title: string }): Promise<{ ok: true; value: { title: string; seq: number } } | { ok: false; error: unknown }>
    }
  }

  interface Events {
    /** 一个会话追加了一个事件。 */
    'session/event': (session: { id: string }, event: { type: string; seq: number; data?: unknown }) => void
  }
}

export type { Context }
