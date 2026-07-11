/* eslint-disable regexp/no-misleading-capturing-group, regexp/no-super-linear-backtracking */
import type { DecorationRenderOptions, Range } from 'vscode'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { window } from 'vscode'
import packageJson from '../package.json'
import { compileConfig, createExcludeFilter, getRulesForLanguage, normalizeStyle } from '../src/config'
import { DecorationManager } from '../src/decorations'
import { compilePattern, isRegexSafe, normalizeFlags, safeMatchAll } from '../src/regex'
import { createRegexWorker, isRegexExecutionAbortedError, RegexExecutor } from '../src/regex-worker'
import { aggregateSnapshots, BoundedSet, RefreshBudget, RuleFailureRegistry } from '../src/runtime-control'
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
  it('requires nested tuples for flags in the manifest schema', () => {
    const definitions = packageJson.contributes.configuration.definitions as any
    const match = definitions['vscode-highlight-text.style'].anyOf[1].properties.match
    expect(match.anyOf[0]).toEqual({ type: 'string' })
    expect(match.anyOf[1].items.$ref).toBe('#/definitions/vscode-highlight-text.pattern')
    expect(match.anyOf[0]).not.toHaveProperty('$ref')
  })

  it('normalizes flags and accepts JavaScript assertions and named groups', () => {
    expect(normalizeFlags('m')).toBe('mgd')
    expect(normalizeFlags('dg')).toBe('dg')
    expect(() => normalizeFlags('z')).toThrow('Invalid regular expression flags: z')
    expect(() => compilePattern(['(?=foo)', 'm'])).not.toThrow()
    expect(() => compilePattern(['(?<=foo)\\w+', 'm'])).not.toThrow()
    expect(() => compilePattern(['(?<name>foo)', 'm'])).not.toThrow()
    expect(compilePattern(['foo', 'y']).flags).toContain('y')
    expect(compilePattern(['foo', '']).flags).toBe('gd')
  })

  it('warns about nested quantifiers without rejecting valid syntax', () => {
    const nestedPlus = '(a+)+$'
    expect(isRegexSafe(new RegExp(nestedPlus))).toBe(false)
    expect(isRegexSafe(/(?!test)/)).toBe(true)
    expect(() => compilePattern([nestedPlus, 'm'])).not.toThrow()

    const compiled = compileConfig({ vue: { light: {
      red: [nestedPlus],
      blue: ['(ab{2})+'],
      green: { match: ['safe'], ignoreReg: [nestedPlus] },
    } } })
    expect(getRulesForLanguage(compiled, 'vue', false)).toHaveLength(3)
    expect(compiled.warnings).toContain(`Potentially expensive regular expression for vue.light.red: ${nestedPlus}`)
    expect(compiled.warnings).toContain(`Potentially expensive ignoreReg for vue.light.green: ${nestedPlus}`)
  })

  it('rejects oversized target and ignore arrays before worker execution', () => {
    const oversized = Array.from({ length: 101 }, () => 'red')
    const compiled = compileConfig({
      vue: { light: {
        red: { match: ['foo'], colors: oversized },
        blue: { match: ['bar'], ignoreReg: oversized },
      } },
    })
    expect(getRulesForLanguage(compiled, 'vue', false)).toEqual([])
    expect(compiled.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('at most 100 targets'),
      expect.stringContaining('at most 100 patterns'),
    ]))
  })

  it('caps merged composite languages and React aliases', () => {
    const patternsA = Array.from({ length: 600 }, (_, index) => `a${index}`)
    const patternsB = Array.from({ length: 600 }, (_, index) => `b${index}`)
    const reactPatterns = Array.from({ length: 1_000 }, (_, index) => `r${index}`)
    const compiled = compileConfig({
      'vue|a': { light: { red: patternsA } },
      'vue|b': { light: { blue: patternsB } },
      'react': { light: { red: reactPatterns } },
      'javascriptreact': { light: { blue: reactPatterns } },
      'typescriptreact': { light: { green: reactPatterns } },
    })
    expect(getRulesForLanguage(compiled, 'vue', false)).toHaveLength(1_000)
    expect(getRulesForLanguage(compiled, 'javascriptreact', false)).toHaveLength(1_000)
    expect(getRulesForLanguage(compiled, 'typescriptreact', false)).toHaveLength(1_000)
    expect(compiled.warnings).toContainEqual(expect.stringContaining('Too many merged rules for vue'))
  })

  it('caps global languages, rule entries, and retained styles', () => {
    const patterns = Array.from({ length: 1_000 }, (_, index) => `p${index}`)
    const raw = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [
      `language${index}`,
      { light: { [`color${index}`]: patterns } },
    ]))
    const compiled = compileConfig(raw)
    const totalRules = [...compiled.languages.values()]
      .reduce((total, modes) => total + modes.dark.length + modes.light.length, 0)
    expect(totalRules).toBe(5_000)
    expect(compiled.styles.size).toBe(5)
    expect(compiled.warnings).toContainEqual(expect.stringContaining('5000 total language-mode rule entries'))

    const tooManyLanguages = compileConfig(Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`language${index}`, { light: { red: [`p${index}`] } }]),
    ))
    expect(tooManyLanguages.languages.size).toBe(100)
  })

  it('supports pattern strings and nested flag tuples without reinterpreting top-level arrays', () => {
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
      { source: '[0-9]+', flags: 'gmd' },
      { source: 'gi', flags: 'gmd' },
    ])
    expect(compiled.warnings).toContainEqual(expect.stringContaining('Ambiguous rule for vue.light.legacy'))
  })

  it('keeps explicit match arrays unambiguous', () => {
    const compiled = compileConfig({ vue: { light: { red: { match: ['foo', 'gm'] } } } })
    expect(getRulesForLanguage(compiled, 'vue', false).map(rule => rule.pattern.source)).toEqual(['foo', 'gm'])
  })

  it('preserves React aliases across JSX and TSX', () => {
    const compiled = compileConfig({
      react: { light: { red: ['react-rule'] } },
      javascriptreact: { light: { blue: ['jsx-rule'] } },
      typescriptreact: { light: { green: ['tsx-rule'] } },
    })
    const sources = (language: string) => getRulesForLanguage(compiled, language, false).map(rule => rule.pattern.source)
    expect(sources('javascriptreact')).toEqual(['react-rule', 'jsx-rule', 'tsx-rule'])
    expect(sources('typescriptreact')).toEqual(['react-rule', 'jsx-rule', 'tsx-rule'])
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

  it('preserves sticky matching semantics', async () => {
    const executor = new RegexExecutor(500)
    await expect(executor.execute({
      ignores: [],
      maxMatches: 10,
      pattern: compilePattern(['foo', 'y']),
      targetGroups: [0],
      text: 'xfoo',
    })).resolves.toEqual([])
    await expect(executor.execute({
      ignores: [],
      maxMatches: 10,
      pattern: compilePattern(['foo', 'y']),
      targetGroups: [0],
      text: 'foo',
    })).resolves.toEqual([{ spans: [[0, 3]] }])
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
    await expect(executor.execute({
      ignores: [{ source: 'foo', flags: 'gd' }],
      maxMatches: 10,
      pattern: { source: 'foo(bar)', flags: 'gd' },
      targetGroups: [1],
      text: 'foobar',
    })).resolves.toEqual([])
    await expect(executor.execute({
      ignores: [{ source: 'foo', flags: 'gd' }],
      maxMatches: 10,
      pattern: { source: 'bar', flags: 'gd' },
      targetGroups: [0],
      text: 'foobar',
    })).resolves.toEqual([{ spans: [[3, 6]] }])
    await expect(executor.execute({
      ignores: [{ source: 'abc', flags: 'gd' }],
      maxMatches: 10,
      pattern: { source: '\\s+', flags: 'gd' },
      targetGroups: [0],
      text: 'abc',
    })).resolves.toEqual([])
    await expect(executor.execute({
      ignores: [{ source: 'foo\\n', flags: 'gd' }],
      maxMatches: 10,
      pattern: { source: '^bar', flags: 'gmd' },
      targetGroups: [0],
      text: 'foo\nbar',
    })).resolves.toEqual([{ spans: [[4, 7]] }])
    await expect(executor.execute({
      ignores: [{ source: 'SECRET', flags: 'gd' }],
      maxMatches: 10,
      pattern: { source: 'foo.*bar', flags: 'gd' },
      targetGroups: [0],
      text: 'fooSECRETbar',
    })).resolves.toEqual([])
    await expect(executor.execute({
      ignores: [{ source: 'foo', flags: 'gd' }],
      maxMatches: 10,
      pattern: { source: '(?<=(foo))bar', flags: 'gd' },
      targetGroups: [1],
      text: 'foobar',
    })).resolves.toEqual([])
    await expect(executor.execute({
      ignores: [{ source: 'foo', flags: 'gd' }],
      maxMatches: 10,
      pattern: { source: '(?=(foo))', flags: 'gd' },
      targetGroups: [1],
      text: 'foo',
    })).resolves.toEqual([])
    await expect(executor.execute({
      ignores: [{ source: 'foo', flags: 'gd' }],
      maxMatches: 10,
      pattern: { source: '(?<=foo)bar', flags: 'gd' },
      targetGroups: [0],
      text: 'foobar',
    })).resolves.toEqual([])
    await expect(executor.execute({
      ignores: [{ source: 'bar', flags: 'gd' }],
      maxMatches: 10,
      pattern: { source: 'foo(?=bar)', flags: 'gd' },
      targetGroups: [0],
      text: 'foobar',
    })).resolves.toEqual([])
    await expect(executor.execute({
      ignores: [{ source: 'foo', flags: 'gd' }],
      maxMatches: 10,
      pattern: { source: '(?=foo)', flags: 'gd' },
      targetGroups: [0],
      text: 'foo',
    })).resolves.toEqual([])
    executor.dispose()
  })

  it('rejects a rule when its ignore scan is truncated', async () => {
    const executor = new RegexExecutor(500)
    await expect(executor.execute({
      ignores: [{ source: 'x|TARGET', flags: 'gd' }],
      maxMatches: 10,
      pattern: { source: 'TARGET', flags: 'gd' },
      targetGroups: [0],
      text: `${'x'.repeat(1_001)}TARGET`,
    })).rejects.toThrow('Ignore pattern exceeded 1000 matches')
    executor.dispose()
  })

  it('enforces a shared ignore interval budget', async () => {
    const executor = new RegexExecutor(500)
    const characters = 'abcdefghijk'.split('')
    await expect(executor.execute({
      ignores: characters.map(source => ({ source, flags: 'gd' })),
      maxMatches: 1_000,
      pattern: { source: 'TARGET', flags: 'gd' },
      targetGroups: [0],
      text: `${characters.map(character => character.repeat(1_000)).join('')}TARGET`,
    })).rejects.toThrow('Ignore patterns exceeded 10000 total intervals')
    executor.dispose()
  })

  it('enforces the span budget inside the worker', async () => {
    const executor = new RegexExecutor(500)
    await expect(executor.execute({
      ignores: [],
      maxMatches: 10,
      maxSpans: 1,
      pattern: { source: '(x)(x)', flags: 'gd' },
      targetGroups: [1, 2],
      text: 'xx',
    })).rejects.toThrow('Rule output exceeded the remaining 1 span budget')
    executor.dispose()
  })

  it('rejects a partial main-pattern result set', async () => {
    const executor = new RegexExecutor(500)
    await expect(executor.execute({
      ignores: [],
      maxMatches: 10,
      pattern: { source: 'x', flags: 'gd' },
      targetGroups: [0],
      text: 'x'.repeat(11),
    })).rejects.toThrow('Main pattern exceeded 10 matches')
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

  it('sends unchanged slice text to a worker only once', async () => {
    const messages: any[] = []
    class FakeWorker extends EventEmitter {
      postMessage(message: any) {
        messages.push(message)
        queueMicrotask(() => this.emit('message', { id: message.id, results: [] }))
      }

      terminate = vi.fn(async () => 0)
      unref = vi.fn()
    }
    const executor = new RegexExecutor(500, () => new FakeWorker() as any)
    const request = { ignores: [], maxMatches: 10, pattern: { source: 'a', flags: 'gd' }, targetGroups: [0], text: 'same text' }
    await executor.execute(request)
    await executor.execute(request)
    await executor.execute({ ...request, text: 'different text' })
    executor.resetCache()
    await executor.execute({ ...request, text: 'different text' })
    expect(messages[0].request.text).toBe('same text')
    expect(messages[1].request).not.toHaveProperty('text')
    expect(messages[2].request.text).toBe('different text')
    expect(messages[3].request).not.toHaveProperty('text')
    expect(messages[3].request.cacheGeneration).toBe(messages[2].request.cacheGeneration + 1)
    executor.dispose()
  })

  it('recovers after a synchronous worker factory failure', async () => {
    let attempts = 0
    const executor = new RegexExecutor(500, () => {
      attempts++
      if (attempts === 1)
        throw new Error('ERR_WORKER_INIT_FAILED')
      return createRegexWorker()
    })
    const request = { ignores: [], maxMatches: 10, pattern: { source: 'a', flags: 'gd' }, targetGroups: [0], text: 'a' }
    await expect(executor.execute(request)).rejects.toThrow('ERR_WORKER_INIT_FAILED')
    await expect(executor.execute(request)).resolves.toEqual([{ spans: [[0, 1]] }])
    expect(executor.pendingCount).toBe(0)
    executor.dispose()
  })

  it('recovers after a synchronous postMessage failure', async () => {
    let attempts = 0
    const executor = new RegexExecutor(500, () => {
      attempts++
      if (attempts > 1)
        return createRegexWorker()
      return {
        off: vi.fn(),
        on: vi.fn(),
        once: vi.fn(),
        postMessage: () => { throw new Error('postMessage failed') },
        terminate: vi.fn(async () => 0),
        unref: vi.fn(),
      } as any
    })
    const request = { ignores: [], maxMatches: 10, pattern: { source: 'a', flags: 'gd' }, targetGroups: [0], text: 'a' }
    await expect(executor.execute(request)).rejects.toThrow('postMessage failed')
    await expect(executor.execute(request)).resolves.toEqual([{ spans: [[0, 1]] }])
    expect(executor.pendingCount).toBe(0)
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

describe('runtime controls', () => {
  it('enforces the range limit after old and new rule snapshots are combined', () => {
    const oldSnapshot = new Map([['red', Array.from({ length: 6 }, (_, index) => index)]])
    const newSnapshot = new Map([['blue', Array.from({ length: 5 }, (_, index) => index)]])
    expect(aggregateSnapshots([oldSnapshot, newSnapshot], 10)).toBeUndefined()
    expect(aggregateSnapshots([oldSnapshot, newSnapshot], 11)).toEqual(new Map([
      ['red', [0, 1, 2, 3, 4, 5]],
      ['blue', [0, 1, 2, 3, 4]],
    ]))
  })

  it('deduplicates equal values while aggregating snapshots', () => {
    const first = new Map([['red', [{ start: 1, end: 2 }]]])
    const second = new Map([['red', [{ start: 1, end: 2 }]]])
    expect(aggregateSnapshots([first, second], 10, (_style, value) => `${value.start}:${value.end}`)?.get('red')).toHaveLength(1)
  })

  it('bounds remembered warning keys', () => {
    const values = new BoundedSet<string>(2)
    expect(values.add('first')).toBe(true)
    expect(values.add('first')).toBe(false)
    values.add('second')
    values.add('third')
    expect(values.size).toBe(2)
    expect(values.add('first')).toBe(true)
  })

  it('isolates rule cooldowns by document and restores them after expiry', () => {
    let now = 0
    const registry = new RuleFailureRegistry<object>(1_000, () => now)
    const documentA = {}
    const documentB = {}
    registry.recordFailure(documentA, 'rule')
    expect(registry.isDisabled(documentA, 'rule')).toBe(true)
    expect(registry.isDisabled(documentB, 'rule')).toBe(false)
    now = 1_001
    expect(registry.isDisabled(documentA, 'rule')).toBe(false)
    registry.recordFailure(documentA, 'rule')
    expect(registry.isDisabled(documentA, 'rule')).toBe(true)
  })

  it('enforces strict range and duration budgets', () => {
    let now = 0
    const ranges = new RefreshBudget(2, 1_000, () => now)
    expect(ranges.consumeRange()).toBe(true)
    expect(ranges.consumeRange()).toBe(true)
    expect(ranges.consumeRange()).toBe(false)

    const time = new RefreshBudget(10, 1_000, () => now)
    now = 1_000
    expect(time.exhausted).toBe(true)
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
    expect(window.createTextEditorDecorationType).toHaveBeenCalledTimes(1)
    expect(editor.setDecorations).not.toHaveBeenCalled()
  })
})

describe('decoration lifecycle', () => {
  it('disposes partially created types when initialization fails', () => {
    const partial = { dispose: vi.fn() }
    vi.mocked(window.createTextEditorDecorationType)
      .mockImplementationOnce(() => partial as any)
      .mockImplementationOnce(() => { throw new Error('invalid style') })

    expect(() => new DecorationManager(new Map<string, DecorationRenderOptions>([
      ['a', { color: 'red' }],
      ['b', { color: 'blue' }],
    ]))).toThrow('invalid style')
    expect(partial.dispose).toHaveBeenCalledTimes(1)
  })

  it('reuses types, batches ranges, and never recreates after dispose', () => {
    const manager = new DecorationManager(new Map<string, DecorationRenderOptions>([
      ['a', { color: 'red' }],
      ['c', { color: 'blue' }],
    ]))
    expect(vi.mocked(window.createTextEditorDecorationType).mock.calls).toEqual([
      [{ color: 'red' }],
      [{ color: 'blue' }],
    ])
    const editor = new MockEditor() as any
    for (let iteration = 0; iteration < 100; iteration++) {
      manager.apply(editor, new Map([['a', [range(0, 1), range(2, 3)]], ['c', [range(4, 5)]]]))
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
