import type { Worker as WorkerType } from 'node:worker_threads'
import type { CompiledPattern, MatchResult } from './type'
import { Worker } from 'node:worker_threads'

export type WorkerMatchResults = MatchResult[] & { truncated?: boolean }

export interface WorkerRequest {
  acceptedIntervals?: Array<[number, number]>
  acceptedMatchOffset?: number
  artificialEnd?: boolean
  artificialStart?: boolean
  cacheGeneration?: number
  ignores: CompiledPattern[]
  includeFullSpan?: boolean
  maxMatches: number
  maxSpans?: number
  refreshSpanBudget?: boolean
  pattern: CompiledPattern
  targetGroups: Array<number | undefined>
  text: string
  textKey?: string
}

interface WorkerResponse {
  error?: string
  errorCode?: string
  finished?: boolean
  id: number
  results?: MatchResult[]
  started?: boolean
  truncated?: boolean
}

export interface RegexExecutionOptions {
  deadlineKind: 'regex-timeout' | 'scan-budget'
  timeoutMs: number
}

interface PendingJob {
  onAbort?: () => void
  deadlineKind: RegexExecutionOptions['deadlineKind']
  executionTimeoutMs: number
  onExecutionComplete?: (durationMs: number) => void
  reject: (error: Error) => void
  request: WorkerRequest
  resolve: (results: WorkerMatchResults) => void
  signal?: AbortSignal
}

const WORKER_SOURCE = String.raw`
const { parentPort } = require('node:worker_threads')
let textCache = new Map()
let cachedGeneration = -1
let cachedTextBytes = 0
let cachedIgnoreIntervalCount = 0
let cachedIgnoreBytes = 0
const MAX_IGNORE_INTERVALS = 10000
const MAX_CACHED_IGNORE_INTERVALS = 20000
const MAX_CACHED_BYTES = 4000000
const ESTIMATED_INTERVAL_BYTES = 16

function estimateIgnoreEntryBytes(key, intervals, maskedText) {
  return key.length * 2 + intervals.length * ESTIMATED_INTERVAL_BYTES + maskedText.length * 2
}

function deleteTextEntry(key) {
  const entry = textCache.get(key)
  if (!entry)
    return
  cachedTextBytes -= entry.text.length * 2
  cachedIgnoreIntervalCount -= entry.ignoreCacheIntervalCount
  cachedIgnoreBytes -= entry.ignoreCacheBytes
  textCache.delete(key)
}

function deleteOldestIgnoreEntry(targetEntry) {
  const entries = targetEntry ? [targetEntry] : textCache.values()
  for (const entry of entries) {
    const oldest = entry.ignoreCache.keys().next()
    if (oldest.done)
      continue
    const removed = entry.ignoreCache.get(oldest.value)
    entry.ignoreCacheIntervalCount -= removed.intervals.length
    entry.ignoreCacheBytes -= removed.estimatedBytes
    cachedIgnoreIntervalCount -= removed.intervals.length
    cachedIgnoreBytes -= removed.estimatedBytes
    entry.ignoreCache.delete(oldest.value)
    return true
  }
  return false
}

function advanceStringIndex(text, index, unicode) {
  if (!unicode)
    return index + 1
  const first = text.charCodeAt(index)
  if (first < 0xD800 || first > 0xDBFF || index + 1 >= text.length)
    return index + 1
  const second = text.charCodeAt(index + 1)
  return second >= 0xDC00 && second <= 0xDFFF ? index + 2 : index + 1
}

function collect(regex, text, limit, onMatch, maxRetries = 0, maxRawIterations = limit) {
  regex.lastIndex = 0
  let count = 0
  let retries = 0
  let rawIterations = 0
  let exhausted = false
  while (count < limit && retries <= maxRetries && rawIterations < maxRawIterations) {
    const match = regex.exec(text)
    if (match === null) {
      exhausted = true
      break
    }
    rawIterations++
    const outcome = onMatch(match)
    if (outcome === 'retry')
      retries++
    else if (outcome !== 'skip' && outcome !== 'advance')
      count++
    if (match.index === regex.lastIndex)
      regex.lastIndex = advanceStringIndex(text, regex.lastIndex, regex.unicode || regex.unicodeSets)
    if (outcome === false) {
      exhausted = true
      break
    }
  }
  const rawTruncated = !exhausted && rawIterations >= maxRawIterations
  return {
    count,
    rawTruncated,
    retryTruncated: !exhausted && retries > maxRetries,
    truncated: !exhausted && count >= limit,
  }
}

parentPort.on('message', ({ id, request, reset }) => {
  if (reset) {
    cachedGeneration = reset.cacheGeneration
    textCache = new Map()
    cachedTextBytes = 0
    cachedIgnoreIntervalCount = 0
    cachedIgnoreBytes = 0
    return
  }
  parentPort.postMessage({ id, started: true })
  try {
    if (request.cacheGeneration !== cachedGeneration) {
      cachedGeneration = request.cacheGeneration
      textCache = new Map()
      cachedTextBytes = 0
      cachedIgnoreIntervalCount = 0
      cachedIgnoreBytes = 0
    }
    const textKey = request.textKey || 'default'
    let entry = textCache.get(textKey)
    if (request.text !== undefined) {
      if (entry)
        deleteTextEntry(textKey)
      entry = { text: request.text, ignoreCache: new Map(), ignoreCacheIntervalCount: 0, ignoreCacheBytes: 0 }
      textCache.set(textKey, entry)
      cachedTextBytes += request.text.length * 2
      while (textCache.size > 4 || cachedTextBytes > MAX_CACHED_BYTES) {
        const oldest = textCache.keys().next()
        if (oldest.done || oldest.value === textKey && textCache.size === 1)
          break
        deleteTextEntry(oldest.value)
      }
      while (cachedTextBytes + cachedIgnoreBytes > MAX_CACHED_BYTES) {
        if (!deleteOldestIgnoreEntry())
          break
      }
    }
    if (!entry)
      throw new Error('Regular expression worker text is not initialized')
    textCache.delete(textKey)
    textCache.set(textKey, entry)
    const text = entry.text
    const ignoreCache = entry.ignoreCache
    const maxIgnoreMatches = Math.max(request.maxMatches, 1000)
    const ignoreKey = JSON.stringify([request.ignores, maxIgnoreMatches, request.artificialStart, request.artificialEnd])
    let ignoreEntry = ignoreCache.get(ignoreKey)
    if (!ignoreEntry) {
      const ignored = []
      for (const pattern of request.ignores) {
        const regex = new RegExp(pattern.source, pattern.flags)
        const collected = collect(regex, text, maxIgnoreMatches, (match) => {
          const span = match.indices && match.indices[0]
          if (
            span
            && !(request.artificialStart && span[0] === 0)
            && !(request.artificialEnd && span[1] === text.length)
          ) {
            if (ignored.length >= MAX_IGNORE_INTERVALS) {
              const error = new Error('Ignore patterns exceeded ' + MAX_IGNORE_INTERVALS + ' total intervals')
              error.code = 'IGNORE_LIMIT'
              throw error
            }
            ignored.push(span)
          }
        }, 0, maxIgnoreMatches + 1)
        if (collected.truncated || collected.rawTruncated)
          {
          const error = new Error('Ignore pattern exceeded ' + maxIgnoreMatches + ' matches')
          error.code = 'IGNORE_LIMIT'
          throw error
        }
      }

      ignored.sort((a, b) => a[0] - b[0] || a[1] - b[1])
      const mergedIgnored = []
      for (const span of ignored) {
        const previous = mergedIgnored[mergedIgnored.length - 1]
        if (previous && span[0] <= previous[1])
          previous[1] = Math.max(previous[1], span[1])
        else
          mergedIgnored.push([...span])
      }
      let maskedText = ''
      let cursor = 0
      for (const [start, end] of mergedIgnored) {
        const ignoredText = text.slice(start, end).replace(/[^\r\n\u2028\u2029]/g, ' ')
        maskedText += text.slice(cursor, start) + ignoredText
        cursor = end
      }
      maskedText += text.slice(cursor)
      while (ignoreCache.size >= 100) {
        if (!deleteOldestIgnoreEntry(entry))
          break
      }
      const estimatedBytes = estimateIgnoreEntryBytes(ignoreKey, mergedIgnored, maskedText)
      while (
        cachedIgnoreIntervalCount + mergedIgnored.length > MAX_CACHED_IGNORE_INTERVALS
        || cachedTextBytes + cachedIgnoreBytes + estimatedBytes > MAX_CACHED_BYTES
      ) {
        if (!deleteOldestIgnoreEntry())
          break
      }
      ignoreEntry = { estimatedBytes, intervals: mergedIgnored, maskedText }
      if (
        cachedIgnoreIntervalCount + mergedIgnored.length <= MAX_CACHED_IGNORE_INTERVALS
        && cachedTextBytes + cachedIgnoreBytes + estimatedBytes <= MAX_CACHED_BYTES
      ) {
        ignoreCache.set(ignoreKey, ignoreEntry)
        entry.ignoreCacheIntervalCount += mergedIgnored.length
        entry.ignoreCacheBytes += estimatedBytes
        cachedIgnoreIntervalCount += mergedIgnored.length
        cachedIgnoreBytes += estimatedBytes
      }
    }
    const mergedIgnored = ignoreEntry.intervals
    const maskedText = ignoreEntry.maskedText

    function findOverlappingIgnored(span) {
      let low = 0
      let high = mergedIgnored.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (mergedIgnored[middle][1] <= span[0])
          low = middle + 1
        else
          high = middle
      }
      const ignored = mergedIgnored[low]
      if (!ignored)
        return undefined
      const overlaps = span[0] === span[1]
        ? ignored[0] <= span[0] && span[0] < ignored[1]
        : span[0] < ignored[1] && ignored[0] < span[1]
      return overlaps ? ignored : undefined
    }

    function overlapsIgnored(span) {
      return findOverlappingIgnored(span) !== undefined
    }

    function getSpans(match) {
      return request.targetGroups.map((groupIndex) => {
        let index = groupIndex
        if (index === undefined) {
          if (match.length === 1) {
            const fullSpan = match.indices && match.indices[0]
            return fullSpan && fullSpan[0] !== fullSpan[1] ? fullSpan : undefined
          }
          for (let candidate = 1; candidate < match.length; candidate++) {
            const candidateSpan = match.indices && match.indices[candidate]
            if (candidateSpan)
              return candidateSpan[0] === candidateSpan[1] ? undefined : candidateSpan
          }
          return undefined
        }
        const span = match.indices && match.indices[index]
        if (!span || span[0] < 0 || span[0] === span[1])
          return undefined
        return span
      })
    }

    const hasIgnores = request.ignores.length > 0
    const regex = new RegExp(request.pattern.source, request.pattern.flags)
    const stickyFlags = request.pattern.flags.replace(/g/g, '').replace(/y/g, '') + 'y'
    const originalAtCandidate = hasIgnores ? new RegExp(request.pattern.source, stickyFlags) : undefined
    const originalSearch = hasIgnores ? new RegExp(request.pattern.source, request.pattern.flags) : undefined
    const preIntervalSearch = hasIgnores ? new RegExp(request.pattern.source, request.pattern.flags) : undefined
    const maxSpans = request.maxSpans ?? 10000
    let matchTruncated = false
    let spanCount = 0
    const results = []
    const rawMatchLimit = Math.max(request.maxMatches * 10, 10000)
    const maxRawIterations = 250000
    const collected = collect(regex, hasIgnores ? maskedText : text, rawMatchLimit, (match) => {
      const fullSpan = match.indices && match.indices[0]
      if (!fullSpan)
        return
      if (
        (request.artificialStart && fullSpan[0] === 0)
        || (request.artificialEnd && fullSpan[1] === text.length)
      ) {
        regex.lastIndex = advanceStringIndex(text, fullSpan[0], regex.unicode || regex.unicodeSets)
        return 'advance'
      }
      let acceptedFullSpan = fullSpan
      let acceptedSpans = getSpans(match)
      const overlapping = findOverlappingIgnored(fullSpan)
      if (originalAtCandidate) {
        originalAtCandidate.lastIndex = fullSpan[0]
        const originalMatch = originalAtCandidate.exec(text)
        const originalFullSpan = originalMatch && originalMatch.indices && originalMatch.indices[0]
        const originalSpans = originalMatch ? getSpans(originalMatch) : []
        if (
          originalFullSpan
          && !overlapsIgnored(originalFullSpan)
          && !originalSpans.some(span => span && overlapsIgnored(span))
        ) {
          acceptedFullSpan = originalFullSpan
          acceptedSpans = originalSpans
          regex.lastIndex = originalFullSpan[1]
        }
        else {
          const nextIndex = advanceStringIndex(text, fullSpan[0], regex.unicode || regex.unicodeSets)
          if (overlapping && fullSpan[0] < overlapping[0] && originalSearch) {
            originalSearch.lastIndex = nextIndex
            const alternative = originalSearch.exec(text)
            const alternativeSpan = alternative && alternative.indices && alternative.indices[0]
            if (alternativeSpan && alternativeSpan[1] <= overlapping[0]) {
              regex.lastIndex = alternativeSpan[0]
            }
            else if (preIntervalSearch) {
              const prefixText = text.slice(0, overlapping[0])
              preIntervalSearch.lastIndex = nextIndex
              let prefixStart
              for (let attempt = 0; attempt < 100; attempt++) {
                const prefixAlternative = preIntervalSearch.exec(prefixText)
                const prefixSpan = prefixAlternative && prefixAlternative.indices && prefixAlternative.indices[0]
                if (!prefixSpan)
                  break
                originalAtCandidate.lastIndex = prefixSpan[0]
                const verified = originalAtCandidate.exec(text)
                const verifiedSpan = verified && verified.indices && verified.indices[0]
                const verifiedSpans = verified ? getSpans(verified) : []
                if (
                  verifiedSpan
                  && verifiedSpan[1] <= overlapping[0]
                  && !overlapsIgnored(verifiedSpan)
                  && !verifiedSpans.some(span => span && overlapsIgnored(span))
                ) {
                  prefixStart = prefixSpan[0]
                  break
                }
                preIntervalSearch.lastIndex = advanceStringIndex(prefixText, prefixSpan[0], preIntervalSearch.unicode || preIntervalSearch.unicodeSets)
              }
              regex.lastIndex = prefixStart ?? overlapping[1]
            }
            else {
              regex.lastIndex = overlapping[1]
            }
          }
          else {
            regex.lastIndex = overlapping ? Math.max(overlapping[1], nextIndex) : nextIndex
          }
          return 'retry'
        }
      }
      else if (overlapping || acceptedSpans.some(span => span && overlapsIgnored(span))) {
        return
      }
      if (request.acceptedIntervals) {
        acceptedSpans = acceptedSpans.map(span => span && request.acceptedIntervals.some(
          interval => interval[0] <= span[0] && span[1] <= interval[1],
        ) ? span : undefined)
      }
      const validSpanCount = acceptedSpans.filter(Boolean).length
      if (!validSpanCount)
        return 'skip'
      if (spanCount + validSpanCount > maxSpans) {
        const error = new Error('Rule output exceeded the remaining ' + maxSpans + ' span budget')
        error.code = request.refreshSpanBudget ? 'REFRESH_BUDGET' : 'SPAN_BUDGET'
        throw error
      }
      if (validSpanCount) {
        if ((request.acceptedMatchOffset ?? 0) + results.length >= request.maxMatches) {
          matchTruncated = true
          return false
        }
        spanCount += validSpanCount
        results.push(request.includeFullSpan ? { fullSpan: acceptedFullSpan, spans: acceptedSpans } : { spans: acceptedSpans })
      }
    }, hasIgnores ? 10000 : 0, maxRawIterations)
    if (collected.rawTruncated) {
      const error = new Error('Main pattern exceeded ' + maxRawIterations + ' raw iterations')
      error.code = 'MATCH_LIMIT'
      throw error
    }
    if (collected.retryTruncated) {
      const error = new Error('Main pattern exceeded the masked retry budget')
      error.code = 'MATCH_LIMIT'
      throw error
    }
    if (collected.truncated) {
      const error = new Error('Main pattern exceeded ' + rawMatchLimit + ' raw matches')
      error.code = 'MATCH_LIMIT'
      throw error
    }
    parentPort.postMessage({ id, finished: true })
    parentPort.postMessage({ id, results, truncated: matchTruncated })
  }
  catch (error) {
    parentPort.postMessage({ id, finished: true })
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error), errorCode: error && error.code })
  }
})
`

export class RegexExecutionAbortedError extends Error {
  constructor(message = 'Regular expression execution was cancelled') {
    super(message)
    this.name = 'RegexExecutionAbortedError'
  }
}

export class RegexExecutionTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Regular expression execution exceeded ${timeoutMs}ms`)
    this.name = 'RegexExecutionTimeoutError'
  }
}

export class RegexExecutionBudgetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RegexExecutionBudgetError'
  }
}

export class RegexExecutionInfrastructureError extends Error {
  constructor(message: string, readonly retryAfterMs = 5_000) {
    super(message)
    this.name = 'RegexExecutionInfrastructureError'
  }
}

export class RegexExecutionLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RegexExecutionLimitError'
  }
}

export function isRegexExecutionAbortedError(error: unknown): error is RegexExecutionAbortedError {
  return error instanceof RegexExecutionAbortedError
}

export function isRegexExecutionTimeoutError(error: unknown): error is RegexExecutionTimeoutError {
  return error instanceof RegexExecutionTimeoutError
}

export function isRegexExecutionBudgetError(error: unknown): error is RegexExecutionBudgetError {
  return error instanceof RegexExecutionBudgetError
}

export function isRegexExecutionInfrastructureError(error: unknown): error is RegexExecutionInfrastructureError {
  return error instanceof RegexExecutionInfrastructureError
}

export function isRegexExecutionLimitError(error: unknown): error is RegexExecutionLimitError {
  return error instanceof RegexExecutionLimitError
}

export type WorkerFactory = () => WorkerType

export function createRegexWorker(): WorkerType {
  return new Worker(WORKER_SOURCE, { eval: true })
}

export class RegexExecutor {
  private active?: PendingJob
  private activeCancel?: (error: Error) => void
  private cacheGeneration = 0
  private disposed = false
  private infrastructureBlockedUntil = 0
  private nextId = 0
  private readonly pending: PendingJob[] = []
  private terminating?: Promise<void>
  private worker?: WorkerType
  private readonly workerTexts = new Map<string, number>()

  constructor(
    private readonly timeoutMs = 500,
    private readonly workerFactory: WorkerFactory = createRegexWorker,
  ) {}

  get pendingCount(): number {
    return this.pending.length + (this.active ? 1 : 0)
  }

  resetCache(): void {
    this.cacheGeneration++
    this.workerTexts.clear()
    try {
      this.worker?.postMessage({ reset: { cacheGeneration: this.cacheGeneration } })
    }
    catch {
      void this.worker?.terminate()
      this.worker = undefined
    }
  }

  execute(
    request: WorkerRequest,
    signal?: AbortSignal,
    onExecutionComplete?: (durationMs: number) => void,
    options: RegexExecutionOptions = { deadlineKind: 'regex-timeout', timeoutMs: this.timeoutMs },
  ): Promise<WorkerMatchResults> {
    if (this.disposed || signal?.aborted)
      return Promise.reject(new RegexExecutionAbortedError())
    if (Date.now() < this.infrastructureBlockedUntil)
      return Promise.reject(new RegexExecutionInfrastructureError('Regular expression worker is temporarily unavailable', this.infrastructureBlockedUntil - Date.now()))

    return new Promise((resolve, reject) => {
      const job: PendingJob = {
        deadlineKind: options.deadlineKind,
        executionTimeoutMs: options.timeoutMs,
        onExecutionComplete,
        request,
        resolve,
        reject,
        signal,
      }
      if (signal) {
        job.onAbort = () => this.cancel(job)
        signal.addEventListener('abort', job.onAbort, { once: true })
      }
      this.pending.push(job)
      this.drain()
    })
  }

  dispose(): void {
    if (this.disposed)
      return
    this.disposed = true
    this.activeCancel?.(new RegexExecutionAbortedError('Regular expression executor was disposed'))
    for (const job of this.pending.splice(0)) {
      this.removeAbortListener(job)
      job.reject(new RegexExecutionAbortedError('Regular expression executor was disposed'))
    }
    void this.worker?.terminate()
    this.worker = undefined
    this.workerTexts.clear()
  }

  private cancel(job: PendingJob): void {
    if (this.active === job) {
      this.activeCancel?.(new RegexExecutionAbortedError())
      return
    }
    const index = this.pending.indexOf(job)
    if (index < 0)
      return
    this.pending.splice(index, 1)
    this.removeAbortListener(job)
    job.reject(new RegexExecutionAbortedError())
  }

  private createWorker(): WorkerType {
    let worker: WorkerType | undefined
    try {
      worker = this.workerFactory()
      worker.unref()
      worker.on('error', () => {
        if (this.worker === worker) {
          this.worker = undefined
          this.workerTexts.clear()
        }
      })
      worker.on('exit', () => {
        if (this.worker === worker) {
          this.worker = undefined
          this.workerTexts.clear()
        }
      })
      this.workerTexts.clear()
      this.worker = worker
      return worker
    }
    catch (error) {
      void worker?.terminate()
      throw error
    }
  }

  private drain(): void {
    if (this.disposed || this.active)
      return
    if (this.terminating) {
      void this.terminating.finally(() => this.drain())
      return
    }
    if (Date.now() < this.infrastructureBlockedUntil) {
      const error = new RegexExecutionInfrastructureError('Regular expression worker is temporarily unavailable', this.infrastructureBlockedUntil - Date.now())
      for (const job of this.pending.splice(0)) {
        this.removeAbortListener(job)
        job.reject(error)
      }
      return
    }
    const job = this.pending.shift()
    if (!job)
      return
    if (job.signal?.aborted) {
      this.removeAbortListener(job)
      job.reject(new RegexExecutionAbortedError())
      this.drain()
      return
    }
    this.active = job
    try {
      this.run(job)
    }
    catch (error) {
      this.removeAbortListener(job)
      this.active = undefined
      this.activeCancel = undefined
      this.worker = undefined
      this.workerTexts.clear()
      this.blockInfrastructure()
      job.reject(new RegexExecutionInfrastructureError(error instanceof Error ? error.message : String(error)))
      queueMicrotask(() => this.drain())
    }
  }

  private removeAbortListener(job: PendingJob): void {
    if (job.signal && job.onAbort)
      job.signal.removeEventListener('abort', job.onAbort)
  }

  private run(job: PendingJob): void {
    const worker = this.worker ?? this.createWorker()
    const id = ++this.nextId
    let settled = false
    let executionFinishedAt: number | undefined
    let executionStartedAt: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let onError: (error: Error) => void
    let onExit: () => void
    let onMessage: (message: WorkerResponse) => void

    const cleanup = () => {
      if (timer)
        clearTimeout(timer)
      worker.off('message', onMessage)
      worker.off('error', onError)
      worker.off('exit', onExit)
      this.removeAbortListener(job)
      this.activeCancel = undefined
      if (this.active === job)
        this.active = undefined
    }
    const finish = (error?: Error, results?: MatchResult[], terminate = false) => {
      if (settled)
        return
      settled = true
      cleanup()
      if (executionStartedAt !== undefined) {
        const executionMs = (executionFinishedAt ?? Date.now()) - executionStartedAt
        if (error)
          Object.defineProperty(error, 'executionMs', { configurable: true, value: executionMs })
        try {
          job.onExecutionComplete?.(executionMs)
        }
        catch {
          // Instrumentation callbacks must not affect executor settlement.
        }
      }
      if (terminate) {
        if (this.worker === worker) {
          this.worker = undefined
          this.workerTexts.clear()
        }
        const termination = Promise.resolve().then(async () => {
          await worker.terminate()
        }).catch(() => {})
        this.terminating = termination
        if (error)
          job.reject(error)
        else
          job.resolve(results ?? [])
        void termination.finally(() => {
          if (this.terminating === termination)
            this.terminating = undefined
          this.drain()
        })
        return
      }
      if (error)
        job.reject(error)
      else
        job.resolve(results ?? [])
      this.drain()
    }
    onError = (error: Error) => {
      this.blockInfrastructure()
      finish(new RegexExecutionInfrastructureError(error.message), undefined, true)
    }
    onExit = () => {
      this.blockInfrastructure()
      finish(new RegexExecutionInfrastructureError('Regular expression worker stopped unexpectedly'), undefined, true)
    }
    onMessage = (message: WorkerResponse) => {
      if (message.id !== id)
        return
      if (message.started) {
        if (executionStartedAt !== undefined)
          return
        if (timer)
          clearTimeout(timer)
        executionStartedAt = Date.now()
        timer = setTimeout(() => {
          const error = job.deadlineKind === 'scan-budget'
            ? new RegexExecutionBudgetError(`Regular expression execution exceeded the remaining ${job.executionTimeoutMs}ms scan budget`)
            : new RegexExecutionTimeoutError(job.executionTimeoutMs)
          finish(error, undefined, true)
        }, job.executionTimeoutMs)
        return
      }
      if (message.finished) {
        executionFinishedAt = Date.now()
        if (timer)
          clearTimeout(timer)
        timer = setTimeout(() => {
          this.blockInfrastructure()
          finish(new RegexExecutionInfrastructureError('Regular expression worker result transfer timed out'), undefined, true)
        }, 5_000)
        return
      }
      if (executionStartedAt === undefined) {
        executionStartedAt = Date.now()
        executionFinishedAt = executionStartedAt
      }
      const results = message.results ?? []
      if (message.truncated)
        Object.defineProperty(results, 'truncated', { value: true })
      const error = message.error
        ? message.errorCode === 'REFRESH_BUDGET'
          ? new RegexExecutionBudgetError(message.error)
          : message.errorCode === 'IGNORE_LIMIT' || message.errorCode === 'MATCH_LIMIT' || message.errorCode === 'SPAN_BUDGET'
            ? new RegexExecutionLimitError(message.error)
            : new Error(message.error)
        : undefined
      finish(error, results)
    }

    this.activeCancel = error => finish(error, undefined, true)
    timer = setTimeout(() => {
      this.blockInfrastructure()
      finish(new RegexExecutionInfrastructureError('Regular expression worker did not start in time'), undefined, true)
    }, 5_000)
    worker.on('message', onMessage)
    worker.once('error', onError)
    worker.once('exit', onExit)
    try {
      const { text, ...rest } = job.request
      const textKey = job.request.textKey ?? text
      const known = this.workerTexts.has(textKey)
      const request = known
        ? { ...rest, cacheGeneration: this.cacheGeneration, textKey }
        : { ...job.request, cacheGeneration: this.cacheGeneration, textKey }
      worker.postMessage({ id, request })
      this.workerTexts.delete(textKey)
      this.workerTexts.set(textKey, text.length)
      let cachedUnits = [...this.workerTexts.values()].reduce((total, length) => total + length, 0)
      while (this.workerTexts.size > 4 || cachedUnits > 2_000_000) {
        const oldest = this.workerTexts.keys().next()
        if (oldest.done || (oldest.value === textKey && this.workerTexts.size === 1))
          break
        cachedUnits -= this.workerTexts.get(oldest.value) ?? 0
        this.workerTexts.delete(oldest.value)
      }
    }
    catch (error) {
      this.blockInfrastructure()
      finish(new RegexExecutionInfrastructureError(error instanceof Error ? error.message : String(error)), undefined, true)
    }
  }

  private blockInfrastructure(): void {
    this.infrastructureBlockedUntil = Date.now() + 5_000
  }
}
