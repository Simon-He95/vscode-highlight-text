import type { ExtensionContext, TextDocument, TextEditor, Range as VscodeRange } from 'vscode'
import type { CompiledConfig, CompiledRule } from './type'
import { createSelect, getConfiguration, setConfiguration } from '@vscode-use/utils'
import { deepMerge } from 'lazy-js-utils'
import { ColorThemeKind, commands, Position, Range, window, workspace } from 'vscode'
import { compileConfig, createExcludeFilter, getRulesForLanguage } from './config'
import { DecorationManager } from './decorations'
import { RegexExecutor } from './regex-worker'
import templates from './template'

const MAX_SCAN_SIZE = 200_000
const MAX_MATCHES_PER_RULE = 1_000
const OVERSCAN_LINES = 20
const UPDATE_DELAY = 100

const defaultConfig = {
  vue: {
    light: {
      'purple': { match: ['v-if', 'v-else-if', 'v-else'], before: { contentText: '✨' } },
      '#B392F0': ['v-for'],
      '#FFC83D': ['<template\\s+(\\#[^\\s\\/>=]+)', 'v-bind', 'v-once', 'v-on', '(v-slot:[^>\\s\\/>]+)', 'v-html', 'v-text'],
      'rgb(99, 102, 241)': [':is'],
      'rgb(14, 165, 233)': ['(defineProps)[<\\(]', 'defineOptions', 'defineEmits', 'defineExpose'],
    },
    dark: {
      'purple': { match: ['v-if', 'v-else-if', 'v-else'], before: { contentText: '✨' } },
      '#B392F0': ['v-for'],
      '#FFC83D': ['<template\\s+(\\#[^\\s\\/>=]+)', 'v-bind', 'v-once', 'v-on', '(v-slot:[^>\\s\\/>]+)', 'v-html', 'v-text'],
      'rgb(99, 102, 241)': [':is'],
      'rgb(14, 165, 233)': ['(defineProps)[<\\(]', 'defineOptions', 'defineEmits', 'defineExpose'],
    },
  },
  react: { light: {}, dark: {} },
}

interface ScanSlice {
  end: number
  start: number
  text: string
}

function isDarkTheme(): boolean {
  return window.activeColorTheme.kind === ColorThemeKind.Dark
    || window.activeColorTheme.kind === ColorThemeKind.HighContrast
}

function getScanSlices(editor: TextEditor): ScanSlice[] {
  const document = editor.document
  const ranges = editor.visibleRanges
    .map((visible) => {
      const startLine = Math.max(0, visible.start.line - OVERSCAN_LINES)
      const endLine = Math.min(document.lineCount - 1, visible.end.line + OVERSCAN_LINES)
      const start = document.offsetAt(new Position(startLine, 0))
      const end = document.offsetAt(document.lineAt(endLine).rangeIncludingLineBreak.end)
      return { start, end }
    })
    .sort((a, b) => a.start - b.start)

  const merged: Array<{ end: number, start: number }> = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && range.start <= previous.end)
      previous.end = Math.max(previous.end, range.end)
    else
      merged.push({ ...range })
  }

  let budget = MAX_SCAN_SIZE
  return merged.flatMap(({ start, end }) => {
    if (budget <= 0)
      return []
    const limitedEnd = Math.min(end, start + budget)
    budget -= limitedEnd - start
    return [{ start, end: limitedEnd, text: document.getText(new Range(document.positionAt(start), document.positionAt(limitedEnd))) }]
  })
}

async function scanRule(
  executor: RegexExecutor,
  rule: CompiledRule,
  slice: ScanSlice,
): Promise<Array<{ end: number, start: number, styleId: string }>> {
  const matches = await executor.execute({
    ignores: rule.ignores,
    maxMatches: MAX_MATCHES_PER_RULE,
    pattern: rule.pattern,
    targetGroups: rule.targets.map(target => target.groupIndex),
    text: slice.text,
  })

  return matches.flatMap(match => match.spans.flatMap((span, index) => span
    ? [{
        start: slice.start + span[0],
        end: slice.start + span[1],
        styleId: rule.targets[index].styleId,
      }]
    : []))
}

function getRules(config: CompiledConfig, document: TextDocument): CompiledRule[] {
  const previewEnd = document.lineAt(Math.min(document.lineCount - 1, 99)).rangeIncludingLineBreak.end
  const languageId = document.languageId === 'vue'
    && /<template\b[^>]*\slang=["']tsx["']/.test(document.getText(new Range(new Position(0, 0), previewEnd)))
    ? 'vuetsx'
    : document.languageId
  return getRulesForLanguage(config, languageId, isDarkTheme())
}

export function activate(context: ExtensionContext): void {
  let disposed = false
  let compiled = compileConfig(getConfiguration('vscode-highlight-text.rules', defaultConfig))
  let shouldProcess = getExcludeFilter()
  const manager = new DecorationManager(compiled.styles)
  const executor = new RegexExecutor()
  const timers = new Map<TextEditor, ReturnType<typeof setTimeout>>()
  const generations = new Map<TextEditor, number>()
  const disabledRules = new Set<CompiledRule>()
  const warned = new Set<string>()

  const warnOnce = (message: string) => {
    if (warned.has(message))
      return
    warned.add(message)
    void window.showWarningMessage(`vscode-highlight-text: ${message}`)
  }
  compiled.warnings.forEach(warnOnce)

  const updateEditor = async (editor: TextEditor) => {
    const generation = (generations.get(editor) ?? 0) + 1
    generations.set(editor, generation)
    const rules = getRules(compiled, editor.document)
    if (!window.visibleTextEditors.includes(editor) || !shouldProcess(editor.document.uri.path) || !editor.visibleRanges.length || !rules.length) {
      manager.clear(editor)
      return
    }

    const rangesByStyle = new Map<string, VscodeRange[]>()
    try {
      for (const slice of getScanSlices(editor)) {
        for (const rule of rules) {
          if (disabledRules.has(rule))
            continue
          try {
            const matches = await scanRule(executor, rule, slice)
            if (disposed || generations.get(editor) !== generation || editor.document.isClosed)
              return
            for (const match of matches) {
              const ranges = rangesByStyle.get(match.styleId) ?? []
              ranges.push(new Range(editor.document.positionAt(match.start), editor.document.positionAt(match.end)))
              rangesByStyle.set(match.styleId, ranges)
            }
          }
          catch (error) {
            disabledRules.add(rule)
            warnOnce(error instanceof Error ? error.message : String(error))
          }
        }
      }
      manager.apply(editor, rangesByStyle)
    }
    catch (error) {
      warnOnce(error instanceof Error ? error.message : String(error))
      manager.clear(editor)
    }
  }

  const schedule = (editor: TextEditor, immediate = false) => {
    const timer = timers.get(editor)
    if (timer)
      clearTimeout(timer)
    if (immediate) {
      timers.delete(editor)
      void updateEditor(editor)
      return
    }
    timers.set(editor, setTimeout(() => {
      timers.delete(editor)
      void updateEditor(editor)
    }, UPDATE_DELAY))
  }

  const refreshVisibleEditors = () => {
    const visible = new Set(window.visibleTextEditors)
    for (const editor of generations.keys()) {
      if (!visible.has(editor)) {
        const timer = timers.get(editor)
        if (timer)
          clearTimeout(timer)
        timers.delete(editor)
        generations.set(editor, (generations.get(editor) ?? 0) + 1)
        manager.clear(editor)
      }
    }
    window.visibleTextEditors.forEach(editor => schedule(editor, true))
  }

  context.subscriptions.push(
    workspace.onDidChangeTextDocument((event) => {
      for (const editor of window.visibleTextEditors) {
        if (editor.document === event.document && event.contentChanges.length)
          schedule(editor)
      }
    }),
    window.onDidChangeActiveTextEditor((editor) => {
      if (editor)
        schedule(editor, true)
      else
        refreshVisibleEditors()
    }),
    window.onDidChangeTextEditorVisibleRanges(event => schedule(event.textEditor)),
    window.onDidChangeVisibleTextEditors(refreshVisibleEditors),
    workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('vscode-highlight-text'))
        return
      compiled = compileConfig(getConfiguration('vscode-highlight-text.rules', defaultConfig))
      shouldProcess = getExcludeFilter()
      disabledRules.clear()
      warned.clear()
      compiled.warnings.forEach(warnOnce)
      manager.rebuild(compiled.styles)
      refreshVisibleEditors()
    }),
    window.onDidChangeActiveColorTheme(() => {
      manager.rebuild(compiled.styles)
      refreshVisibleEditors()
    }),
    commands.registerCommand('vscode-highlight-text.selectTemplate', async () => {
      const select = await createSelect(Object.keys(templates))
      if (!select)
        return
      const userConfig = getConfiguration('vscode-highlight-text.rules', {})
      await setConfiguration('vscode-highlight-text.rules', deepMerge(userConfig, (templates as Record<string, object>)[select]))
    }),
    {
      dispose: () => {
        disposed = true
        for (const timer of timers.values())
          clearTimeout(timer)
        timers.clear()
        generations.clear()
        executor.dispose()
        manager.dispose()
      },
    },
  )

  refreshVisibleEditors()
}

export function deactivate(): void {}

function getExcludeFilter(): (path: string) => boolean {
  const value = getConfiguration('vscode-highlight-text.exclude', ['**/dist/**', '**/node_modules/**'])
  return createExcludeFilter(value)
}
