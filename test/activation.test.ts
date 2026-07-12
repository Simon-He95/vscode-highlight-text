import type { ExtensionContext, Position as VscodePosition, Range as VscodeRange } from 'vscode'
import type * as vscodeMockType from './mocks/vscode'
import * as vscodeUtils from '@vscode-use/utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import { activate, getRuleLanguageId } from '../src/index'

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
  it('recognizes script and template TSX blocks', () => {
    const script = createEditor('<script setup lang="tsx">const view = <div /></script>')
    script.document.languageId = 'vue'
    expect(getRuleLanguageId(script.document as any)).toBe('vuetsx')

    const template = createEditor('<template lang = "tsx"><div /></template>')
    template.document.languageId = 'vue'
    expect(getRuleLanguageId(template.document as any)).toBe('vuetsx')

    const lateScript = createEditor(`${'x'.repeat(100_001)}<script setup lang="tsx"></script>`, 'late-vue')
    lateScript.document.languageId = 'vue'
    expect(getRuleLanguageId(lateScript.document as any)).toBe('vuetsx')
    const reads = lateScript.document.getText.mock.calls.length
    expect(getRuleLanguageId(lateScript.document as any)).toBe('vuetsx')
    expect(lateScript.document.getText).toHaveBeenCalledTimes(reads)

    const beyondLimit = createEditor(`${'x'.repeat(1_000_001)}<script lang="tsx"></script>`, 'limited-vue')
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

  it('stays active with an empty manager when initial type creation fails', () => {
    const editor = createEditor('foo', 'initial-failure')
    window.visibleTextEditors = [editor] as any
    vi.mocked(window.createTextEditorDecorationType)
      .mockImplementationOnce(() => { throw new Error('invalid initial style') })
    const context = { subscriptions: [] } as unknown as ExtensionContext

    expect(() => activate(context)).not.toThrow()
    expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('Failed to apply initial configuration'))
    disposeContext(context)
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

  it('does not commit a snapshot when the visible scan exceeds its character budget', async () => {
    const editor = createEditor('foo', 'scan-budget')
    window.visibleTextEditors = [editor] as any
    const context = { subscriptions: [] } as unknown as ExtensionContext

    activate(context)
    await waitFor(() => expect(editor.setDecorations.mock.calls.some(([, ranges]) => ranges.length > 0)).toBe(true))
    editor.setDecorations.mockClear()
    editor.setText(`foo${'x'.repeat(200_001)}`)
    await __events.textDocument.fire({ contentChanges: [{}], document: editor.document })
    await waitFor(() => expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('Visible scan exceeds 200000 characters')))
    expect(editor.setDecorations).toHaveBeenCalledWith(expect.anything(), [])
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
    disposeContext(context)
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

  it('skips only an over-limit rule and still applies later rules', async () => {
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
    const types = vi.mocked(window.createTextEditorDecorationType).mock.results.map(result => result.value)
    const redType = types.find(type => type.options.color === 'red')
    await waitFor(() => expect(editor.setDecorations).toHaveBeenCalledWith(redType, expect.arrayContaining([expect.anything()])))

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
      expect(timeoutWarnings).toHaveLength(2)
    }, 3_000)
    expect(editor.setDecorations).toHaveBeenCalledWith(expect.anything(), [])

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
    await __events.closeDocument.fire(editor.document)
    expect(editor.setDecorations).toHaveBeenCalledWith(expect.anything(), [])

    editor.setDecorations.mockClear()
    editor.document.languageId = 'markdown'
    editor.document.isClosed = false
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
