/* eslint-disable regexp/no-misleading-capturing-group, regexp/no-super-linear-backtracking */
import type { DecorationRenderOptions, Range } from 'vscode'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { window } from 'vscode'
import { compileConfig, createExcludeFilter, getRulesForLanguage, normalizeStyle } from '../src/config'
import { DecorationManager } from '../src/decorations'
import { compilePattern, isRegexSafe, normalizeFlags, safeMatchAll } from '../src/regex'
import { isRegexExecutionAbortedError, RegexExecutor } from '../src/regex-worker'
import { LatestTaskScheduler } from '../src/scheduler'

class MockEditor {
  public setDecorations = vi.fn()
}

function range(start: number, end: number): Range {
  return { start: { line: 0, character: start }, end: { line: 0, character: end } } as Range
}

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('regex configuration', () => {
  it('normalizes flags and accepts JavaScript assertions and named groups', () => {
    expect(normalizeFlags('m')).toBe('mgd')
    expect(normalizeFlags('dg')).toBe('dg')
    expect(() => normalizeFlags('z')).toThrow('Invalid regular expression flags: z')
    expect(() => compilePattern(['(?=foo)', 'm'])).not.toThrow()
    expect(() => compilePattern(['(?<=foo)\\w+', 'm'])).not.toThrow()
    expect(() => compilePattern(['(?<name>foo)', 'm'])).not.toThrow()
  })

  it('warns about nested quantifiers without rejecting valid syntax', () => {
    const nestedPlus = '(a+)+$'
    expect(isRegexSafe(new RegExp(nestedPlus))).toBe(false)
    expect(isRegexSafe(/(?!test)/)).toBe(true)
    expect(() => compilePattern([nestedPlus, 'm'])).not.toThrow()

    const compiled = compileConfig({ vue: { light: { red: [nestedPlus], blue: ['(ab{2})+'] } } })
    expect(getRulesForLanguage(compiled, 'vue', false)).toHaveLength(2)
    expect(compiled.warnings).toContain(`Potentially expensive regular expression for vue.light.red: ${nestedPlus}`)
  })

  it('supports pattern strings, tuples, arrays, and the legacy README shorthand', () => {
    const compiled = compileConfig({
      vue: {
        light: {
          red: { match: 'foo' },
          blue: { match: [['bar', 'gi']] },
          green: { match: [['baz', 'm'], 'qux'] },
          legacy: ['[0-9]+', 'gi'],
        },
      },
    })
    expect(getRulesForLanguage(compiled, 'vue', false).map(rule => rule.pattern)).toEqual([
      { source: 'foo', flags: 'gmd' },
      { source: 'bar', flags: 'gid' },
      { source: 'baz', flags: 'mgd' },
      { source: 'qux', flags: 'gmd' },
      { source: '[0-9]+', flags: 'gid' },
    ])
    expect(compiled.warnings).toContainEqual(expect.stringContaining('Legacy pattern tuple for vue.light.legacy'))
  })

  it('keeps explicit match arrays unambiguous', () => {
    const compiled = compileConfig({ vue: { light: { red: { match: ['foo', 'gm'] } } } })
    expect(getRulesForLanguage(compiled, 'vue', false).map(rule => rule.pattern.source)).toEqual(['foo', 'gm'])
  })

  it('survives malformed colors and matchCss while compiling valid siblings', () => {
    const compiled = compileConfig({
      vue: {
        light: {
          red: { match: ['foo'], colors: 'red' },
          blue: { match: ['bar'], matchCss: {} },
          green: { match: ['baz'], colors: [null] },
          orange: { match: ['qux'], matchCss: ['invalid'] },
          black: { match: ['ok'] },
        },
      },
    })
    expect(getRulesForLanguage(compiled, 'vue', false).map(rule => rule.pattern.source)).toEqual(['ok'])
    expect(compiled.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Invalid colors for vue.light.red'),
      expect.stringContaining('Invalid matchCss for vue.light.blue'),
      expect.stringContaining('Invalid colors entries for vue.light.green'),
      expect.stringContaining('Invalid matchCss entries for vue.light.orange'),
    ]))
  })

  it('normalizes styles, empty excludes, and rule-local ignores', () => {
    const source = { background: 'red', textDecoration: 'underline' }
    expect(normalizeStyle(source)).toEqual({ backgroundColor: 'red', textDecoration: 'underline' })
    expect(source).toEqual({ background: 'red', textDecoration: 'underline' })
    expect(createExcludeFilter([])('/workspace/src/example.ts')).toBe(true)
    expect(createExcludeFilter(['**/dist/**'])('/workspace/dist/example.js')).toBe(false)

    const compiled = compileConfig({ vue: { light: {
      red: { match: ['foo'], ignoreReg: ['bar'] },
      blue: { match: ['bar'] },
    } } })
    const rules = getRulesForLanguage(compiled, 'vue', false)
    expect(rules[0].ignores).toHaveLength(1)
    expect(rules[1].ignores).toHaveLength(0)
  })
})

describe('regex execution', () => {
  it('advances Unicode zero-width matches by code point', async () => {
    const synchronous = safeMatchAll('😀a', /(?=.)/dgu)
    expect(synchronous.map(match => match.index)).toEqual([0, 2])

    const executor = new RegexExecutor(500)
    await expect(executor.execute({
      ignores: [],
      maxMatches: 10,
      pattern: { source: '(?=.)', flags: 'gdu' },
      targetGroups: [0],
      text: '😀a',
    })).resolves.toEqual([{ spans: [[0, 0]] }, { spans: [[2, 2]] }])
    executor.dispose()
  })

  it('uses engine-provided indices for captures and local ignores', async () => {
    const executor = new RegexExecutor(500)
    await expect(executor.execute({
      ignores: [],
      maxMatches: 10,
      pattern: { source: '(a)(a)', flags: 'gd' },
      targetGroups: [1, 2],
      text: 'aa',
    })).resolves.toEqual([{ spans: [[0, 1], [1, 2]] }])
    await expect(executor.execute({
      ignores: [],
      maxMatches: 10,
      pattern: { source: '(a)?(b)', flags: 'gd' },
      targetGroups: [1, 2],
      text: 'b',
    })).resolves.toEqual([{ spans: [undefined, [0, 1]] }])
    await expect(executor.execute({
      ignores: [],
      maxMatches: 10,
      pattern: { source: '(?<=foo)(bar)', flags: 'gd' },
      targetGroups: [1],
      text: 'foobar',
    })).resolves.toEqual([{ spans: [[3, 6]] }])
    await expect(executor.execute({
      ignores: [{ source: 'foo', flags: 'gd' }],
      maxMatches: 10,
      pattern: { source: 'foo', flags: 'gd' },
      targetGroups: [0],
      text: 'foo',
    })).resolves.toEqual([])
    executor.dispose()
  })

  it('preserves the first participating capture by default', async () => {
    const executor = new RegexExecutor(500)
    await expect(executor.execute({
      ignores: [],
      maxMatches: 10,
      pattern: { source: '(foo)?(bar)', flags: 'gd' },
      targetGroups: [undefined],
      text: 'bar',
    })).resolves.toEqual([{ spans: [[0, 3]] }])
    executor.dispose()
  })

  it('terminates catastrophic work and recovers', async () => {
    const executor = new RegexExecutor(250)
    await expect(executor.execute({
      ignores: [],
      maxMatches: 10,
      pattern: { source: '(a+)+$', flags: 'gd' },
      targetGroups: [0],
      text: `${'a'.repeat(20_000)}b`,
    })).rejects.toThrow(/exceeded 250ms/)
    await expect(executor.execute({
      ignores: [],
      maxMatches: 10,
      pattern: { source: 'a+', flags: 'gd' },
      targetGroups: [0],
      text: 'baaa',
    })).resolves.toEqual([{ spans: [[1, 4]] }])
    executor.dispose()
  })

  it('removes cancelled queued work and aborts active work', async () => {
    const executor = new RegexExecutor(1_000)
    const slow = { ignores: [], maxMatches: 10, pattern: { source: '(a+)+$', flags: 'gd' }, targetGroups: [0], text: `${'a'.repeat(20_000)}b` }
    const activeController = new AbortController()
    const queuedController = new AbortController()
    const active = executor.execute(slow, activeController.signal)
    const queued = executor.execute({ ...slow, text: 'queued' }, queuedController.signal)
    expect(executor.pendingCount).toBe(2)
    queuedController.abort()
    await expect(queued).rejects.toSatisfy(isRegexExecutionAbortedError)
    expect(executor.pendingCount).toBe(1)
    activeController.abort()
    await expect(active).rejects.toSatisfy(isRegexExecutionAbortedError)
    expect(executor.pendingCount).toBe(0)
    executor.dispose()
  })
})

describe('latest task scheduler', () => {
  it('keeps one active task, invalidates immediately, and removes stale keys', async () => {
    vi.useFakeTimers()
    const releases: Array<() => void> = []
    const applied: number[] = []
    let active = 0
    let maximumActive = 0
    const scheduler = new LatestTaskScheduler<string>(async (_key, task) => {
      active++
      maximumActive = Math.max(maximumActive, active)
      await new Promise<void>(resolve => releases.push(resolve))
      if (task.isCurrent())
        applied.push(task.generation)
      active--
    }, 100)

    scheduler.schedule('editor', true)
    await Promise.resolve()
    expect(releases).toHaveLength(1)
    for (let index = 0; index < 100; index++)
      scheduler.schedule('editor')
    expect(scheduler.size).toBe(1)
    expect(maximumActive).toBe(1)
    releases.shift()!()
    await Promise.resolve()
    await vi.runAllTimersAsync()
    await Promise.resolve()
    expect(releases).toHaveLength(1)
    releases.shift()!()
    await Promise.resolve()
    expect(applied).toHaveLength(1)
    expect(maximumActive).toBe(1)

    scheduler.remove('editor')
    expect(scheduler.size).toBe(0)
    scheduler.dispose()
    vi.useRealTimers()
  })
})

describe('scheduler lifecycle', () => {
  it('releases one thousand removed editor states', () => {
    vi.useFakeTimers()
    const scheduler = new LatestTaskScheduler<object>(async () => {}, 100)
    const editors = Array.from({ length: 1_000 }, () => ({}))
    editors.forEach(editor => scheduler.schedule(editor))
    expect(scheduler.size).toBe(1_000)
    editors.forEach(editor => scheduler.remove(editor))
    expect(scheduler.size).toBe(0)
    scheduler.dispose()
    vi.useRealTimers()
  })

  it('prevents an asynchronous tail from applying after dispose', async () => {
    let release!: () => void
    const manager = new DecorationManager(new Map([['a', { color: 'red' }]]))
    const editor = new MockEditor() as any
    const scheduler = new LatestTaskScheduler<object>(async (_key, task) => {
      await new Promise<void>(resolve => release = resolve)
      if (task.isCurrent())
        manager.apply(editor, new Map([['a', [range(0, 1)]]]))
    }, 0)
    scheduler.schedule({}, true)
    await Promise.resolve()
    scheduler.dispose()
    manager.dispose()
    release()
    await Promise.resolve()
    expect(window.createTextEditorDecorationType).not.toHaveBeenCalled()
  })
})

describe('decoration lifecycle', () => {
  it('reuses types, batches ranges, and never recreates after dispose', () => {
    const manager = new DecorationManager(new Map<string, DecorationRenderOptions>([
      ['a', { color: 'red' }],
      ['b', { color: 'red' }],
      ['c', { color: 'blue' }],
    ]))
    const editor = new MockEditor() as any
    for (let iteration = 0; iteration < 100; iteration++) {
      manager.apply(editor, new Map([['a', [range(0, 1)]], ['b', [range(2, 3)]], ['c', [range(4, 5)]]]))
    }
    expect(window.createTextEditorDecorationType).toHaveBeenCalledTimes(2)
    const created = vi.mocked(window.createTextEditorDecorationType).mock.results.map(result => result.value)
    manager.dispose()
    manager.dispose()
    manager.apply(editor, new Map([['a', [range(0, 1)]]]))
    expect(window.createTextEditorDecorationType).toHaveBeenCalledTimes(2)
    created.forEach(type => expect(type.dispose).toHaveBeenCalledTimes(1))
  })
})
