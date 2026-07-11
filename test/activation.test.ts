import type { ExtensionContext, Position as VscodePosition, Range as VscodeRange } from 'vscode'
import type * as vscodeMockType from './mocks/vscode'
import * as vscodeUtils from '@vscode-use/utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import { activate } from '../src/index'

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

function createEditor(text: string, documentId = 'document') {
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
  return {
    document,
    setDecorations: vi.fn(),
    visibleRanges: [new Range(new Position(0, 0), new Position(0, text.length))],
  }
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
    __resetVscodeMock()
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

  it('clears old decorations on exclude and rebuilds decoration types on theme change', async () => {
    const editor = createEditor('foo')
    window.visibleTextEditors = [editor] as any
    const context = { subscriptions: [] } as unknown as ExtensionContext

    activate(context)
    await waitFor(() => expect(window.createTextEditorDecorationType).toHaveBeenCalledTimes(1))
    const firstType = vi.mocked(window.createTextEditorDecorationType).mock.results[0].value

    window.activeColorTheme = { kind: 2 }
    await __events.theme.fire(window.activeColorTheme)
    await waitFor(() => expect(window.createTextEditorDecorationType).toHaveBeenCalledTimes(2))
    expect(firstType.dispose).toHaveBeenCalledTimes(1)

    editor.setDecorations.mockClear()
    vi.mocked(window.createTextEditorDecorationType).mockClear()
    configuration.exclude = ['**/src/**']
    await __events.configuration.fire({ affectsConfiguration: () => true })
    await waitFor(() => expect(editor.setDecorations).toHaveBeenCalledWith(expect.anything(), []))
    expect(window.createTextEditorDecorationType).not.toHaveBeenCalled()

    window.visibleTextEditors = []
    await __events.visibleEditors.fire([])
    disposeContext(context)
  })
})
