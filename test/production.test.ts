/* eslint-disable regexp/no-misleading-capturing-group, regexp/no-super-linear-backtracking */
import type { DecorationRenderOptions, Range } from 'vscode'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { window } from 'vscode'
import { compileConfig, createExcludeFilter, getRulesForLanguage, normalizeStyle } from '../src/config'
import { DecorationManager } from '../src/decorations'
import { compilePattern, isRegexSafe, normalizeFlags } from '../src/regex'
import { RegexExecutor } from '../src/regex-worker'

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

  it('rejects common nested quantifiers without rejecting assertions', () => {
    const nestedPlus = '(a+)+$'
    const nestedStar = '(a*)*$'
    expect(isRegexSafe(new RegExp(nestedPlus))).toBe(false)
    expect(isRegexSafe(new RegExp(nestedStar))).toBe(false)
    expect(isRegexSafe(/(?!test)/)).toBe(true)
    expect(() => compilePattern([nestedPlus, 'm'])).toThrow('Potentially unsafe regular expression')
  })

  it('supports a single pattern, a pattern tuple, and an array of patterns', () => {
    const compiled = compileConfig({
      vue: {
        light: {
          red: { match: 'foo' },
          blue: { match: [['bar', 'gi']] },
          green: { match: [['baz', 'm'], 'qux'] },
        },
      },
    })
    const rules = getRulesForLanguage(compiled, 'vue', false)
    expect(rules.map(rule => rule.pattern)).toEqual([
      { source: 'foo', flags: 'gmd' },
      { source: 'bar', flags: 'gid' },
      { source: 'baz', flags: 'mgd' },
      { source: 'qux', flags: 'gmd' },
    ])
  })

  it('normalizes background without mutating the source style', () => {
    const source = { background: 'red', textDecoration: 'underline' }
    expect(normalizeStyle(source)).toEqual({ backgroundColor: 'red', textDecoration: 'underline' })
    expect(source).toEqual({ background: 'red', textDecoration: 'underline' })
  })

  it('processes all files when the exclude list is empty', () => {
    expect(createExcludeFilter([])('/workspace/src/example.ts')).toBe(true)
    expect(createExcludeFilter(['**/dist/**'])('/workspace/dist/example.js')).toBe(false)
  })

  it('keeps ignore patterns local to their rule', () => {
    const compiled = compileConfig({
      vue: {
        light: {
          red: { match: ['foo'], ignoreReg: ['bar'] },
          blue: { match: ['bar'] },
        },
      },
    })
    const rules = getRulesForLanguage(compiled, 'vue', false)
    expect(rules[0].ignores).toHaveLength(1)
    expect(rules[1].ignores).toHaveLength(0)
  })
})

describe('regex worker', () => {
  it('uses engine-provided indices for repeated, nested, optional, and lookbehind groups', async () => {
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
      pattern: { source: '((ab)c)', flags: 'gd' },
      targetGroups: [1, 2],
      text: 'abc',
    })).resolves.toEqual([{ spans: [[0, 3], [0, 2]] }])
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
    executor.dispose()
  })

  it('preserves the default first-participating-capture behavior', async () => {
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

  it('does not let one rule ignore matches from another rule', async () => {
    const executor = new RegexExecutor(500)
    const request = {
      maxMatches: 10,
      pattern: { source: 'foo', flags: 'gd' },
      targetGroups: [0],
      text: 'foo',
    }
    await expect(executor.execute({
      ...request,
      ignores: [{ source: 'foo', flags: 'gd' }],
    })).resolves.toEqual([])
    await expect(executor.execute({ ...request, ignores: [] })).resolves.toEqual([{ spans: [[0, 3]] }])
    executor.dispose()
  })

  it('terminates a catastrophic expression and recovers with a fresh worker', async () => {
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
})

describe('decoration lifecycle', () => {
  it('creates one type per unique style, batches ranges, and disposes every type', () => {
    const styles = new Map<string, DecorationRenderOptions>([
      ['a', { color: 'red' }],
      ['b', { color: 'red' }],
      ['c', { color: 'blue' }],
    ])
    const manager = new DecorationManager(styles)
    const editor = new MockEditor() as any

    manager.apply(editor, new Map([
      ['a', [range(0, 1), range(2, 3)]],
      ['b', [range(4, 5)]],
      ['c', [range(6, 7)]],
    ]))
    for (let iteration = 0; iteration < 100; iteration++) {
      manager.apply(editor, new Map([
        ['a', [range(0, 1)]],
        ['c', [range(6, 7)]],
      ]))
    }

    expect(window.createTextEditorDecorationType).toHaveBeenCalledTimes(2)
    expect(editor.setDecorations).toHaveBeenCalledTimes(202)
    const created = vi.mocked(window.createTextEditorDecorationType).mock.results.map(result => result.value)

    manager.rebuild(new Map([['a', { color: 'green' }]]))
    created.forEach(type => expect(type.dispose).toHaveBeenCalledTimes(1))
    manager.apply(editor, new Map([['a', [range(0, 1)]]]))
    manager.dispose()

    expect(window.createTextEditorDecorationType).toHaveBeenCalledTimes(3)
    const allCreated = vi.mocked(window.createTextEditorDecorationType).mock.results.map(result => result.value)
    allCreated.forEach(type => expect(type.dispose).toHaveBeenCalledTimes(1))
  })
})
