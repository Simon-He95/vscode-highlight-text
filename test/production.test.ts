/* eslint-disable regexp/no-misleading-capturing-group, regexp/no-super-linear-backtracking */
import type { DecorationRenderOptions, Range } from 'vscode'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { window } from 'vscode'
import packageJson from '../package.json'
import { compileConfig, createExcludeFilter, getRulesForLanguage, normalizeStyle } from '../src/config'
import { DecorationManager } from '../src/decorations'
import { scanRule } from '../src/index'
import { compilePattern, isRegexSafe, normalizeFlags, safeMatchAll } from '../src/regex'
import { createRegexWorker, isRegexExecutionAbortedError, RegexExecutor } from '../src/regex-worker'
import { aggregateSnapshots, BoundedSet, RefreshBudget, RuleFailureRegistry } from '../src/runtime-control'
import { LatestTaskScheduler } from '../src/scheduler'

vi.mock('@vscode-use/utils', () => ({
  createSelect: vi.fn(),
  getConfiguration: vi.fn((_name: string, defaultValue: unknown) => defaultValue),
  setConfiguration: vi.fn(),
}))

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
    const rulesSchema = packageJson.contributes.configuration.properties['vscode-highlight-text.rules'] as any
    const serialized = JSON.stringify(rulesSchema)
    expect(serialized).not.toContain('$ref')
    const match = rulesSchema.additionalProperties.properties.light.additionalProperties.anyOf[1].properties.match
    expect(match.anyOf[0]).toEqual({ type: 'string' })
    expect(match.anyOf[1].items.anyOf).toHaveLength(2)
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
    const jsxRules = getRulesForLanguage(compiled, 'javascriptreact', false)
    const tsxRules = getRulesForLanguage(compiled, 'typescriptreact', false)
    expect(jsxRules).toHaveLength(1_000)
    expect(tsxRules).toHaveLength(1_000)
    expect(jsxRules[0].context).toContain('javascriptreact')
    expect(tsxRules[0].context).toContain('typescriptreact')
    const aliasWarnings: string[] = []
    getRulesForLanguage(compiled, 'javascriptreact', false, aliasWarnings)
    expect(aliasWarnings).toContainEqual(expect.stringContaining('after alias merging'))
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
    expect(totalRules).toBeLessThanOrEqual(5_000)
    expect(compiled.styles.size).toBeLessThanOrEqual(5)
    expect(compiled.warnings).toContainEqual(expect.stringContaining('compilation budget was reached'))

    const tooManyLanguages = compileConfig(Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`language${index}`, { light: { red: [`p${index}`] } }]),
    ))
    expect(tooManyLanguages.languages.size).toBe(100)
    expect(tooManyLanguages.warnings.length).toBeLessThanOrEqual(100)
  })

  it('charges invalid inputs to the compilation budget and rolls back their styles', () => {
    const invalidRules = Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [
      `color-${index}`,
      ['('],
    ]))
    const compiled = compileConfig({
      plaintext: { light: { ...invalidRules, green: ['foo'] } },
    })
    const rules = getRulesForLanguage(compiled, 'plaintext', false)
    expect(rules.some(rule => rule.pattern.source === 'foo')).toBe(true)
    expect(compiled.styles.size).toBe(1)
    expect(compiled.warnings.length).toBeLessThanOrEqual(100)
  })

  it('stops reading configuration values after compilation budgets are reached', () => {
    const raw: Record<string, unknown> = {}
    for (let index = 0; index < 101; index++) {
      Object.defineProperty(raw, `language${index}`, {
        enumerable: true,
        get: () => {
          if (index >= 100)
            throw new Error('read past language budget')
          return { light: { red: [`p${index}`] } }
        },
      })
    }
    expect(() => compileConfig(raw)).not.toThrow()

    const mode: Record<string, unknown> = {}
    for (let index = 0; index < 1_001; index++) {
      Object.defineProperty(mode, `color${index}`, {
        enumerable: true,
        get: () => {
          if (index >= 1_000)
            throw new Error('read past mode budget')
          return [`p${index}`]
        },
      })
    }
    expect(() => compileConfig({ plaintext: { light: mode } })).not.toThrow()
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

  it('fails closed when any ignoreReg pattern is invalid', () => {
    const invalidOnly = compileConfig({ plaintext: { light: { red: { match: ['SECRET'], ignoreReg: ['('] } } } })
    const mixed = compileConfig({ plaintext: { light: { red: { match: ['SECRET'], ignoreReg: ['valid', '('] } } } })
    const invalidType = compileConfig({ plaintext: { light: { red: { match: ['SECRET'], ignoreReg: ['valid', 123] } } } })
    const invalidTuple = compileConfig({ plaintext: { light: { red: { match: ['SECRET'], ignoreReg: ['valid', ['broken-tuple']] } } } })
    expect(getRulesForLanguage(invalidOnly, 'plaintext', false)).toEqual([])
    expect(getRulesForLanguage(mixed, 'plaintext', false)).toEqual([])
    expect(getRulesForLanguage(invalidType, 'plaintext', false)).toEqual([])
    expect(getRulesForLanguage(invalidTuple, 'plaintext', false)).toEqual([])
    expect(invalidOnly.styles.size).toBe(0)
    expect(mixed.styles.size).toBe(0)
    expect(invalidType.styles.size).toBe(0)
    expect(invalidTuple.styles.size).toBe(0)
  })

  it('accepts an empty ignoreReg without warnings', () => {
    const compiled = compileConfig({ vue: { light: { red: { match: ['foo'], ignoreReg: [] } } } })
    expect(getRulesForLanguage(compiled, 'vue', false)).toHaveLength(1)
    expect(compiled.warnings).toEqual([])
  })

  it('uses collision-free structured rule identifiers', () => {
    const compiled = compileConfig({ plaintext: { light: {
      'red:a': { match: ['b'], color: 'red' },
      'red': { match: ['a:b'], color: 'blue' },
    } } })
    const ids = getRulesForLanguage(compiled, 'plaintext', false).map(rule => rule.id)
    expect(new Set(ids).size).toBe(2)
  })

  it('supports language IDs that match object prototype names', () => {
    const compiled = compileConfig({ constructor: { light: { red: ['foo'] } } })
    for (const languageId of ['constructor', 'toString', '__proto__'])
      expect(() => getRulesForLanguage(compiled, languageId, false)).not.toThrow()
    expect(getRulesForLanguage(compiled, 'constructor', false)).toHaveLength(1)
  })

  it('preserves React aliases across JSX and TSX', () => {
    const compiled = compileConfig({
      react: { light: { red: ['react-rule'] } },
      javascriptreact: { light: { blue: ['jsx-rule'] } },
      typescriptreact: { light: { green: ['tsx-rule'] } },
    })
    const sources = (language: string) => getRulesForLanguage(compiled, language, false).map(rule => rule.pattern.source)
    expect(sources('javascriptreact')).toEqual(['jsx-rule', 'tsx-rule', 'react-rule'])
    expect(sources('typescriptreact')).toEqual(['tsx-rule', 'jsx-rule', 'react-rule'])
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

  it('preserves document anchor semantics when slices include boundary context', async () => {
    const executor = new RegexExecutor(500)
    await expect(executor.execute({
      ignores: [],
      maxMatches: 10,
      pattern: { source: '^foo', flags: 'gd' },
      targetGroups: [0],
      text: '\nfooX',
    })).resolves.toEqual([])
    await expect(executor.execute({
      ignores: [],
      maxMatches: 10,
      pattern: { source: 'foo$', flags: 'gd' },
      targetGroups: [0],
      text: 'Xfoo\nX',
    })).resolves.toEqual([])
    await expect(executor.execute({
      ignores: [],
      maxMatches: 10,
      pattern: { source: '^foo', flags: 'gmd' },
      targetGroups: [0],
      text: '\nfooX',
    })).resolves.toEqual([{ spans: [[1, 4]] }])
    await expect(executor.execute({
      ignores: [],
      maxMatches: 10,
      pattern: { source: 'foo$', flags: 'gmd' },
      targetGroups: [0],
      text: 'Xfoo\nX',
    })).resolves.toEqual([{ spans: [[1, 4]] }])
    executor.dispose()
  })

  it('preserves legacy default capture behavior for absent and empty groups', async () => {
    const executor = new RegexExecutor(500)
    for (const source of ['(foo)?bar', '()bar']) {
      await expect(executor.execute({
        ignores: [],
        maxMatches: 10,
        pattern: { source, flags: 'gd' },
        targetGroups: [undefined],
        text: 'bar',
      })).resolves.toEqual([])
    }
    executor.dispose()
  })

  it('rejects a target whose full match touches an artificial slice boundary', async () => {
    const executor = new RegexExecutor(500)
    const rule = {
      context: 'test',
      id: 'test',
      ignores: [],
      pattern: { source: '^[\\s\\S]*?(foo)', flags: 'gd' },
      targets: [{ groupIndex: 1, styleId: 'red' }],
    }
    await expect(scanRule(executor, rule, {
      artificialEnd: true,
      artificialStart: true,
      coreEnd: 4,
      coreStart: 1,
      scanStart: 0,
      text: '\nfooX',
    }, new AbortController().signal, 10, 0, 10, false)).resolves.toEqual([])
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
    await expect(executor.execute({
      ignores: [{ source: 'foo', flags: 'gd' }],
      maxMatches: 10,
      pattern: { source: '(?<=\\s{3})BAR', flags: 'gd' },
      targetGroups: [0],
      text: 'fooBAR',
    })).resolves.toEqual([])
    await expect(executor.execute({
      ignores: [{ source: 'foo', flags: 'gd' }],
      maxMatches: 10,
      pattern: { source: '(?=\\s)', flags: 'gd' },
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

  it('uses ignore masking to isolate catastrophic main-pattern input', async () => {
    const executor = new RegexExecutor(500)
    await expect(executor.execute({
      ignores: [{ source: 'a+b', flags: 'gd' }],
      maxMatches: 10,
      pattern: { source: '(a+)+$|TARGET', flags: 'gd' },
      targetGroups: [0],
      text: `${'a'.repeat(30)}b TARGET`,
    })).resolves.toEqual([{ spans: [[32, 38]] }])
    executor.dispose()
  })

  it('does not charge ignored raw matches to the accepted match limit', async () => {
    const executor = new RegexExecutor(500)
    const ignored = `BEGIN${'x'.repeat(2_000)}END`
    await expect(executor.execute({
      ignores: [{ source: 'BEGIN[\\s\\S]*END', flags: 'gd' }],
      maxMatches: 10,
      pattern: { source: '(?= )|TARGET', flags: 'gd' },
      targetGroups: [0],
      text: `${ignored}TARGET`,
    })).resolves.toEqual([{ spans: [[ignored.length, ignored.length + 6]] }])
    executor.dispose()
  })

  it('enforces the accepted match limit across slices', async () => {
    const executor = new RegexExecutor(500)
    await expect(executor.execute({
      acceptedMatchOffset: 9,
      ignores: [],
      maxMatches: 10,
      pattern: { source: 'x', flags: 'gd' },
      targetGroups: [0],
      text: 'xx',
    })).rejects.toThrow('Main pattern exceeded 10 matches')
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

  it('recovers after a synchronous worker factory failure cooldown', async () => {
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    let attempts = 0
    const executor = new RegexExecutor(500, () => {
      attempts++
      if (attempts === 1)
        throw new Error('ERR_WORKER_INIT_FAILED')
      return createRegexWorker()
    })
    const request = { ignores: [], maxMatches: 10, pattern: { source: 'a', flags: 'gd' }, targetGroups: [0], text: 'a' }
    await expect(executor.execute(request)).rejects.toThrow('ERR_WORKER_INIT_FAILED')
    await expect(executor.execute(request)).rejects.toThrow('temporarily unavailable')
    expect(attempts).toBe(1)
    now = 5_001
    await expect(executor.execute(request)).resolves.toEqual([{ spans: [[0, 1]] }])
    expect(executor.pendingCount).toBe(0)
    executor.dispose()
  })

  it('waits for worker termination before starting the next job', async () => {
    let releaseTermination!: () => void
    let attempts = 0
    const executor = new RegexExecutor(10, () => {
      attempts++
      if (attempts > 1) {
        const recovered = new EventEmitter() as any
        recovered.off = recovered.removeListener.bind(recovered)
        recovered.unref = vi.fn()
        recovered.terminate = vi.fn(async () => 0)
        recovered.postMessage = vi.fn(({ id }: { id: number }) => queueMicrotask(() => recovered.emit('message', { id, results: [{ spans: [[0, 1]] }] })))
        return recovered
      }
      const worker = new EventEmitter() as any
      worker.off = worker.removeListener.bind(worker)
      worker.unref = vi.fn()
      worker.postMessage = vi.fn()
      worker.terminate = vi.fn(() => new Promise<number>((resolve) => {
        releaseTermination = () => resolve(0)
      }))
      return worker
    })
    const request = { ignores: [], maxMatches: 10, pattern: { source: 'a', flags: 'gd' }, targetGroups: [0], text: 'a' }
    await expect(executor.execute(request)).rejects.toThrow('exceeded 10ms')
    const next = executor.execute(request)
    await Promise.resolve()
    expect(attempts).toBe(1)
    releaseTermination()
    await expect(next).resolves.toEqual([{ spans: [[0, 1]] }])
    expect(attempts).toBe(2)
    executor.dispose()
  })

  it('rejects queued jobs without recreating workers during infrastructure cooldown', async () => {
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    let attempts = 0
    const executor = new RegexExecutor(500, () => {
      attempts++
      if (attempts > 1)
        return createRegexWorker()
      const worker = new EventEmitter() as any
      worker.off = worker.removeListener.bind(worker)
      worker.unref = vi.fn()
      worker.terminate = vi.fn(async () => 0)
      worker.postMessage = vi.fn(() => queueMicrotask(() => worker.emit('error', new Error('worker unavailable'))))
      return worker
    })
    const request = { ignores: [], maxMatches: 10, pattern: { source: 'a', flags: 'gd' }, targetGroups: [0], text: 'a' }
    const first = executor.execute(request)
    const second = executor.execute(request)
    const third = executor.execute(request)
    await expect(first).rejects.toThrow('worker unavailable')
    await expect(second).rejects.toThrow('temporarily unavailable')
    await expect(third).rejects.toThrow('temporarily unavailable')
    expect(attempts).toBe(1)
    now = 5_001
    await expect(executor.execute(request)).resolves.toEqual([{ spans: [[0, 1]] }])
    expect(attempts).toBe(2)
    executor.dispose()
  })

  it('recovers after a synchronous postMessage failure cooldown', async () => {
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
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
    await expect(executor.execute(request)).rejects.toThrow('temporarily unavailable')
    expect(attempts).toBe(1)
    now = 5_001
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
    manager.prepareProfile('test', ['a'])
    const editor = new MockEditor() as any
    const scheduler = new LatestTaskScheduler<object>(async (_key, task) => {
      await new Promise<void>(resolve => release = resolve)
      if (task.isCurrent())
        manager.apply(editor, new Map([['a', [range(0, 1)]]]), 'test', ['a'])
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

    const manager = new DecorationManager(new Map<string, DecorationRenderOptions>([
      ['a', { color: 'red' }],
      ['b', { color: 'blue' }],
    ]))
    expect(() => manager.prepareProfile('test', ['a', 'b'])).toThrow('invalid style')
    expect(partial.dispose).toHaveBeenCalledTimes(1)
  })

  it('quarantines a failed profile and clears an editor previous profile', () => {
    const goodType = { dispose: vi.fn() }
    const partialType = { dispose: vi.fn() }
    vi.mocked(window.createTextEditorDecorationType)
      .mockImplementationOnce(() => goodType as any)
      .mockImplementationOnce(() => partialType as any)
      .mockImplementationOnce(() => { throw new Error('invalid deferred profile') })
    const manager = new DecorationManager(new Map<string, DecorationRenderOptions>([
      ['good', { color: 'green' }],
      ['bad-a', { color: 'red' }],
      ['bad-b', { color: 'blue' }],
    ]))
    const editor = new MockEditor() as any
    manager.apply(editor, new Map([['good', [range(0, 1)]]]), 'good', ['good'])
    expect(() => manager.apply(editor, new Map(), 'bad', ['bad-a', 'bad-b'])).toThrow('invalid deferred profile')
    expect(partialType.dispose).toHaveBeenCalledTimes(1)
    expect(goodType.dispose).toHaveBeenCalledTimes(1)
    expect(() => manager.prepareProfile('bad', ['bad-a', 'bad-b'])).toThrow('invalid deferred profile')
    expect(window.createTextEditorDecorationType).toHaveBeenCalledTimes(3)
    manager.dispose()
  })

  it('keeps identical visual styles separate across priority layers', () => {
    const manager = new DecorationManager(new Map<string, DecorationRenderOptions>([
      ['red', { color: 'red' }],
      ['blue', { color: 'blue' }],
    ]))
    const layers = [
      { id: 'exact-red', styleId: 'red' },
      { id: 'sibling-blue', styleId: 'blue' },
      { id: 'generic-red', styleId: 'red' },
    ]
    manager.prepareProfile('jsx', layers)
    expect(vi.mocked(window.createTextEditorDecorationType).mock.calls).toEqual([
      [{ color: 'red' }],
      [{ color: 'blue' }],
      [{ color: 'red' }],
    ])
    const editor = new MockEditor() as any
    manager.apply(editor, new Map([
      ['exact-red', [range(0, 1)]],
      ['sibling-blue', [range(0, 1), range(2, 3)]],
      ['generic-red', [range(2, 3)]],
    ]), 'jsx', layers)
    expect(editor.setDecorations).toHaveBeenCalledTimes(3)
    manager.dispose()
  })

  it('creates language profiles in explicit high-to-low priority order', () => {
    const manager = new DecorationManager(new Map<string, DecorationRenderOptions>([
      ['react', { color: 'red' }],
      ['jsx', { color: 'blue' }],
      ['tsx', { color: 'green' }],
    ]))
    manager.prepareProfile('javascriptreact:light', ['jsx', 'tsx', 'react'])
    expect(vi.mocked(window.createTextEditorDecorationType).mock.calls).toEqual([
      [{ color: 'blue' }],
      [{ color: 'green' }],
      [{ color: 'red' }],
    ])
    manager.dispose()
  })

  it('releases a reserved profile before its first apply', () => {
    const manager = new DecorationManager(new Map<string, DecorationRenderOptions>([['a', { color: 'red' }]]))
    const editor = new MockEditor() as any
    manager.reserveProfile(editor, 'reserved', ['a'])
    const type = vi.mocked(window.createTextEditorDecorationType).mock.results[0].value
    manager.clear(editor)
    expect(type.dispose).toHaveBeenCalledTimes(1)
    manager.dispose()
  })

  it('shares a profile across split editors and disposes it after the last editor leaves', () => {
    const manager = new DecorationManager(new Map<string, DecorationRenderOptions>([['a', { color: 'red' }]]))
    const first = new MockEditor() as any
    const second = new MockEditor() as any
    manager.apply(first, new Map([['a', [range(0, 1)]]]), 'plaintext:light', ['a'])
    manager.apply(second, new Map([['a', [range(0, 1)]]]), 'plaintext:light', ['a'])
    expect(window.createTextEditorDecorationType).toHaveBeenCalledTimes(1)
    const type = vi.mocked(window.createTextEditorDecorationType).mock.results[0].value
    manager.clear(first)
    expect(type.dispose).not.toHaveBeenCalled()
    manager.clear(second)
    expect(type.dispose).toHaveBeenCalledTimes(1)
    manager.dispose()
  })

  it('recovers a capacity-limited profile after the previous profile is released', () => {
    const manager = new DecorationManager(new Map<string, DecorationRenderOptions>([['a', { color: 'red' }]]))
    const first = new MockEditor() as any
    const second = new MockEditor() as any
    const layersA = Array.from({ length: 1_000 }, (_, index) => ({ id: `a-${index}`, styleId: 'a' }))
    const layersB = Array.from({ length: 1_000 }, (_, index) => ({ id: `b-${index}`, styleId: 'a' }))
    manager.reserveProfile(first, 'a', layersA)
    manager.reserveProfile(second, 'a', layersA)
    expect(() => manager.reserveProfile(first, 'b', layersB)).toThrow('Decoration type budget exceeded')
    manager.clear(second)
    expect(() => manager.reserveProfile(first, 'b', layersB)).not.toThrow()
    expect(window.createTextEditorDecorationType).toHaveBeenCalledTimes(2_000)
    manager.dispose()
  })

  it('enforces a manager-wide decoration type budget', () => {
    const manager = new DecorationManager(new Map<string, DecorationRenderOptions>([['a', { color: 'red' }]]))
    manager.prepareProfile('first', Array.from({ length: 1_000 }, (_, index) => ({ id: `a-${index}`, styleId: 'a' })))
    expect(() => manager.prepareProfile('second', Array.from({ length: 501 }, (_, index) => ({ id: `b-${index}`, styleId: 'a' }))))
      .toThrow('Decoration type budget exceeded')
    expect(window.createTextEditorDecorationType).toHaveBeenCalledTimes(1_000)
    manager.dispose()
  })

  it('reuses types, batches ranges, and never recreates after dispose', () => {
    const manager = new DecorationManager(new Map<string, DecorationRenderOptions>([
      ['a', { color: 'red' }],
      ['c', { color: 'blue' }],
    ]))
    manager.prepareProfile('test', ['a', 'c'])
    expect(vi.mocked(window.createTextEditorDecorationType).mock.calls).toEqual([
      [{ color: 'red' }],
      [{ color: 'blue' }],
    ])
    const editor = new MockEditor() as any
    for (let iteration = 0; iteration < 100; iteration++) {
      manager.apply(editor, new Map([['a', [range(0, 1), range(2, 3)]], ['c', [range(4, 5)]]]), 'test', ['a', 'c'])
    }
    expect(window.createTextEditorDecorationType).toHaveBeenCalledTimes(2)
    const created = vi.mocked(window.createTextEditorDecorationType).mock.results.map(result => result.value)
    manager.dispose()
    manager.dispose()
    manager.apply(editor, new Map([['a', [range(0, 1)]]]), 'test', ['a'])
    expect(window.createTextEditorDecorationType).toHaveBeenCalledTimes(2)
    created.forEach(type => expect(type.dispose).toHaveBeenCalledTimes(1))
  })
})
