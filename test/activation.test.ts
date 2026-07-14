import type { ExtensionContext, Position as VscodePosition, Range as VscodeRange } from 'vscode'
import type * as vscodeMockType from './mocks/vscode'
import * as vscodeUtils from '@vscode-use/utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import { activate, containsVueTsxBlock, getRuleLanguageId } from '../src/index'

vi.mock('@vscode-use/utils', () => {
  const configuration = { exclude: [] as string[], rules: {} as object }
  return {
    __configuration: configuration,
    createSelect: vi.fn(() => Promise.resolve(undefined)),
    getConfiguration: (name: string, defaultValue: unknown) => name.endsWith('.rules')
      ? configuration.rules
      : name.endsWith('.exclude')
        ? configuration.exclude
        : defaultValue,
    setConfiguration: vi.fn(() => Promise.resolve()),
  }
})

const configuration = (vscodeUtils as unknown as { __configuration: { exclude: string[], rules: object } }).__configuration
const { Position, Range, window } = vscode
const { __events, __resetVscodeMock } = vscode as unknown as typeof vscodeMockType

function createEditor(initialText: string, documentId = 'document') {
  let text = initialText
  const document = {
    getText: vi.fn((range?: VscodeRange) => range
      ? text.slice(range.start.character, range.end.character)
      : text),
    isClosed: false,
    languageId: 'plaintext',
    lineAt: vi.fn(() => ({ rangeIncludingLineBreak: { end: new Position(0, text.length) } })),
    lineCount: 1,
    offsetAt: vi.fn((position: VscodePosition) => position.character),
    positionAt: vi.fn((offset: number) => new Position(0, offset)),
    uri: { fsPath: `/src/${documentId}.txt`, path: `/src/${documentId}.txt` },
    version: 1,
  }
  const editor = {
    document,
    setDecorations: vi.fn(),
    setText(value: string) {
      text = value
      document.version++
      editor.visibleRanges = [new Range(new Position(0, 0), new Position(0, text.length))]
    },
    visibleRanges: [new Range(new Position(0, 0), new Position(0, text.length))],
  }
  return editor
}

async function waitFor(assertion: () => void, timeout = 2_000): Promise<void> {
  const startedAt = Date.now()
  while (true) {
    try {
      assertion()
      return
    }
    catch (error) {
      if (Date.now() - startedAt >= timeout)
        throw error
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
}

function disposeContext(context: ExtensionContext): void {
  for (const disposable of context.subscriptions)
    disposable.dispose()
}

describe('vue TSX language detection', () => {
  it('scans malformed opening tags with bounded linear work', () => {
    const malformed = '<script '.repeat(37_500)
    const startedAt = performance.now()
    expect(containsVueTsxBlock(malformed)).toBe(false)
    expect(performance.now() - startedAt).toBeLessThan(500)
  })

  it('recognizes script and template TSX blocks', () => {
    const script = createEditor('<script setup lang="tsx">const view = <div /></script>')
    script.document.languageId = 'vue'
    expect(getRuleLanguageId(script.document as any)).toBe('vuetsx')

    const quotedAngle = createEditor('<script title="<not-a-tag>" lang="tsx"></script>')
    quotedAngle.document.languageId = 'vue'
    expect(getRuleLanguageId(quotedAngle.document as any)).toBe('vuetsx')

    const template = createEditor('<template lang = "tsx"><div /></template>')
    template.document.languageId = 'vue'
    expect(getRuleLanguageId(template.document as any)).toBe('vuetsx')

    const lateScript = createEditor(`${'x'.repeat(100_001)}<script setup lang="tsx"></script>`, 'late-vue')
    lateScript.document.languageId = 'vue'
    expect(getRuleLanguageId(lateScript.document as any)).toBe('vuetsx')
    const reads = lateScript.document.getText.mock.calls.length
    expect(getRuleLanguageId(lateScript.document as any)).toBe('vuetsx')
    expect(lateScript.document.getText).toHaveBeenCalledTimes(reads)

    const beyondLimit = createEditor(`${'x'.repeat(300_001)}<script lang="tsx"></script>`, 'limited-vue')
    beyondLimit.document.languageId = 'vue'
    expect(getRuleLanguageId(beyondLimit.document as any)).toBe('vue')
  })
})

describe('extension activation orchestration', () => {
  beforeEach(() => {
    __resetVscodeMock()
    configuration.exclude = []
    configuration.rules = {
      plaintext: {
        light: { red: ['foo'] },
        dark: { blue: ['foo'] },
      },
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    __resetVscodeMock()
  })

  it('uses the manifest empty default without hidden source fallback rules', () => {
    configuration.rules = {}
    const editor = createEditor('v-if', 'empty-default')
    editor.document.languageId = 'vue'
    window.visibleTextEditors = [editor] as any
    const context = { subscriptions: [] } as unknown as ExtensionContext

    activate(context)
    expect(window.createTextEditorDecorationType).not.toHaveBeenCalled()
    disposeContext(context)
  })

  it.each([
    { 'vue|vuetsx': { light: { red: ['foo'] } } },
    {
      vue: { light: { red: ['foo'] } },
      vuetsx: { light: { red: [['foo', 'mg']] } },
    },
  ])('does not detect Vue TSX when Vue and Vue TSX rules are semantically identical', async (rules) => {
    configuration.rules = rules
    const editor = createEditor('foo', 'same-vue-rules')
    editor.document.languageId = 'vue'
    window.visibleTextEditors = [editor] as any
    const context = { subscriptions: [] } as unknown as ExtensionContext

    activate(context)
    await waitFor(() => expect(editor.setDecorations.mock.calls.some(([, ranges]) => ranges.length > 0)).toBe(true))
    expect(editor.document.getText).toHaveBeenCalledTimes(1)
    disposeContext(context)
  })

  it('detects Vue TSX when its semantic rules contain an additional rule', async () => {
    configuration.rules = {
      vue: { light: { red: ['foo'] } },
      vuetsx: { light: { blue: ['foo'] } },
    }
    const editor = createEditor('<script lang="tsx">foo</script>', 'different-vue-rules')
    editor.document.languageId = 'vue'
    window.visibleTextEditors = [editor] as any
    const context = { subscriptions: [] } as unknown as ExtensionContext

    activate(context)
    await waitFor(() => expect(vi.mocked(window.createTextEditorDecorationType).mock.results.some(result => result.value.options.color === 'blue')).toBe(true))
    const blueType = vi.mocked(window.createTextEditorDecorationType).mock.results.map(result => result.value).find(type => type.options.color === 'blue')
    await waitFor(() => expect(editor.setDecorations).toHaveBeenCalledWith(blueType, expect.arrayContaining([expect.anything()])))
    expect(editor.document.getText.mock.calls.length).toBeGreaterThan(1)
    disposeContext(context)
  })

  it('keeps highlighting when a style contains duplicate patterns', async () => {
    configuration.rules = { plaintext: { light: { red: ['foo', ['foo', 'mg']] } } }
    const editor = createEditor('foo', 'duplicate-patterns')
    window.visibleTextEditors = [editor] as any
    const context = { subscriptions: [] } as unknown as ExtensionContext

    activate(context)
    await waitFor(() => expect(editor.setDecorations.mock.calls.some(([, ranges]) => ranges.length === 1)).toBe(true))
    disposeContext(context)
  })

  it('does not scan an excluded Vue document for TSX blocks', async () => {
    configuration.exclude = ['**/excluded/**']
    configuration.rules = {
      vuetsx: { light: { red: ['foo'] } },
    }
    const editor = createEditor(`${'x'.repeat(200_000)}<script lang="tsx"></script>`, '../excluded/large')
    editor.document.languageId = 'vue'
    editor.document.uri.path = '/excluded/large.vue'
    window.visibleTextEditors = [editor] as any
    const context = { subscriptions: [] } as unknown as ExtensionContext

    activate(context)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(editor.document.getText).not.toHaveBeenCalled()
    disposeContext(context)
  })

  it('keeps successful initial profiles when a later profile fails', async () => {
    configuration.rules = {
      languageA: { light: { red: ['foo'] } },
      languageB: { light: { blue: ['foo'] } },
    }
    const first = createEditor('foo', 'initial-first')
    first.document.languageId = 'languageA'
    const second = createEditor('foo', 'initial-second')
    second.document.languageId = 'languageB'
    window.visibleTextEditors = [first, second] as any
    const completedType = { dispose: vi.fn() }
    vi.mocked(window.createTextEditorDecorationType)
      .mockImplementationOnce(() => completedType as any)
      .mockImplementationOnce(() => { throw new Error('invalid initial style') })
    const context = { subscriptions: [] } as unknown as ExtensionContext

    expect(() => activate(context)).not.toThrow()
    expect(completedType.dispose).not.toHaveBeenCalled()
    expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('Failed to apply initial configuration'))
    await waitFor(() => expect(first.setDecorations.mock.calls.some(([, ranges]) => ranges.length > 0)).toBe(true))
    disposeContext(context)
    expect(completedType.dispose).toHaveBeenCalledTimes(1)
  })

  it('creates exact-language decoration profiles before generic aliases', async () => {
    configuration.rules = {
      react: { light: { red: ['foo'] } },
      javascriptreact: { light: { blue: ['foo'] } },
      typescriptreact: { light: { green: ['foo'] } },
    }
    const jsx = createEditor('foo', 'jsx-priority')
    jsx.document.languageId = 'javascriptreact'
    const tsx = createEditor('foo', 'tsx-priority')
    tsx.document.languageId = 'typescriptreact'
    window.visibleTextEditors = [jsx, tsx] as any
    const context = { subscriptions: [] } as unknown as ExtensionContext

    activate(context)
    await waitFor(() => expect(window.createTextEditorDecorationType).toHaveBeenCalledTimes(6))
    expect(vi.mocked(window.createTextEditorDecorationType).mock.calls.map(([options]) => options.color)).toEqual([
      'blue',
      'green',
      'red',
      'green',
      'blue',
      'red',
    ])
    disposeContext(context)
  })

  it('highlights the initial visible range and independently updates split editors', async () => {
    const first = createEditor('foo', 'split')
    const second = createEditor('foo', 'split')
    second.document = first.document
    window.visibleTextEditors = [first, second] as any
    const context = { subscriptions: [] } as unknown as ExtensionContext

    activate(context)
    await waitFor(() => {
      expect(first.setDecorations).toHaveBeenCalled()
      expect(second.setDecorations).toHaveBeenCalled()
    })

    first.setDecorations.mockClear()
    window.visibleTextEditors = [second] as any
    await __events.visibleEditors.fire([...window.visibleTextEditors])
    await waitFor(() => expect(first.setDecorations).toHaveBeenCalledWith(expect.anything(), []))

    disposeContext(context)
  })

  it('reuses decoration types across edits and replaces them on configuration reload', async () => {
    const editor = createEditor('foo', 'configuration-lifecycle')
    window.visibleTextEditors = [editor] as any
    const context = { subscriptions: [] } as unknown as ExtensionContext

    activate(context)
    await waitFor(() => expect(editor.setDecorations.mock.calls.some(([, ranges]) => ranges.length > 0)).toBe(true))
    expect(window.createTextEditorDecorationType).toHaveBeenCalledTimes(1)
    const redType = vi.mocked(window.createTextEditorDecorationType).mock.results[0].value

    for (let index = 0; index < 2; index++) {
      editor.setText(`foo ${index}`)
      await __events.textDocument.fire({ contentChanges: [{}], document: editor.document })
      await waitFor(() => expect(editor.setDecorations.mock.calls.some(([type, ranges]) => type === redType && ranges.length > 0)).toBe(true))
    }
    expect(window.createTextEditorDecorationType).toHaveBeenCalledTimes(1)
    expect(redType.dispose).not.toHaveBeenCalled()

    configuration.rules = { plaintext: { light: { green: ['foo'] } } }
    await __events.configuration.fire({ affectsConfiguration: (section: string) => section === 'vscode-highlight-text.rules' })
    await waitFor(() => expect(window.createTextEditorDecorationType).toHaveBeenCalledTimes(2))
    const greenType = vi.mocked(window.createTextEditorDecorationType).mock.results[1].value
    await waitFor(() => expect(editor.setDecorations.mock.calls.some(([type, ranges]) => type === greenType && ranges.length > 0)).toBe(true))
    expect(redType.dispose).toHaveBeenCalledTimes(1)

    editor.setText('foo after reload')
    await __events.textDocument.fire({ contentChanges: [{}], document: editor.document })
    await waitFor(() => expect(editor.setDecorations.mock.calls.some(([type, ranges]) => type === greenType && ranges.length > 0)).toBe(true))
    expect(window.createTextEditorDecorationType).toHaveBeenCalledTimes(2)

    disposeContext(context)
    expect(greenType.dispose).toHaveBeenCalledTimes(1)
  })

  it('cancels a duplicate timed-out rule queued by a split editor', async () => {
    configuration.rules = { plaintext: { light: { red: ['(a+)+$'], green: ['NORMAL'] } } }
    const first = createEditor(`${'a'.repeat(20_000)}b NORMAL`, 'split-timeout')
    const second = createEditor('', 'split-timeout-copy')
    second.document = first.document
    second.visibleRanges = first.visibleRanges
    window.visibleTextEditors = [first, second] as any
    const context = { subscriptions: [] } as unknown as ExtensionContext

    activate(context)
    await waitFor(() => {
      const timeoutWarnings = vi.mocked(window.showWarningMessage).mock.calls.filter(([message]) => String(message).includes('exceeded 500ms'))
      expect(timeoutWarnings).toHaveLength(1)
    }, 2_000)
    await waitFor(() => {
      for (const editor of [first, second])
        expect(editor.setDecorations.mock.calls.some(([, ranges]) => ranges.length > 0)).toBe(true)
    }, 2_000)
    await new Promise(resolve => setTimeout(resolve, 600))
    const timeoutWarnings = vi.mocked(window.showWarningMessage).mock.calls.filter(([message]) => String(message).includes('exceeded 500ms'))
    expect(timeoutWarnings).toHaveLength(1)
    disposeContext(context)
  })

  it('keeps a timed-out rule disabled across edits until its cooldown expires', async () => {
    configuration.rules = {
      plaintext: { light: { red: ['(a+)+$'] } },
    }
    const editor = createEditor(`${'a'.repeat(20_000)}b`, 'timeout')
    window.visibleTextEditors = [editor] as any
    const context = { subscriptions: [] } as unknown as ExtensionContext

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    activate(context)
    await waitFor(() => expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('exceeded 500ms')))
    setTimeoutSpy.mockClear()

    for (let index = 0; index < 3; index++) {
      editor.setText(`${'a'.repeat(20_000)}b${index}`)
      await __events.textDocument.fire({ contentChanges: [{}], document: editor.document })
    }
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 500)).toBe(false)

    const currentTime = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(currentTime + 30_001)
    await __events.visibleRanges.fire({ textEditor: editor })
    await waitFor(() => expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 500)).toBe(true))

    disposeContext(context)
  })

  it('keeps a preflight profile while an oversized scan clears ranges', async () => {
    const editor = createEditor(`foo${'x'.repeat(200_001)}`, 'initial-scan-budget')
    window.visibleTextEditors = [editor] as any
    const context = { subscriptions: [] } as unknown as ExtensionContext

    activate(context)
    const type = vi.mocked(window.createTextEditorDecorationType).mock.results[0].value
    await waitFor(() => expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('Visible scan exceeds 200000 characters')))
    expect(type.dispose).not.toHaveBeenCalled()
    disposeContext(context)
    expect(type.dispose).toHaveBeenCalledTimes(1)
  })

  it('shares target layers across patterns from one style entry', async () => {
    configuration.rules = {
      plaintext: { light: {
        red: Array.from({ length: 301 }, (_, index) => `^pattern-${index}$`),
      } },
    }
    const editor = createEditor('pattern-300', 'shared-layers')
    window.visibleTextEditors = [editor] as any
    const context = { subscriptions: [] } as unknown as ExtensionContext

    activate(context)
    expect(window.createTextEditorDecorationType).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(editor.setDecorations.mock.calls.some(([, ranges]) => ranges.length > 0)).toBe(true), 3_000)
    expect(window.showWarningMessage).not.toHaveBeenCalledWith(expect.stringContaining('profile limit was reached'))
    disposeContext(context)
  })

  it('deduplicates overlapping rules before creating VS Code ranges', async () => {
    configuration.rules = {
      plaintext: { light: {
        red: Array.from({ length: 50 }, (_, index) => `[${'x'.repeat(index + 1)}]`),
      } },
    }
    const editor = createEditor('x'.repeat(100), 'overlapping-ranges')
    window.visibleTextEditors = [editor] as any
    const context = { subscriptions: [] } as unknown as ExtensionContext

    activate(context)
    await waitFor(() => expect(editor.setDecorations.mock.calls.some(([, ranges]) => ranges.length === 100)).toBe(true), 3_000)
    expect(editor.document.positionAt.mock.calls.length).toBeLessThan(300)
    disposeContext(context)
  })

  it('hands an existing profile to a replacement tab before releasing the old editor', async () => {
    configuration.rules = { plaintext: { light: { red: ['TARGET'] } } }
    const first = createEditor('TARGET', 'tab-first')
    const second = createEditor('TARGET', 'tab-second')
    window.visibleTextEditors = [first] as any
    const context = { subscriptions: [] } as unknown as ExtensionContext

    activate(context)
    await waitFor(() => expect(first.setDecorations.mock.calls.some(([, ranges]) => ranges.length > 0)).toBe(true))
    const type = vi.mocked(window.createTextEditorDecorationType).mock.results[0].value
    window.visibleTextEditors = [second] as any
    await __events.visibleEditors.fire([second] as any)
    await waitFor(() => expect(second.setDecorations.mock.calls.some(([, ranges]) => ranges.length > 0)).toBe(true))
    expect(window.createTextEditorDecorationType).toHaveBeenCalledTimes(1)
    expect(type.dispose).not.toHaveBeenCalled()
    disposeContext(context)
    expect(type.dispose).toHaveBeenCalledTimes(1)
  })

  it('continues after the per-chunk worker job limit', async () => {
    configuration.rules = {
      plaintext: { light: { red: [...Array.from({ length: 50 }, (_, index) => `missing-${index}`), 'TARGET'] } },
    }
    const editor = createEditor('TARGET', 'chunk-job-limit')
    window.visibleTextEditors = [editor] as any
    const context = { subscriptions: [] } as unknown as ExtensionContext

    activate(context)
    await waitFor(() => {
      const redTypes = vi.mocked(window.createTextEditorDecorationType).mock.results.map(result => result.value)
      expect(redTypes.some(type => editor.setDecorations.mock.calls.some(
        ([appliedType, ranges]) => appliedType === type && ranges.length > 0,
      ))).toBe(true)
    })
    expect(window.showWarningMessage).not.toHaveBeenCalledWith(expect.stringContaining('scan session limit reached'))
    expect(window.createTextEditorDecorationType).toHaveBeenCalledTimes(1)
    const type = vi.mocked(window.createTextEditorDecorationType).mock.results[0].value
    expect(type.dispose).not.toHaveBeenCalled()
    disposeContext(context)
    expect(type.dispose).toHaveBeenCalledTimes(1)
  })

  it('warns when completed rules exhaust the total range budget', async () => {
    const light: Record<string, string[]> = {}
    for (let index = 0; index < 10; index++)
      light[`rgb(${index},0,0)`] = ['x']
    light.blue = ['y']
    light.green = ['TARGET']
    configuration.rules = { plaintext: { light } }
    const editor = createEditor(`${'x'.repeat(999)}${'y'.repeat(10)} TARGET`, 'range-exhaustion')
    window.visibleTextEditors = [editor] as any
    const context = { subscriptions: [] } as unknown as ExtensionContext

    activate(context)
    await waitFor(() => expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('range budget was exhausted')), 3_000)
    disposeContext(context)
  })

  it('does not construct ranges for a rule that exceeds the remaining refresh budget', async () => {
    const light: Record<string, string[]> = {}
    for (let index = 0; index < 10; index++)
      light[`rgb(${index},0,0)`] = ['x']
    light.blue = ['y']
    light.green = ['TARGET']
    configuration.rules = { plaintext: { light } }
    const editor = createEditor(`${'x'.repeat(999)}${'y'.repeat(1_000)}TARGET`, 'remaining-range-budget')
    window.visibleTextEditors = [editor] as any
    const context = { subscriptions: [] } as unknown as ExtensionContext

    activate(context)
    await waitFor(() => expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('remaining 10 range budget')), 3_000)
    const types = vi.mocked(window.createTextEditorDecorationType).mock.results.map(result => result.value)
    const blueType = types.find(type => type.options.color === 'blue')
    const greenType = types.find(type => type.options.color === 'green')
    await waitFor(() => expect(editor.setDecorations).toHaveBeenCalledWith(greenType, expect.arrayContaining([expect.anything()])))
    expect(editor.setDecorations.mock.calls.some(([type, ranges]) => type === blueType && ranges.length > 0)).toBe(false)
    expect(editor.document.positionAt.mock.calls.length).toBeLessThan(20_100)
    disposeContext(context)
  })

  it('does not commit a snapshot when the visible scan exceeds its character budget', async () => {
    const editor = createEditor('foo', 'scan-budget')
    window.visibleTextEditors = [editor] as any
    const context = { subscriptions: [] } as unknown as ExtensionContext

    activate(context)
    await waitFor(() => expect(editor.setDecorations.mock.calls.some(([, ranges]) => ranges.length > 0)).toBe(true))
    editor.setDecorations.mockClear()
    editor.document.getText.mockClear()
    editor.setText(`foo${'x'.repeat(200_001)}`)
    await __events.textDocument.fire({ contentChanges: [{}], document: editor.document })
    await waitFor(() => expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('Visible scan exceeds 200000 characters')))
    expect(editor.setDecorations).toHaveBeenCalledWith(expect.anything(), [])
    expect(editor.document.getText).not.toHaveBeenCalled()
    disposeContext(context)
  })

  it('limits configuration warning toasts', () => {
    configuration.rules = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
      `language${index}`,
      { light: { red: { match: [] } } },
    ]))
    const context = { subscriptions: [] } as unknown as ExtensionContext
    activate(context)
    expect(window.showWarningMessage).toHaveBeenCalledTimes(5)
    const output = vi.mocked(window.createOutputChannel).mock.results[0].value
    expect(output.appendLine).toHaveBeenCalledTimes(20)
    disposeContext(context)
    expect(output.dispose).toHaveBeenCalledTimes(1)
  })

  it('attributes timeout diagnostics to rule execution including ignoreReg', async () => {
    configuration.rules = {
      plaintext: {
        light: {
          red: { match: ['SAFE'], ignoreReg: ['(a+)+$'] },
        },
      },
    }
    const editor = createEditor(`${'a'.repeat(20_000)}b SAFE`, 'ignore-timeout')
    window.visibleTextEditors = [editor] as any
    const context = { subscriptions: [] } as unknown as ExtensionContext

    activate(context)
    await waitFor(() => expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('rule execution (including ignoreReg)')))

    disposeContext(context)
  })

  it('keeps normal rules before and after an over-budget rule', async () => {
    const groups = Array.from({ length: 100 }, () => '(x)').join('')
    configuration.rules = {
      plaintext: { light: {
        blue: ['TARGET'],
        red: { match: [groups], colors: Array.from({ length: 100 }, () => 'red') },
        green: ['OTHER'],
      } },
    }
    const editor = createEditor(`TARGET ${'x'.repeat(10_100)} OTHER`, 'ordered-span-budget')
    window.visibleTextEditors = [editor] as any
    const context = { subscriptions: [] } as unknown as ExtensionContext

    activate(context)
    await waitFor(() => expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('span budget')), 3_000)
    const types = vi.mocked(window.createTextEditorDecorationType).mock.results.map(result => result.value)
    const blueType = types.find(type => type.options.color === 'blue')
    const greenType = types.find(type => type.options.color === 'green')
    await waitFor(() => {
      expect(editor.setDecorations).toHaveBeenCalledWith(blueType, expect.arrayContaining([expect.anything()]))
      expect(editor.setDecorations).toHaveBeenCalledWith(greenType, expect.arrayContaining([expect.anything()]))
    })
    disposeContext(context)
  })

  it('isolates a span-budget rule and still applies later rules', async () => {
    const groups = Array.from({ length: 100 }, () => '(x)').join('')
    configuration.rules = {
      plaintext: { light: {
        red: { match: [groups], colors: Array.from({ length: 100 }, () => 'red') },
        blue: ['TARGET'],
      } },
    }
    const editor = createEditor(`${'x'.repeat(10_100)} TARGET`, 'span-budget')
    window.visibleTextEditors = [editor] as any
    const context = { subscriptions: [] } as unknown as ExtensionContext

    activate(context)
    await waitFor(() => expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('span budget')), 3_000)
    const blueType = vi.mocked(window.createTextEditorDecorationType).mock.results.map(result => result.value).find(type => type.options.color === 'blue')
    await waitFor(() => expect(editor.setDecorations).toHaveBeenCalledWith(blueType, expect.arrayContaining([expect.anything()])))
    disposeContext(context)
  })

  it('retains the first 1000 matches and still applies later rules', async () => {
    configuration.rules = {
      plaintext: {
        light: {
          red: ['.', 'TARGET'],
        },
      },
    }
    const editor = createEditor(`${'x'.repeat(1_001)} TARGET`, 'limit')
    window.visibleTextEditors = [editor] as any
    const context = { subscriptions: [] } as unknown as ExtensionContext

    activate(context)
    await waitFor(() => expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('Main pattern exceeded 1000 matches')))
    const redTypes = vi.mocked(window.createTextEditorDecorationType).mock.results.map(result => result.value).filter(type => type.options.color === 'red')
    expect(redTypes).toHaveLength(1)
    await waitFor(() => expect(redTypes.some(type => editor.setDecorations.mock.calls.some(
      ([appliedType, ranges]) => appliedType === type && ranges.length === 1_001,
    ))).toBe(true))

    disposeContext(context)
  })

  it('recomputes a truncated rule after the document changes', async () => {
    configuration.rules = { plaintext: { light: { red: ['x'] } } }
    const editor = createEditor('x'.repeat(1_001), 'limit-recovery')
    window.visibleTextEditors = [editor] as any
    const context = { subscriptions: [] } as unknown as ExtensionContext

    activate(context)
    await waitFor(() => expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('Main pattern exceeded 1000 matches')))
    editor.setText('x'.repeat(10))
    await __events.textDocument.fire({ contentChanges: [{}], document: editor.document })
    await waitFor(() => {
      const redTypes = vi.mocked(window.createTextEditorDecorationType).mock.results.map(result => result.value)
      expect(redTypes.some(type => editor.setDecorations.mock.calls.some(
        ([appliedType, ranges]) => appliedType === type && ranges.length === 10,
      ))).toBe(true)
    })
    disposeContext(context)
  })

  it('does not resubmit failed rule ranges from an older document version', async () => {
    configuration.rules = {
      plaintext: {
        light: {
          red: ['SAFE', '(a+)+$'],
        },
      },
    }
    const editor = createEditor('SAFE aaaa', 'rule-snapshot')
    window.visibleTextEditors = [editor] as any
    const context = { subscriptions: [] } as unknown as ExtensionContext

    activate(context)
    const redType = vi.mocked(window.createTextEditorDecorationType).mock.results.map(result => result.value).find(type => type.options.color === 'red')
    await waitFor(() => expect(editor.setDecorations).toHaveBeenCalledWith(redType, expect.arrayContaining([expect.anything(), expect.anything()])))

    editor.setDecorations.mockClear()
    editor.setText(`SAFE ${'a'.repeat(20_000)}b`)
    await __events.textDocument.fire({ contentChanges: [{}], document: editor.document })
    await waitFor(() => expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('exceeded 500ms')))
    await waitFor(() => {
      const update = editor.setDecorations.mock.calls.find(([type, ranges]) => type === redType && ranges.length > 0)
      expect(update?.[1]).toHaveLength(1)
      expect(update?.[1][0].start.character).toBe(0)
    })

    disposeContext(context)
  })

  it('preserves the previous complete decoration snapshot when timeouts exhaust the refresh budget', async () => {
    configuration.rules = {
      plaintext: {
        light: {
          red: ['(a+)+$'],
          blue: ['(a|aa)+$'],
          yellow: ['(a+)+$'],
          green: ['NORMAL'],
        },
      },
    }
    const editor = createEditor('NORMAL', 'budget')
    window.visibleTextEditors = [editor] as any
    const context = { subscriptions: [] } as unknown as ExtensionContext

    activate(context)
    await waitFor(() => expect(editor.setDecorations).toHaveBeenCalled())
    editor.setDecorations.mockClear()
    editor.setText(`${'a'.repeat(20_000)}b NORMAL`)
    await __events.textDocument.fire({ contentChanges: [{}], document: editor.document })
    await waitFor(() => {
      const timeoutWarnings = vi.mocked(window.showWarningMessage).mock.calls.filter(([message]) => String(message).includes('exceeded 500ms'))
      expect(timeoutWarnings).toHaveLength(3)
    }, 3_000)
    expect(editor.setDecorations).toHaveBeenCalledWith(expect.anything(), [])
    await waitFor(() => {
      const greenTypes = vi.mocked(window.createTextEditorDecorationType).mock.results.map(result => result.value).filter(type => type.options.color === 'green')
      expect(greenTypes.some(type => editor.setDecorations.mock.calls.some(
        ([appliedType, ranges]) => appliedType === type && ranges.length > 0,
      ))).toBe(true)
    }, 3_000)

    disposeContext(context)
  })

  it('clears and reapplies rules when the document language mode changes', async () => {
    configuration.rules = {
      plaintext: { light: { red: ['foo'] } },
      markdown: { light: { blue: ['foo'] } },
    }
    const editor = createEditor('foo', 'language')
    window.visibleTextEditors = [editor] as any
    const context = { subscriptions: [] } as unknown as ExtensionContext

    activate(context)
    await waitFor(() => expect(editor.setDecorations.mock.calls.some(([, ranges]) => ranges.length > 0)).toBe(true))
    editor.setDecorations.mockClear()

    editor.document.isClosed = true
    window.visibleTextEditors = []
    await __events.closeDocument.fire(editor.document)
    expect(editor.setDecorations).toHaveBeenCalledWith(expect.anything(), [])

    editor.setDecorations.mockClear()
    editor.document.languageId = 'markdown'
    editor.document.isClosed = false
    window.visibleTextEditors = [editor] as any
    await __events.openDocument.fire(editor.document)
    await waitFor(() => expect(editor.setDecorations.mock.calls.some(([, ranges]) => ranges.length > 0)).toBe(true))

    disposeContext(context)
  })

  it('keeps the previous configuration active when manager creation fails', async () => {
    const editor = createEditor('foo', 'transaction')
    window.visibleTextEditors = [editor] as any
    const context = { subscriptions: [] } as unknown as ExtensionContext

    activate(context)
    await waitFor(() => expect(editor.setDecorations.mock.calls.some(([, ranges]) => ranges.length > 0)).toBe(true))
    const previousTypes = vi.mocked(window.createTextEditorDecorationType).mock.results.map(result => result.value)
    const partialType = { dispose: vi.fn() }
    vi.mocked(window.createTextEditorDecorationType)
      .mockImplementationOnce(() => partialType as any)
      .mockImplementationOnce(() => { throw new Error('invalid next style') })
    configuration.rules = {
      plaintext: { light: { green: ['foo'], yellow: ['bar'] } },
    }

    await __events.configuration.fire({ affectsConfiguration: () => true })
    expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('Failed to apply configuration'))
    expect(partialType.dispose).toHaveBeenCalledTimes(1)
    previousTypes.forEach(type => expect(type.dispose).not.toHaveBeenCalled())

    editor.setDecorations.mockClear()
    editor.setText('foo')
    await __events.textDocument.fire({ contentChanges: [{}], document: editor.document })
    await waitFor(() => expect(editor.setDecorations.mock.calls.some(([, ranges]) => ranges.length > 0)).toBe(true))

    await __events.configuration.fire({ affectsConfiguration: () => true })
    await waitFor(() => previousTypes.forEach(type => expect(type.dispose).toHaveBeenCalledTimes(1)))
    disposeContext(context)
  })

  it('clears old decorations on exclude and reuses decoration types on theme change', async () => {
    const editor = createEditor('foo')
    window.visibleTextEditors = [editor] as any
    const context = { subscriptions: [] } as unknown as ExtensionContext

    activate(context)
    await waitFor(() => expect(window.createTextEditorDecorationType).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(editor.setDecorations.mock.calls.some(([, ranges]) => ranges.length > 0)).toBe(true))
    const firstTypes = vi.mocked(window.createTextEditorDecorationType).mock.results.map(result => result.value)

    editor.setDecorations.mockClear()
    window.activeColorTheme = { kind: 2 }
    await __events.theme.fire(window.activeColorTheme)
    await waitFor(() => expect(editor.setDecorations.mock.calls.some(([, ranges]) => ranges.length > 0)).toBe(true))
    expect(window.createTextEditorDecorationType).toHaveBeenCalledTimes(2)
    firstTypes.forEach(type => expect(type.dispose).toHaveBeenCalledTimes(1))

    editor.setDecorations.mockClear()
    vi.mocked(window.createTextEditorDecorationType).mockClear()
    configuration.exclude = ['**/src/**']
    await __events.configuration.fire({
      affectsConfiguration: (section: string) => section === 'vscode-highlight-text.exclude',
    })
    await waitFor(() => expect(editor.setDecorations).toHaveBeenCalledWith(expect.anything(), []))
    expect(window.createTextEditorDecorationType).not.toHaveBeenCalled()

    window.visibleTextEditors = []
    await __events.visibleEditors.fire([])
    disposeContext(context)
  })
})
