import type { ExtensionContext, TextDocument, TextEditor, Range as VscodeRange } from 'vscode'
import type { LatestTaskContext } from './scheduler'
import type { CompiledConfig, CompiledRule } from './type'
import { createSelect, getConfiguration, setConfiguration } from '@vscode-use/utils'
import { deepMerge } from 'lazy-js-utils'
import { ColorThemeKind, commands, Position, Range, window, workspace } from 'vscode'
import { compileConfig, createExcludeFilter, getRulesForLanguage } from './config'
import { DecorationManager } from './decorations'
import { isRegexExecutionAbortedError, isRegexExecutionInfrastructureError, isRegexExecutionLimitError, isRegexExecutionTimeoutError, RegexExecutor } from './regex-worker'
import { aggregateSnapshots, BoundedSet, RefreshBudget, RuleFailureRegistry } from './runtime-control'
import { LatestTaskScheduler } from './scheduler'
import templates from './template'

const MAX_SCAN_SIZE = 200_000
const MAX_MATCHES_PER_RULE = 1_000
const MAX_TOTAL_RANGES = 10_000
const MAX_TOTAL_SCAN_TIME = 1_000
const MAX_PROFILE_LAYERS = 1_000
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

interface RuleSnapshot {
  documentVersion: number
  scanKey: string
  rangesByStyle: Map<string, VscodeRange[]>
}

interface ScanSession {
  acceptedRangeKeys: Set<string>
  candidateKeys: Set<string>
  candidateSnapshot: Map<string, VscodeRange[]>
  failedRuleIds: Set<string>
  key: string
  nextRuleIndex: number
  nextSliceIndex: number
  previousSnapshots: Map<string, RuleSnapshot>
  scannedSnapshots: Map<string, Map<string, VscodeRange[]>>
}

interface ScanPlan {
  complete: boolean
  scanKey: string
  slices: ScanSlice[]
}

interface ScanSlice {
  coreEnd: number
  coreStart: number
  scanStart: number
  text: string
}

function isDarkTheme(): boolean {
  return window.activeColorTheme.kind === ColorThemeKind.Dark
    || window.activeColorTheme.kind === ColorThemeKind.HighContrast
}

function getScanSlices(editor: TextEditor): ScanPlan {
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

  const scanKey = merged.map(range => `${range.start}:${range.end}`).join(',')
  const documentEnd = document.offsetAt(document.lineAt(document.lineCount - 1).rangeIncludingLineBreak.end)
  const plannedSlices = merged.map(({ start, end }) => ({
    coreStart: start,
    coreEnd: end,
    scanStart: Math.max(0, start - 1),
    scanEnd: Math.min(documentEnd, end + 1),
  }))
  const totalSize = plannedSlices.reduce((total, slice) => total + slice.scanEnd - slice.scanStart, 0)
  if (totalSize > MAX_SCAN_SIZE)
    return { complete: false, scanKey, slices: [] }
  const slices = plannedSlices.map(({ scanEnd, ...slice }) => ({
    ...slice,
    text: document.getText(new Range(document.positionAt(slice.scanStart), document.positionAt(scanEnd))),
  }))
  return { complete: true, scanKey, slices }
}

async function scanRule(
  executor: RegexExecutor,
  rule: CompiledRule,
  slice: ScanSlice,
  signal: AbortSignal,
  maxMatches: number,
  maxSpans: number,
  refreshSpanBudget: boolean,
): Promise<Array<{ end: number, start: number, styleId: string }>> {
  const matches = await executor.execute({
    ignores: rule.ignores,
    maxMatches,
    maxSpans,
    refreshSpanBudget,
    pattern: rule.pattern,
    targetGroups: rule.targets.map(target => target.groupIndex),
    text: slice.text,
  }, signal)

  return matches.flatMap(match => match.spans.flatMap((span, index) => {
    if (!span)
      return []
    const start = slice.scanStart + span[0]
    const end = slice.scanStart + span[1]
    return start >= slice.coreStart && end <= slice.coreEnd
      ? [{ start, end, styleId: rule.targets[index].decorationId ?? rule.targets[index].styleId }]
      : []
  }))
}

const languageDetectionCache = new WeakMap<TextDocument, { languageId: string, result: string, version: number }>()

export function getRuleLanguageId(document: TextDocument): string {
  if (document.languageId !== 'vue')
    return document.languageId
  const cached = languageDetectionCache.get(document)
  if (cached?.version === document.version && cached.languageId === document.languageId)
    return cached.result

  const documentEnd = Math.min(
    document.offsetAt(document.lineAt(document.lineCount - 1).rangeIncludingLineBreak.end),
    1_000_000,
  )
  const blockSize = 100_000
  let carry = ''
  let result = document.languageId
  for (let start = 0; start < documentEnd; start += blockSize) {
    const end = Math.min(documentEnd, start + blockSize)
    const chunk = document.getText(new Range(document.positionAt(start), document.positionAt(end)))
    const candidate = carry + chunk
    if (/<(?:script|template)\b[^>]*\slang\s*=\s*["']tsx["']/i.test(candidate)) {
      result = 'vuetsx'
      break
    }
    const lastOpen = candidate.lastIndexOf('<')
    const lastClose = candidate.lastIndexOf('>')
    carry = lastOpen > lastClose ? candidate.slice(Math.max(lastOpen, candidate.length - 10_000)) : ''
  }
  languageDetectionCache.set(document, { languageId: document.languageId, result, version: document.version })
  return result
}

function getRuleSelection(config: CompiledConfig, document: TextDocument) {
  const languageId = document.languageId === 'vue' && config.languages.has('vuetsx')
    ? getRuleLanguageId(document)
    : document.languageId
  const dark = isDarkTheme()
  const warnings: string[] = []
  const sourceRules = getRulesForLanguage(config, languageId, dark, warnings)
  const priorityStyleIds: Array<{ id: string, styleId: string }> = []
  const rules = sourceRules.flatMap((rule, ruleIndex) => {
    if (priorityStyleIds.length + rule.targets.length > MAX_PROFILE_LAYERS) {
      warnings.push(`${rule.context} was omitted because the ${MAX_PROFILE_LAYERS}-layer profile limit was reached`)
      return []
    }
    const targets = rule.targets.map((target, targetIndex) => {
      const decorationId = JSON.stringify([ruleIndex, targetIndex, target.styleId])
      priorityStyleIds.push({ id: decorationId, styleId: target.styleId })
      return { ...target, decorationId }
    })
    return [{ ...rule, targets }]
  })
  return {
    priorityStyleIds,
    profileId: `${languageId}:${dark ? 'dark' : 'light'}`,
    rules,
    warnings,
  }
}

export function activate(context: ExtensionContext): void {
  let disposed = false
  let compiled = compileConfig(getConfiguration('vscode-highlight-text.rules', defaultConfig))
  let shouldProcess = getExcludeFilter()
  let initialManagerError: unknown
  let manager: DecorationManager
  const candidateManager = new DecorationManager(compiled.styles)
  try {
    for (const editor of window.visibleTextEditors) {
      if (!shouldProcess(editor.document.uri.path) || !editor.visibleRanges.length)
        continue
      const selection = getRuleSelection(compiled, editor.document)
      candidateManager.reserveProfile(editor, selection.profileId, selection.priorityStyleIds)
    }
    manager = candidateManager
  }
  catch (error) {
    candidateManager.dispose()
    initialManagerError = error
    compiled = { languages: new Map(), styles: new Map(), warnings: compiled.warnings }
    manager = new DecorationManager(new Map())
  }
  let ruleSnapshots = new WeakMap<TextEditor, Map<string, RuleSnapshot>>()
  let scanSessions = new WeakMap<TextEditor, ScanSession>()
  const executor = new RegexExecutor()
  const getExecutor = (_editor: TextEditor) => executor
  const failures = new RuleFailureRegistry<TextDocument>(REGEX_FAILURE_COOLDOWN)
  const warned = new BoundedSet<string>(MAX_REMEMBERED_WARNINGS)
  let warningToastCount = 0

  const warnOnce = (warning: string) => {
    if (disposed || !warned.add(warning))
      return
    if (warningToastCount >= 5)
      return
    warningToastCount++
    void window.showWarningMessage(`vscode-highlight-text: ${warning}`)
  }
  compiled.warnings.forEach(warnOnce)
  if (initialManagerError)
    warnOnce(`Failed to apply initial configuration: ${initialManagerError instanceof Error ? initialManagerError.message : String(initialManagerError)}`)

  let scheduleContinuation = (_editor: TextEditor) => {}

  const updateEditor = async (editor: TextEditor, task: LatestTaskContext) => {
    const document = editor.document
    const documentVersion = document.version
    const languageId = document.languageId
    const isCurrent = () => task.isCurrent()
      && !disposed
      && editor.document === document
      && document.version === documentVersion
      && document.languageId === languageId
      && !document.isClosed
      && window.visibleTextEditors.includes(editor)

    if (!isCurrent())
      return
    const clearEditor = () => {
      ruleSnapshots.delete(editor)
      scanSessions.delete(editor)
      manager.clear(editor)
    }
    if (!shouldProcess(document.uri.path) || !editor.visibleRanges.length) {
      if (isCurrent())
        clearEditor()
      return
    }
    const { priorityStyleIds, profileId, rules, warnings } = getRuleSelection(compiled, document)
    warnings.forEach(warnOnce)
    if (!rules.length) {
      if (isCurrent())
        clearEditor()
      return
    }

    const scanPlan = getScanSlices(editor)
    const previousSnapshots = ruleSnapshots.get(editor) ?? new Map<string, RuleSnapshot>()
    const canPreservePrevious = previousSnapshots.size > 0 && [...previousSnapshots.values()].every(
      snapshot => snapshot.documentVersion === documentVersion && snapshot.scanKey === scanPlan.scanKey,
    )
    const clearStaleSnapshot = () => {
      if (canPreservePrevious)
        return
      ruleSnapshots.delete(editor)
      manager.clear(editor)
    }
    if (!scanPlan.complete) {
      clearStaleSnapshot()
      warnOnce(`Visible scan exceeds ${MAX_SCAN_SIZE} characters in ${document.uri.fsPath}; stale highlights were cleared`)
      return
    }

    const sessionKey = JSON.stringify([documentVersion, scanPlan.scanKey, profileId])
    let session = scanSessions.get(editor)
    if (!session || session.key !== sessionKey) {
      session = {
        acceptedRangeKeys: new Set(),
        candidateKeys: new Set(),
        candidateSnapshot: new Map(),
        failedRuleIds: new Set(),
        key: sessionKey,
        nextRuleIndex: 0,
        nextSliceIndex: 0,
        previousSnapshots,
        scannedSnapshots: new Map(),
      }
      scanSessions.set(editor, session)
    }
    const budget = new RefreshBudget(MAX_TOTAL_RANGES, MAX_TOTAL_SCAN_TIME)
    for (let index = 0; index < session.acceptedRangeKeys.size; index++)
      budget.consumeRange()
    const executor = getExecutor(editor)
    let infrastructureFailed = false
    let needsContinuation = false

    while (session.nextRuleIndex < rules.length) {
      if (!isCurrent())
        return
      if (budget.timeExceeded) {
        needsContinuation = true
        break
      }
      if (budget.exhausted) {
        session.nextRuleIndex = rules.length
        break
      }
      const rule = rules[session.nextRuleIndex]
      if (failures.isDisabled(document, rule.id)) {
        session.failedRuleIds.add(rule.id)
        session.nextRuleIndex++
        session.nextSliceIndex = 0
        continue
      }

      let candidateExceeded = false
      let ruleFailed = false
      while (session.nextSliceIndex < scanPlan.slices.length) {
        if (!isCurrent())
          return
        if (budget.timeExceeded) {
          needsContinuation = true
          break
        }
        const slice = scanPlan.slices[session.nextSliceIndex]
        try {
          const matches = await scanRule(
            executor,
            rule,
            slice,
            task.signal,
            MAX_MATCHES_PER_RULE,
            MAX_TOTAL_RANGES,
            false,
          )
          if (!isCurrent())
            return
          for (const match of matches) {
            const rangeKey = `${match.styleId}:${match.start}-${match.end}`
            if (session.candidateKeys.has(rangeKey))
              continue
            if (session.candidateKeys.size >= MAX_TOTAL_RANGES) {
              candidateExceeded = true
              break
            }
            session.candidateKeys.add(rangeKey)
            const ranges = session.candidateSnapshot.get(match.styleId) ?? []
            ranges.push(new Range(document.positionAt(match.start), document.positionAt(match.end)))
            session.candidateSnapshot.set(match.styleId, ranges)
          }
          session.nextSliceIndex++
        }
        catch (error) {
          if (!isCurrent() || isRegexExecutionAbortedError(error))
            return
          ruleFailed = true
          const pattern = `/${rule.pattern.source}/${rule.pattern.flags}`
          if (isRegexExecutionInfrastructureError(error)) {
            infrastructureFailed = true
            warnOnce(`Regular expression worker is temporarily unavailable in ${document.uri.fsPath}: ${error.message}`)
          }
          else if (isRegexExecutionTimeoutError(error)) {
            session.failedRuleIds.add(rule.id)
            failures.recordFailure(document, rule.id)
            warnOnce(`${rule.context}: rule execution (including ignoreReg) for ${pattern} exceeded ${error.timeoutMs}ms in ${document.uri.fsPath}; will be retried on the next refresh after ${REGEX_FAILURE_COOLDOWN / 1000}s`)
          }
          else if (isRegexExecutionLimitError(error)) {
            session.failedRuleIds.add(rule.id)
            failures.recordFailure(document, rule.id)
            warnOnce(`${rule.context}: ${pattern} was skipped in ${document.uri.fsPath}: ${error.message}`)
          }
          else {
            session.failedRuleIds.add(rule.id)
            warnOnce(`${rule.context}: ${pattern} failed in ${document.uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`)
          }
          break
        }
        if (candidateExceeded)
          break
      }
      if (needsContinuation || infrastructureFailed)
        break
      if (!ruleFailed && !candidateExceeded && session.nextSliceIndex < scanPlan.slices.length)
        continue
      if (!ruleFailed) {
        if (candidateExceeded) {
          session.scannedSnapshots.set(rule.id, new Map())
          warnOnce(`${rule.context}: rule output was skipped in ${document.uri.fsPath}: it exceeds ${MAX_TOTAL_RANGES} unique ranges`)
        }
        else {
          const newKeys = [...session.candidateKeys].filter(key => !session.acceptedRangeKeys.has(key))
          if (newKeys.length > budget.remainingRanges) {
            session.scannedSnapshots.set(rule.id, new Map())
            warnOnce(`${rule.context}: rule output was skipped in ${document.uri.fsPath}: ${newKeys.length} ranges exceed the remaining refresh budget`)
          }
          else {
            for (const key of newKeys) {
              budget.consumeRange()
              session.acceptedRangeKeys.add(key)
            }
            session.scannedSnapshots.set(rule.id, session.candidateSnapshot)
          }
        }
      }
      session.candidateKeys = new Set()
      session.candidateSnapshot = new Map()
      session.nextSliceIndex = 0
      session.nextRuleIndex++
    }

    if (infrastructureFailed) {
      scanSessions.delete(editor)
      clearStaleSnapshot()
      return
    }
    if (needsContinuation) {
      clearStaleSnapshot()
      queueMicrotask(() => {
        if (isCurrent())
          scheduleContinuation(editor)
      })
      return
    }
    scanSessions.delete(editor)
    const { failedRuleIds, scannedSnapshots } = session
    if (isCurrent()) {
      const nextSnapshots = new Map<string, RuleSnapshot>()
      for (const rule of rules) {
        const previous = previousSnapshots.get(rule.id)
        const snapshot = failedRuleIds.has(rule.id)
          ? previous?.documentVersion === documentVersion && previous.scanKey === scanPlan.scanKey ? previous : undefined
          : { documentVersion, scanKey: scanPlan.scanKey, rangesByStyle: scannedSnapshots.get(rule.id) ?? new Map() }
        if (snapshot)
          nextSnapshots.set(rule.id, snapshot)
      }
      const rangesByStyle = aggregateSnapshots(
        [...nextSnapshots.values()].map(snapshot => snapshot.rangesByStyle),
        MAX_TOTAL_RANGES,
        (_styleId, range) => `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`,
      )
      if (!rangesByStyle) {
        clearStaleSnapshot()
        warnOnce(`Final highlight snapshot exceeded ${MAX_TOTAL_RANGES} ranges in ${document.uri.fsPath}; stale highlights were cleared when necessary`)
        return
      }
      ruleSnapshots.set(editor, nextSnapshots)
      manager.apply(editor, rangesByStyle, profileId, priorityStyleIds)
    }
  }

  const scheduler = new LatestTaskScheduler<TextEditor>(
    updateEditor,
    UPDATE_DELAY,
    error => warnOnce(error instanceof Error ? error.message : String(error)),
  )
  scheduleContinuation = editor => scheduler.schedule(editor, true)

  const refreshVisibleEditors = (immediate = true) => {
    const visible = new Set(window.visibleTextEditors)
    for (const editor of scheduler.keys) {
      if (!visible.has(editor)) {
        scheduler.remove(editor)
        ruleSnapshots.delete(editor)
        scanSessions.delete(editor)
        manager.clear(editor)
      }
    }
    window.visibleTextEditors.forEach(editor => scheduler.schedule(editor, immediate))
  }

  const refreshForTheme = () => {
    for (const editor of window.visibleTextEditors) {
      scheduler.invalidate(editor)
      manager.clear(editor)
    }
    ruleSnapshots = new WeakMap()
    refreshVisibleEditors(true)
  }

  context.subscriptions.push(
    workspace.onDidChangeTextDocument((event) => {
      for (const editor of window.visibleTextEditors) {
        if (editor.document === event.document && event.contentChanges.length)
          scheduler.schedule(editor)
      }
    }),
    workspace.onDidCloseTextDocument((document) => {
      failures.clearDocument(document)
      for (const editor of window.visibleTextEditors) {
        if (editor.document === document) {
          scheduler.invalidate(editor)
          ruleSnapshots.delete(editor)
          manager.clear(editor)
        }
      }
    }),
    workspace.onDidOpenTextDocument((document) => {
      for (const editor of window.visibleTextEditors) {
        if (editor.document === document)
          scheduler.schedule(editor, true)
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
      const rulesChanged = event.affectsConfiguration('vscode-highlight-text.rules')
      const excludeChanged = event.affectsConfiguration('vscode-highlight-text.exclude')
      if (!rulesChanged && !excludeChanged)
        return
      if (!rulesChanged) {
        shouldProcess = getExcludeFilter()
        window.visibleTextEditors.forEach(editor => scheduler.invalidate(editor))
        refreshVisibleEditors(true)
        return
      }
      const nextCompiled = compileConfig(getConfiguration('vscode-highlight-text.rules', defaultConfig))
      const nextFilter = excludeChanged ? getExcludeFilter() : shouldProcess
      let nextManager: DecorationManager | undefined
      try {
        nextManager = new DecorationManager(nextCompiled.styles)
        for (const editor of window.visibleTextEditors) {
          if (!nextFilter(editor.document.uri.path) || !editor.visibleRanges.length)
            continue
          const selection = getRuleSelection(nextCompiled, editor.document)
          nextManager.reserveProfile(editor, selection.profileId, selection.priorityStyleIds)
        }
      }
      catch (error) {
        nextManager?.dispose()
        warnOnce(`Failed to apply configuration: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      window.visibleTextEditors.forEach(editor => scheduler.invalidate(editor))
      const previousManager = manager
      manager = nextManager
      compiled = nextCompiled
      shouldProcess = nextFilter
      ruleSnapshots = new WeakMap()
      scanSessions = new WeakMap()
      failures.clear()
      executor.resetCache()
      warned.clear()
      warningToastCount = 0
      compiled.warnings.forEach(warnOnce)
      previousManager.dispose()
      refreshVisibleEditors(true)
    }),
    window.onDidChangeActiveColorTheme(() => refreshForTheme()),
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
