// Mock VSCode API for testing
import { vi } from 'vitest'

export const window = {
  activeTextEditor: null,
  createTextEditorDecorationType: vi.fn((options: any) => ({
    options,
    dispose: vi.fn(),
  })),
  showWarningMessage: vi.fn(() => Promise.resolve()),
  showErrorMessage: vi.fn(() => Promise.resolve()),
  showInformationMessage: vi.fn(() => Promise.resolve()),
}

export const workspace = {
  getConfiguration: vi.fn(() => ({
    get: vi.fn(() => ({})),
    update: vi.fn(() => Promise.resolve()),
  })),
}

export class Range {
  constructor(public start: any, public end: any) {}
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

export default {
  window,
  workspace,
  Range,
  Position,
  DecorationRangeBehavior,
  commands,
  languages,
}
