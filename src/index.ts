import type { ExtensionContext, TextDocument, TextEditor, Range as VscodeRange } from 'vscode'
import type { LatestTaskContext } from './scheduler'
import type { CompiledConfig, CompiledRule } from './type'
import { createSelect, getConfiguration, setConfiguration } from '@vscode-use/utils'
import { deepMerge } from 'lazy-js-utils'
import { ColorThemeKind, commands, Position, Range, window, workspace } from 'vscode'
import { compileConfig, createExcludeFilter, getRulesForLanguage } from './config'
import { DecorationManager } from './decorations'
import { isRegexExecutionAbortedError, isRegexExecutionTimeoutError, RegexExecutor } from './regex-worker'
import { BoundedSet, RefreshBudget, RuleFailureRegistry } from './runtime-control'
import { LatestTaskScheduler } from './scheduler'
import templates from './template'

const MAX_SCAN_SIZE = 200_000
const MAX_MATCHES_PER_RULE = 1_000
const MAX_TOTAL_RANGES = 10_000
const MAX_TOTAL_SCAN_TIME = 1_000
const REGEX_FAILURE_COOLDOWN = 30_000
const MAX_REMEMBERED_WARNINGS = 100
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
  signal: AbortSignal,
  maxMatches: number,
): Promise<Array<{ end: number, start: number, styleId: string }>> {
  const matches = await executor.execute({
    ignores: rule.ignores,
    maxMatches,
    pattern: rule.pattern,
    targetGroups: rule.targets.map(target => target.groupIndex),
    text: slice.text,
  }, signal)

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
  const failures = new RuleFailureRegistry<TextDocument>(REGEX_FAILURE_COOLDOWN)
  const cooldownTimers = new Map<TextDocument, ReturnType<typeof setTimeout>>()
  let scheduleCooldownRetry: (document: TextDocument) => void = () => {}
  const warned = new BoundedSet<string>(MAX_REMEMBERED_WARNINGS)

  const warnOnce = (warning: string) => {
    if (disposed || !warned.add(warning))
      return
    void window.showWarningMessage(`vscode-highlight-text: ${warning}`)
  }
  compiled.warnings.forEach(warnOnce)

  const updateEditor = async (editor: TextEditor, task: LatestTaskContext) => {
    const document = editor.document
    const documentVersion = document.version
    const isCurrent = () => task.isCurrent()
      && !disposed
      && editor.document === document
      && document.version === documentVersion
      && !document.isClosed
      && window.visibleTextEditors.includes(editor)

    if (!isCurrent())
      return
    const rules = getRules(compiled, document)
    if (!shouldProcess(document.uri.path) || !editor.visibleRanges.length || !rules.length) {
      if (isCurrent())
        manager.clear(editor)
      return
    }

    const rangesByStyle = new Map<string, VscodeRange[]>()
    const budget = new RefreshBudget(MAX_TOTAL_RANGES, MAX_TOTAL_SCAN_TIME)
    let budgetExceeded = false
    for (const slice of getScanSlices(editor)) {
      if (!isCurrent())
        return
      for (const rule of rules) {
        if (!isCurrent())
          return
        if (budget.exhausted) {
          budgetExceeded = true
          break
        }
        if (failures.isDisabled(document, rule.id))
          continue
        const maxMatches = Math.max(1, Math.min(
          MAX_MATCHES_PER_RULE,
          Math.ceil(budget.remainingRanges / Math.max(1, rule.targets.length)),
        ))
        try {
          const matches = await scanRule(executor, rule, slice, task.signal, maxMatches)
          if (!isCurrent())
            return
          for (const match of matches) {
            if (!budget.consumeRange()) {
              budgetExceeded = true
              break
            }
            const ranges = rangesByStyle.get(match.styleId) ?? []
            ranges.push(new Range(document.positionAt(match.start), document.positionAt(match.end)))
            rangesByStyle.set(match.styleId, ranges)
          }
        }
        catch (error) {
          if (!isCurrent() || isRegexExecutionAbortedError(error))
            return
          const pattern = `/${rule.pattern.source}/${rule.pattern.flags}`
          if (isRegexExecutionTimeoutError(error)) {
            failures.recordFailure(document, rule.id)
            scheduleCooldownRetry(document)
            warnOnce(`${rule.context}: ${pattern} exceeded ${error.timeoutMs}ms in ${document.uri.fsPath}; disabled for this document for ${REGEX_FAILURE_COOLDOWN / 1000}s`)
          }
          else {
            warnOnce(`${rule.context}: ${pattern} failed in ${document.uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        if (budgetExceeded)
          break
      }
      if (budgetExceeded)
        break
    }

    if (budgetExceeded)
      warnOnce(`Highlight refresh budget reached in ${document.uri.fsPath}; remaining rules were skipped`)
    if (isCurrent())
      manager.apply(editor, rangesByStyle)
  }

  const scheduler = new LatestTaskScheduler<TextEditor>(
    updateEditor,
    UPDATE_DELAY,
    error => warnOnce(error instanceof Error ? error.message : String(error)),
  )

  scheduleCooldownRetry = (document) => {
    const existing = cooldownTimers.get(document)
    if (existing)
      clearTimeout(existing)
    cooldownTimers.set(document, setTimeout(() => {
      cooldownTimers.delete(document)
      for (const editor of window.visibleTextEditors) {
        if (editor.document === document)
          scheduler.schedule(editor, true)
      }
    }, REGEX_FAILURE_COOLDOWN))
  }

  const refreshVisibleEditors = (immediate = true) => {
    const visible = new Set(window.visibleTextEditors)
    for (const editor of scheduler.keys) {
      if (!visible.has(editor)) {
        scheduler.remove(editor)
        manager.clear(editor)
      }
    }
    for (const [document, timer] of cooldownTimers) {
      if (!window.visibleTextEditors.some(editor => editor.document === document)) {
        clearTimeout(timer)
        cooldownTimers.delete(document)
        failures.clearDocument(document)
      }
    }
    window.visibleTextEditors.forEach(editor => scheduler.schedule(editor, immediate))
  }

  const rebuildAndRefresh = () => {
    window.visibleTextEditors.forEach(editor => scheduler.invalidate(editor))
    manager.rebuild(compiled.styles)
    refreshVisibleEditors(true)
  }

  context.subscriptions.push(
    workspace.onDidChangeTextDocument((event) => {
      for (const editor of window.visibleTextEditors) {
        if (editor.document === event.document && event.contentChanges.length)
          scheduler.schedule(editor)
      }
    }),
    window.onDidChangeActiveTextEditor((editor) => {
      if (editor)
        scheduler.schedule(editor, true)
      else
        refreshVisibleEditors()
    }),
    window.onDidChangeTextEditorVisibleRanges(event => scheduler.schedule(event.textEditor)),
    window.onDidChangeVisibleTextEditors(() => refreshVisibleEditors()),
    workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('vscode-highlight-text'))
        return
      compiled = compileConfig(getConfiguration('vscode-highlight-text.rules', defaultConfig))
      shouldProcess = getExcludeFilter()
      failures.clear()
      for (const timer of cooldownTimers.values())
        clearTimeout(timer)
      cooldownTimers.clear()
      warned.clear()
      compiled.warnings.forEach(warnOnce)
      rebuildAndRefresh()
    }),
    window.onDidChangeActiveColorTheme(() => rebuildAndRefresh()),
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
        for (const timer of cooldownTimers.values())
          clearTimeout(timer)
        cooldownTimers.clear()
        scheduler.dispose()
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
