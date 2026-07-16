import { vi } from 'vitest'

type Listener<T> = (event: T) => unknown

function createEvent<T>() {
  const listeners = new Set<Listener<T>>()
  return {
    event: vi.fn((listener: Listener<T>) => {
      listeners.add(listener)
      return { dispose: vi.fn(() => listeners.delete(listener)) }
    }),
    fire: async (event: T) => {
      for (const listener of [...listeners])
        await listener(event)
    },
    reset: () => listeners.clear(),
  }
}

const activeEditorEvent = createEvent<any>()
const themeEvent = createEvent<any>()
const visibleEditorsEvent = createEvent<any[]>()
const visibleRangesEvent = createEvent<any>()
const closeDocumentEvent = createEvent<any>()
const configurationEvent = createEvent<any>()
const openDocumentEvent = createEvent<any>()
const textDocumentEvent = createEvent<any>()

export const ColorThemeKind = {
  Light: 1,
  Dark: 2,
  HighContrast: 3,
  HighContrastLight: 4,
}

export const window = {
  activeColorTheme: { kind: ColorThemeKind.Light },
  activeTextEditor: null as any,
  visibleTextEditors: [] as any[],
  createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), dispose: vi.fn(), show: vi.fn() })),
  createTextEditorDecorationType: vi.fn((options: any) => ({
    options,
    dispose: vi.fn(),
  })),
  onDidChangeActiveColorTheme: themeEvent.event,
  onDidChangeActiveTextEditor: activeEditorEvent.event,
  onDidChangeTextEditorVisibleRanges: visibleRangesEvent.event,
  onDidChangeVisibleTextEditors: visibleEditorsEvent.event,
  showWarningMessage: vi.fn(() => Promise.resolve()),
  showErrorMessage: vi.fn(() => Promise.resolve()),
  showInformationMessage: vi.fn(() => Promise.resolve()),
}

export const workspace = {
  getConfiguration: vi.fn(() => ({
    get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
    update: vi.fn(() => Promise.resolve()),
  })),
  onDidChangeConfiguration: configurationEvent.event,
  onDidChangeTextDocument: textDocumentEvent.event,
  onDidCloseTextDocument: closeDocumentEvent.event,
  onDidOpenTextDocument: openDocumentEvent.event,
}

export class Range {
  public end: any
  public start: any

  constructor(start: any, end: any, endLine?: number, endCharacter?: number) {
    this.start = endLine === undefined ? start : new Position(start, end)
    this.end = endLine === undefined ? end : new Position(endLine, endCharacter ?? 0)
  }
}

export class Position {
  constructor(public line: number, public character: number) {}
}

export const DecorationRangeBehavior = {
  ClosedClosed: 0,
  ClosedOpen: 1,
  OpenClosed: 2,
  OpenOpen: 3,
}

export const commands = {
  registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
}

export const languages = {
  createDiagnosticCollection: vi.fn(() => ({
    set: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
  })),
}

export const __events = {
  activeEditor: activeEditorEvent,
  closeDocument: closeDocumentEvent,
  configuration: configurationEvent,
  openDocument: openDocumentEvent,
  textDocument: textDocumentEvent,
  theme: themeEvent,
  visibleEditors: visibleEditorsEvent,
  visibleRanges: visibleRangesEvent,
}

export function __resetVscodeMock(): void {
  Object.values(__events).forEach(event => event.reset())
  window.visibleTextEditors = []
  window.activeTextEditor = null
  window.activeColorTheme = { kind: ColorThemeKind.Light }
}

export default {
  ColorThemeKind,
  Position,
  Range,
  commands,
  languages,
  window,
  workspace,
}
