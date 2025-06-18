// Mock VSCode API for testing
export const window = {
  activeTextEditor: null,
  showWarningMessage: () => Promise.resolve(),
  showErrorMessage: () => Promise.resolve(),
  showInformationMessage: () => Promise.resolve(),
}

export const workspace = {
  getConfiguration: () => ({
    get: () => ({}),
    update: () => Promise.resolve(),
  }),
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
  registerCommand: () => ({ dispose: () => {} }),
}

export const languages = {
  createDiagnosticCollection: () => ({
    set: () => {},
    clear: () => {},
    dispose: () => {},
  }),
}

// Mock other VSCode APIs as needed
export default {
  window,
  workspace,
  Range,
  Position,
  DecorationRangeBehavior,
  commands,
  languages,
}
