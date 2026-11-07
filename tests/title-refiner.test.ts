import { describe, expect, it } from 'vitest'
import {
  foldTitle, isPolluted, mayRefine, normalizeTitle, refinePrompt, refineResult, shouldRefine,
  stripReasoning, titleFromOutput, type TitleEvent,
} from '../src/title-refiner.ts'

describe('stripReasoning', () => {
  it('removes a closed think block', () => {
    expect(stripReasoning('<think>We need output title one line</think>')).toBe('')
  })

  it('removes an unclosed think block and everything after it', () => {
    expect(stripReasoning('<think>reasoning that never ends\nmore text')).toBe('')
  })

  it('keeps the text after a closed think block', () => {
    expect(stripReasoning('<think>hidden</think>可见标题')).toBe('可见标题')
  })

  it('removes several blocks', () => {
    expect(stripReasoning('<think>a</think>中间<think>b</think>结尾')).toBe('中间 结尾')
  })

  it('removes control tags', () => {
    expect(stripReasoning('标题<｜tool▁begin｜>x')).toBe('标题 x')
  })
})

describe('titleFromOutput', () => {
  it('takes the first non-empty line', () => {
    expect(titleFromOutput('第一行\n第二行')).toBe('第一行')
  })

  it('strips reasoning before taking the line', () => {
    expect(titleFromOutput('<think>We need output title</think>\n企业微信桥接')).toBe('企业微信桥接')
  })

  it('removes quotes and labels', () => {
    expect(titleFromOutput('"标题：企微集成"')).toBe('企微集成')
  })
})

describe('normalizeTitle', () => {
  it('collapses whitespace', () => {
    expect(normalizeTitle('  a   b  ')).toBe('a b')
  })

  it('truncates by characters', () => {
    expect(normalizeTitle('一二三四五六', 3)).toBe('一二三')
  })

  it('does not split a surrogate pair', () => {
    const emoji = '😀'.repeat(5)
    const result = normalizeTitle(emoji, 3)
    expect(Array.from(result).length).toBeLessThanOrEqual(3)
    expect(result.includes('\uFFFD')).toBe(false)
  })
})

describe('foldTitle', () => {
  const event = (title: string, kind: string): TitleEvent => ({
    type: 'session/title', seq: 1, data: { title, source: { kind } },
  })

  it('reports a user title', () => {
    expect(foldTitle([event('fallback', 'fallback'), event('手动标题', 'user')])).toEqual({ title: '手动标题', source: 'user' })
  })

  it('reports a provider title', () => {
    expect(foldTitle([event('fallback', 'fallback'), event('模型标题', 'provider')]).source).toBe('provider')
  })

  it('reports no title for an empty log', () => {
    expect(foldTitle([])).toEqual({ title: '', source: 'none' })
  })
})

describe('mayRefine', () => {
  it('refuses to touch a user title', () => {
    expect(mayRefine({ title: 'x', source: 'user' })).toBe(false)
  })

  it('allows refining a provider or fallback title', () => {
    expect(mayRefine({ title: 'x', source: 'provider' })).toBe(true)
    expect(mayRefine({ title: 'x', source: 'fallback' })).toBe(true)
  })
})

describe('isPolluted', () => {
  it('detects a think tag', () => {
    expect(isPolluted('<think>We need output')).toBe(true)
  })

  it('accepts a clean title', () => {
    expect(isPolluted('企业微信桥接')).toBe(false)
  })
})

describe('shouldRefine', () => {
  const trigger = { messages: 8, every: 8, sinceMs: 1_800_000 }

  it('fires when the message count is reached and nothing was refined before', () => {
    expect(shouldRefine(trigger, 1_000, 0)).toBe(true)
  })

  it('waits for the interval after a refinement', () => {
    expect(shouldRefine(trigger, 1_000, 900)).toBe(false)
  })

  it('fires once both conditions hold', () => {
    expect(shouldRefine(trigger, 2_000_000, 1_000)).toBe(true)
  })

  it('waits for the message count', () => {
    expect(shouldRefine({ ...trigger, messages: 3 }, 2_000_000, 1_000)).toBe(false)
  })
})

describe('refinePrompt', () => {
  it('includes the transcript and asks for a short title', () => {
    const prompt = refinePrompt([{ role: 'user', text: '帮我写个脚本' }, { role: 'assistant', text: '好的' }])
    expect(prompt).toContain('帮我写个脚本')
    expect(prompt).toContain('好的')
    expect(prompt).toContain('不要引号')
  })

  it('keeps only the last messages', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({ role: 'user', text: `消息${index}` }))
    const prompt = refinePrompt(many)
    expect(prompt).toContain('消息39')
    expect(prompt).not.toContain('消息0\n')
  })
})

describe('refineResult', () => {
  it('returns a clean title', () => {
    expect(refineResult('<think>thinking</think>\n企业微信桥接')).toBe('企业微信桥接')
  })

  it('returns undefined for empty output', () => {
    expect(refineResult('<think>only reasoning</think>')).toBeUndefined()
  })
})
