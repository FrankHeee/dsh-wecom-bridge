/**
 * dsh-wecom-bridge 插件入口。
 *
 * 两部分：
 *   - `wecom-watch`：企业微信 Source（长连接收发消息）；
 *   - `title-refiner`：会话标题自动提炼。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { TitleRefinerConfigSchema, type TitleRefinerConfig } from './title-plugin.ts'

export { TitleRefinerConfigSchema, type TitleRefinerConfig }
export * from './title-refiner.ts'
export * from './wecom-protocol.ts'

export const name = 'dsh-wecom-bridge'
export const inject = ['settings']
export function apply(ctx: Context, config: TitleRefinerConfig): void {
  ctx.inject(['settings'], child => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
}
