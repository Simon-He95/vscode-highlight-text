import type { ExtensionContext, TextDocument, TextEditor, Range as VscodeRange } from 'vscode'
import type { LatestTaskContext } from './scheduler'
import type { CompiledConfig, CompiledRule } from './type'
import { createSelect, getConfiguration, setConfiguration } from '@vscode-use/utils'
import { deepMerge } from 'lazy-js-utils'
import { ColorThemeKind, commands, Position, Range, window, workspace } from 'vscode'
import { compileConfig, createExcludeFilter, getRulesForLanguage } from './config'
import { DecorationManager } from './decorations'
import { isRegexExecutionAbortedError, isRegexExecutionBudgetError, isRegexExecutionInfrastructureError, isRegexExecutionLimitError, isRegexExecutionTimeoutError, RegexExecutor } from './regex-worker'
import { aggregateSnapshots, BoundedSet, RefreshBudget, RuleFailureRegistry } from './runtime-control'
import { LatestTaskScheduler } from './scheduler'
import templates from './template'

const MAX_SCAN_SIZE = 200_000
const MAX_MATCHES_PER_RULE = 1_000
const MAX_TOTAL_RANGES = 10_000
const MAX_TOTAL_SCAN_TIME = 1_000
const MAX_SESSION_SCAN_TIME = 5_000
const MAX_JOBS_PER_CHUNK = 25
const MAX_SESSION_JOBS = 1_000
const MAX_TIMEOUTS_PER_CHUNK = 3
const MAX_SESSION_CONTINUATIONS = 40
const MAX_PROFILE_LAYERS = 300
const REGEX_FAILURE_COOLDOWN = 30_000
const MAX_REMEMBERED_WARNINGS = 100
const OVERSCAN_LINES = 20
const MAX_VUE_LANGUAGE_DETECTION_SIZE = 300_000
const UPDATE_DELAY = 100

interface RuleSnapshot {
  documentVersion: number
  scanKey: string
  rangesByStyle: Map<string, VscodeRange[]>
}

interface ScanSession {
  acceptedRangeKeys: Set<string>
  candidateKeys: Set<string>
  candidateSnapshot: Map<string, VscodeRange[]>
  currentRuleMatchCount: number
  failedRuleIds: Set<string>
  continuationCount: number
  elapsedScanTime: number
  infrastructureRetryCount: number
  workerJobCount: number
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
  artificialEnd: boolean
  artificialStart: boolean
  coreEnd: number
  coreStart: number
  scanStart: number
  text: string
}

function getExecutionDuration(error: unknown): number {
  return error && typeof error === 'object' && 'executionMs' in error && typeof error.executionMs === 'number'
    ? error.executionMs
    : 0
}

function getDocumentPath(document: TextDocument): string {
  return document.uri.scheme === 'file' ? document.uri.fsPath : document.uri.path
}

function isDarkTheme(): boolean {
  return window.activeColorTheme.kind === ColorThemeKind.Dark
    || window.activeColorTheme.kind === ColorThemeKind.HighContrast
}

export function previousCodePointOffset(document: TextDocument, offset: number): number {
  if (offset <= 0)
    return 0
  const probeStart = Math.max(0, offset - 2)
  const probe = document.getText(new Range(document.positionAt(probeStart), document.positionAt(offset)))
  const last = probe.charCodeAt(probe.length - 1)
  const previous = probe.charCodeAt(probe.length - 2)
  return offset - (last >= 0xDC00 && last <= 0xDFFF && previous >= 0xD800 && previous <= 0xDBFF ? 2 : 1)
}

export function nextCodePointOffset(document: TextDocument, offset: number, documentEnd: number): number {
  if (offset >= documentEnd)
    return documentEnd
  const probeEnd = Math.min(documentEnd, offset + 2)
  const probe = document.getText(new Range(document.positionAt(offset), document.positionAt(probeEnd)))
  const first = probe.charCodeAt(0)
  const second = probe.charCodeAt(1)
  return offset + (first >= 0xD800 && first <= 0xDBFF && second >= 0xDC00 && second <= 0xDFFF ? 2 : 1)
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
    artificialStart: start > 0,
    artificialEnd: end < documentEnd,
    coreStart: start,
    coreEnd: end,
    scanStart: previousCodePointOffset(document, start),
    scanEnd: nextCodePointOffset(document, end, documentEnd),
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

export async function scanRule(
  executor: RegexExecutor,
  rule: CompiledRule,
  slice: ScanSlice,
  signal: AbortSignal,
  maxMatches: number,
  acceptedMatchOffset: number,
  maxSpans: number,
  refreshSpanBudget: boolean,
  executionTimeoutMs?: number,
): Promise<{ acceptedMatchCount: number, executionMs: number, ranges: Array<{ end: number, start: number, styleId: string }>, truncated: boolean }> {
  let executionMs = 0
  const matches = await executor.execute({
    acceptedMatchOffset,
    ignores: rule.ignores,
    includeFullSpan: true,
    maxMatches,
    maxSpans,
    refreshSpanBudget,
    pattern: rule.pattern,
    targetGroups: rule.targets.map(target => target.groupIndex),
    text: slice.text,
  }, signal, durationMs => executionMs = durationMs, executionTimeoutMs)

  let acceptedMatchCount = 0
  const ranges = matches.flatMap((match) => {
    if (
      !match.fullSpan
      || (slice.artificialStart && match.fullSpan[0] === 0)
      || (slice.artificialEnd && match.fullSpan[1] === slice.text.length)
    ) {
      return []
    }
    const matchRanges = match.spans.flatMap((span, index) => {
      if (!span)
        return []
      const start = slice.scanStart + span[0]
      const end = slice.scanStart + span[1]
      return start >= slice.coreStart && end <= slice.coreEnd
        ? [{ start, end, styleId: rule.targets[index].decorationId ?? rule.targets[index].styleId }]
        : []
    })
    if (matchRanges.length)
      acceptedMatchCount++
    return matchRanges
  })
  return { acceptedMatchCount, executionMs, ranges, truncated: matches.truncated === true }
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
    MAX_VUE_LANGUAGE_DETECTION_SIZE,
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

function buildRuleSelection(config: CompiledConfig, languageId: string, dark: boolean) {
  const warnings: string[] = []
  const sourceRules = getRulesForLanguage(config, languageId, dark, warnings)
  const priorityStyleIds: Array<{ id: string, styleId: string }> = []
  const layerIds = new Map<string, string>()
  const rules = sourceRules.flatMap((rule) => {
    const targetKeys = rule.targets.map((target, targetIndex) => JSON.stringify([rule.layerContextId, targetIndex, target.styleId]))
    const newLayerCount = new Set(targetKeys.filter(key => !layerIds.has(key))).size
    if (priorityStyleIds.length + newLayerCount > MAX_PROFILE_LAYERS) {
      warnings.push(`${rule.context} was omitted because the ${MAX_PROFILE_LAYERS}-layer profile limit was reached`)
      return []
    }
    const targets = rule.targets.map((target, targetIndex) => {
      const layerKey = targetKeys[targetIndex]
      let decorationId = layerIds.get(layerKey)
      if (!decorationId) {
        decorationId = `d${priorityStyleIds.length}`
        layerIds.set(layerKey, decorationId)
        priorityStyleIds.push({ id: decorationId, styleId: target.styleId })
      }
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

const ruleSelectionCache = new WeakMap<CompiledConfig, Map<string, ReturnType<typeof buildRuleSelection>>>()

function getRuleSelection(config: CompiledConfig, document: TextDocument) {
  const dark = isDarkTheme()
  const vueRules = document.languageId === 'vue' ? getRulesForLanguage(config, 'vue', dark) : []
  const vueTsxRules = document.languageId === 'vue' ? getRulesForLanguage(config, 'vuetsx', dark) : []
  const languageId = document.languageId === 'vue'
    && (vueRules.length !== vueTsxRules.length || vueRules.some((rule, index) => rule !== vueTsxRules[index]))
    ? getRuleLanguageId(document)
    : document.languageId
  const key = `${languageId}:${dark ? 'dark' : 'light'}`
  const cache = ruleSelectionCache.get(config) ?? new Map<string, ReturnType<typeof buildRuleSelection>>()
  ruleSelectionCache.set(config, cache)
  const cached = cache.get(key)
  if (cached)
    return cached
  const selection = buildRuleSelection(config, languageId, dark)
  cache.set(key, selection)
  return selection
}

export function activate(context: ExtensionContext): void {
  let disposed = false
  let compiled = compileConfig(getConfiguration('vscode-highlight-text.rules', {}))
  const initialExcludeWarnings: string[] = []
  let shouldProcess = getExcludeFilter(initialExcludeWarnings)
  const output = window.createOutputChannel('vscode-highlight-text')
  context.subscriptions.push(output)
  let initialManagerError: unknown
  let manager = new DecorationManager(compiled.styles)
  for (const editor of window.visibleTextEditors) {
    if (!shouldProcess(getDocumentPath(editor.document)) || !editor.visibleRanges.length)
      continue
    const selection = getRuleSelection(compiled, editor.document)
    try {
      manager.reserveProfile(editor, selection.profileId, selection.priorityStyleIds)
    }
    catch (error) {
      initialManagerError ??= error
      manager.releaseEditor(editor)
    }
  }
  let ruleSnapshots = new WeakMap<TextEditor, Map<string, RuleSnapshot>>()
  let scanSessions = new WeakMap<TextEditor, ScanSession>()
  let structuralFailures = new WeakMap<TextEditor, { key: string, ruleIds: Set<string> }>()
  const executor = new RegexExecutor()
  const getExecutor = (_editor: TextEditor) => executor
  const failures = new RuleFailureRegistry<TextDocument>(REGEX_FAILURE_COOLDOWN)
  const warned = new BoundedSet<string>(MAX_REMEMBERED_WARNINGS)
  let importantToastCount = 0
  let warningToastCount = 0

  const warnOnce = (warning: string, important = false) => {
    if (disposed || !warned.add(warning))
      return
    output.appendLine(`[${new Date().toISOString()}] ${warning}`)
    if (important ? importantToastCount >= 5 : warningToastCount >= 5)
      return
    if (important)
      importantToastCount++
    else
      warningToastCount++
    void window.showWarningMessage(`vscode-highlight-text: ${warning}`)
  }
  compiled.warnings.forEach(warning => warnOnce(warning))
  initialExcludeWarnings.forEach(warning => warnOnce(warning))
  if (initialManagerError)
    warnOnce(`Failed to apply initial configuration: ${initialManagerError instanceof Error ? initialManagerError.message : String(initialManagerError)}`, true)

  const retryTimers = new Map<TextEditor, ReturnType<typeof setTimeout>>()
  let scheduleContinuation = (_editor: TextEditor) => {}
  let restartSiblingEditors = (_editor: TextEditor, _document: TextDocument) => {}
  let scheduleInfrastructureRetry = (_editor: TextEditor, _delay: number, _isCurrent: () => boolean) => {}

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
      manager.releaseEditor(editor)
    }
    if (!shouldProcess(getDocumentPath(document)) || !editor.visibleRanges.length) {
      if (isCurrent())
        clearEditor()
      return
    }
    const { priorityStyleIds, profileId, rules, warnings } = getRuleSelection(compiled, document)
    warnings.forEach(warning => warnOnce(warning))
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
      manager.clearRanges(editor)
    }
    if (!scanPlan.complete) {
      clearStaleSnapshot()
      warnOnce(`Visible scan exceeds ${MAX_SCAN_SIZE} characters in ${document.uri.fsPath}; stale highlights were cleared`)
      return
    }

    const sessionKey = JSON.stringify([documentVersion, scanPlan.scanKey, profileId])
    let structuralFailure = structuralFailures.get(editor)
    if (!structuralFailure || structuralFailure.key !== sessionKey) {
      structuralFailure = { key: sessionKey, ruleIds: new Set() }
      structuralFailures.set(editor, structuralFailure)
    }
    let session = scanSessions.get(editor)
    if (!session || session.key !== sessionKey) {
      session = {
        acceptedRangeKeys: new Set(),
        candidateKeys: new Set(),
        candidateSnapshot: new Map(),
        currentRuleMatchCount: 0,
        continuationCount: 0,
        elapsedScanTime: 0,
        failedRuleIds: new Set(),
        infrastructureRetryCount: 0,
        workerJobCount: 0,
        key: sessionKey,
        nextRuleIndex: 0,
        nextSliceIndex: 0,
        previousSnapshots,
        scannedSnapshots: new Map(),
      }
      scanSessions.set(editor, session)
    }
    const budget = new RefreshBudget(MAX_TOTAL_RANGES, Number.POSITIVE_INFINITY)
    for (let index = 0; index < session.acceptedRangeKeys.size; index++)
      budget.consumeRange()
    const executor = getExecutor(editor)
    let infrastructureFailed = false
    let infrastructureRetryAfterMs = 5_000
    let needsContinuation = false
    let sessionLimitReached = false
    let chunkJobCount = 0
    let chunkExecutionMs = 0
    let chunkTimeoutCount = 0

    while (session.nextRuleIndex < rules.length) {
      if (!isCurrent())
        return
      if (chunkExecutionMs >= MAX_TOTAL_SCAN_TIME) {
        needsContinuation = true
        break
      }
      if (budget.exhausted) {
        const skipped = rules.length - session.nextRuleIndex
        for (let index = session.nextRuleIndex; index < rules.length; index++)
          session.failedRuleIds.add(rules[index].id)
        session.nextRuleIndex = rules.length
        warnOnce(`Highlight range budget was exhausted in ${document.uri.fsPath}; ${skipped} remaining rules were skipped`, true)
        break
      }
      const rule = rules[session.nextRuleIndex]
      if (failures.isDisabled(document, rule.id) || structuralFailure.ruleIds.has(rule.id)) {
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
        if (chunkExecutionMs >= MAX_TOTAL_SCAN_TIME) {
          needsContinuation = true
          break
        }
        const slice = scanPlan.slices[session.nextSliceIndex]
        if (
          session.elapsedScanTime >= MAX_SESSION_SCAN_TIME
          || session.workerJobCount >= MAX_SESSION_JOBS
        ) {
          sessionLimitReached = true
          break
        }
        if (chunkJobCount >= MAX_JOBS_PER_CHUNK || chunkTimeoutCount >= MAX_TIMEOUTS_PER_CHUNK) {
          needsContinuation = true
          break
        }
        const remainingChunkMs = MAX_TOTAL_SCAN_TIME - chunkExecutionMs
        const remainingSessionMs = MAX_SESSION_SCAN_TIME - session.elapsedScanTime
        const executionTimeoutMs = Math.max(1, Math.min(500, remainingChunkMs, remainingSessionMs))
        const budgetEndsSession = remainingSessionMs <= remainingChunkMs && remainingSessionMs < 500
        try {
          const scanResult = await scanRule(
            executor,
            rule,
            slice,
            task.signal,
            MAX_MATCHES_PER_RULE,
            session.currentRuleMatchCount,
            MAX_TOTAL_RANGES,
            false,
            executionTimeoutMs,
          )
          if (!isCurrent())
            return
          session.elapsedScanTime += scanResult.executionMs
          chunkExecutionMs += scanResult.executionMs
          session.workerJobCount++
          chunkJobCount++
          for (const match of scanResult.ranges) {
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
          session.currentRuleMatchCount += scanResult.acceptedMatchCount
          session.infrastructureRetryCount = 0
          if (scanResult.truncated) {
            session.nextSliceIndex = scanPlan.slices.length
            warnOnce(`${rule.context}: Main pattern exceeded ${MAX_MATCHES_PER_RULE} matches in ${document.uri.fsPath}; the first ${MAX_MATCHES_PER_RULE} matches were retained`)
          }
          else {
            session.nextSliceIndex++
          }
        }
        catch (error) {
          if (!isCurrent() || isRegexExecutionAbortedError(error))
            return
          const executionMs = getExecutionDuration(error)
          session.elapsedScanTime += executionMs
          chunkExecutionMs += executionMs
          session.workerJobCount++
          chunkJobCount++
          ruleFailed = true
          const pattern = `/${rule.pattern.source}/${rule.pattern.flags}`
          if (isRegexExecutionBudgetError(error)) {
            ruleFailed = false
            if (budgetEndsSession)
              sessionLimitReached = true
            else
              needsContinuation = true
          }
          else if (isRegexExecutionInfrastructureError(error)) {
            infrastructureFailed = true
            infrastructureRetryAfterMs = error.retryAfterMs
            warnOnce(`Regular expression worker is temporarily unavailable in ${document.uri.fsPath}: ${error.message}`, true)
          }
          else if (isRegexExecutionTimeoutError(error)) {
            chunkTimeoutCount++
            session.failedRuleIds.add(rule.id)
            failures.recordFailure(document, rule.id)
            restartSiblingEditors(editor, document)
            warnOnce(`${rule.context}: rule execution (including ignoreReg) for ${pattern} exceeded ${error.timeoutMs}ms in ${document.uri.fsPath}; will be retried on the next refresh after ${REGEX_FAILURE_COOLDOWN / 1000}s`, true)
          }
          else if (isRegexExecutionLimitError(error)) {
            session.failedRuleIds.add(rule.id)
            structuralFailure.ruleIds.add(rule.id)
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
      if (sessionLimitReached || needsContinuation || infrastructureFailed)
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
      session.currentRuleMatchCount = 0
      session.nextSliceIndex = 0
      session.nextRuleIndex++
    }

    if (sessionLimitReached) {
      for (let index = session.nextRuleIndex; index < rules.length; index++)
        session.failedRuleIds.add(rules[index].id)
      session.nextRuleIndex = rules.length
      session.nextSliceIndex = 0
      session.candidateKeys = new Set()
      session.candidateSnapshot = new Map()
      warnOnce(`Highlight scan session limit reached in ${document.uri.fsPath}; remaining rules were skipped`)
    }

    if (infrastructureFailed) {
      clearStaleSnapshot()
      session.infrastructureRetryCount++
      if (session.infrastructureRetryCount <= 3)
        scheduleInfrastructureRetry(editor, infrastructureRetryAfterMs, isCurrent)
      else
        scanSessions.delete(editor)
      return
    }
    if (needsContinuation) {
      session.continuationCount++
      if (session.continuationCount > MAX_SESSION_CONTINUATIONS) {
        for (let index = session.nextRuleIndex; index < rules.length; index++)
          session.failedRuleIds.add(rules[index].id)
        session.nextRuleIndex = rules.length
        warnOnce(`Highlight continuation limit reached in ${document.uri.fsPath}; remaining rules were skipped`)
      }
      else {
        clearStaleSnapshot()
        queueMicrotask(() => {
          if (isCurrent())
            scheduleContinuation(editor)
        })
        return
      }
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
        warnOnce(`Final highlight snapshot exceeded ${MAX_TOTAL_RANGES} ranges in ${document.uri.fsPath}; stale highlights were cleared when necessary`, true)
        return
      }
      ruleSnapshots.set(editor, nextSnapshots)
      manager.apply(editor, rangesByStyle, profileId, priorityStyleIds)
    }
  }

  const scheduler = new LatestTaskScheduler<TextEditor>(
    updateEditor,
    UPDATE_DELAY,
    error => warnOnce(error instanceof Error ? error.message : String(error), true),
  )
  scheduleContinuation = editor => scheduler.schedule(editor, true)
  restartSiblingEditors = (editor, document) => {
    for (const sibling of window.visibleTextEditors) {
      if (sibling !== editor && sibling.document === document)
        scheduler.schedule(sibling, true)
    }
  }
  scheduleInfrastructureRetry = (editor, delay, isCurrent) => {
    const previous = retryTimers.get(editor)
    if (previous)
      clearTimeout(previous)
    const timer = setTimeout(() => {
      retryTimers.delete(editor)
      if (isCurrent())
        scheduler.schedule(editor, true)
    }, Math.max(0, delay))
    retryTimers.set(editor, timer)
  }

  const refreshVisibleEditors = (immediate = true) => {
    const visible = new Set(window.visibleTextEditors)
    for (const editor of scheduler.keys) {
      if (!visible.has(editor)) {
        scheduler.remove(editor)
        const retryTimer = retryTimers.get(editor)
        if (retryTimer)
          clearTimeout(retryTimer)
        retryTimers.delete(editor)
        ruleSnapshots.delete(editor)
        scanSessions.delete(editor)
        manager.releaseEditor(editor)
      }
    }
    window.visibleTextEditors.forEach(editor => scheduler.schedule(editor, immediate))
  }

  const refreshForTheme = () => {
    for (const editor of window.visibleTextEditors) {
      scheduler.invalidate(editor)
      manager.releaseEditor(editor)
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
          manager.releaseEditor(editor)
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
        const excludeWarnings: string[] = []
        shouldProcess = getExcludeFilter(excludeWarnings)
        excludeWarnings.forEach(warning => warnOnce(warning))
        window.visibleTextEditors.forEach(editor => scheduler.invalidate(editor))
        refreshVisibleEditors(true)
        return
      }
      const nextCompiled = compileConfig(getConfiguration('vscode-highlight-text.rules', {}))
      const excludeWarnings: string[] = []
      const nextFilter = excludeChanged ? getExcludeFilter(excludeWarnings) : shouldProcess
      let nextManager: DecorationManager | undefined
      try {
        nextManager = new DecorationManager(nextCompiled.styles)
        for (const editor of window.visibleTextEditors) {
          if (!nextFilter(getDocumentPath(editor.document)) || !editor.visibleRanges.length)
            continue
          const selection = getRuleSelection(nextCompiled, editor.document)
          nextManager.reserveProfile(editor, selection.profileId, selection.priorityStyleIds)
        }
      }
      catch (error) {
        nextManager?.dispose()
        warnOnce(`Failed to apply configuration: ${error instanceof Error ? error.message : String(error)}`, true)
        return
      }
      window.visibleTextEditors.forEach(editor => scheduler.invalidate(editor))
      const previousManager = manager
      manager = nextManager
      compiled = nextCompiled
      shouldProcess = nextFilter
      ruleSnapshots = new WeakMap()
      scanSessions = new WeakMap()
      structuralFailures = new WeakMap()
      failures.clear()
      executor.resetCache()
      warned.clear()
      importantToastCount = 0
      warningToastCount = 0
      compiled.warnings.forEach(warning => warnOnce(warning))
      excludeWarnings.forEach(warning => warnOnce(warning))
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
        retryTimers.forEach(timer => clearTimeout(timer))
        retryTimers.clear()
        executor.dispose()
        manager.dispose()
      },
    },
  )

  refreshVisibleEditors()
}

export function deactivate(): void {}

function getExcludeFilter(warnings?: string[]): (path: string) => boolean {
  const value = getConfiguration('vscode-highlight-text.exclude', ['**/dist/**', '**/node_modules/**'])
  return createExcludeFilter(value, warnings)
}
