import type { Worker as WorkerType } from 'node:worker_threads'
import type { CompiledPattern, MatchResult } from './type'
import { Worker } from 'node:worker_threads'

export interface WorkerRequest {
  cacheGeneration?: number
  ignores: CompiledPattern[]
  maxMatches: number
  maxSpans?: number
  refreshSpanBudget?: boolean
  pattern: CompiledPattern
  targetGroups: Array<number | undefined>
  text: string
}

interface WorkerResponse {
  error?: string
  errorCode?: string
  id: number
  results: MatchResult[]
}

interface PendingJob {
  onAbort?: () => void
  reject: (error: Error) => void
  request: WorkerRequest
  resolve: (results: MatchResult[]) => void
  signal?: AbortSignal
}

const WORKER_SOURCE = String.raw`
const { parentPort } = require('node:worker_threads')
let cachedText
let ignoreCache = new Map()
let ignoreCacheIntervalCount = 0
let cachedGeneration = -1
const MAX_IGNORE_INTERVALS = 10000
const MAX_CACHED_IGNORE_INTERVALS = 20000

function advanceStringIndex(text, index, unicode) {
  if (!unicode)
    return index + 1
  const first = text.charCodeAt(index)
  if (first < 0xD800 || first > 0xDBFF || index + 1 >= text.length)
    return index + 1
  const second = text.charCodeAt(index + 1)
  return second >= 0xDC00 && second <= 0xDFFF ? index + 2 : index + 1
}

function collect(regex, text, limit, onMatch) {
  regex.lastIndex = 0
  let count = 0
  let match
  while (count < limit && (match = regex.exec(text)) !== null) {
    const shouldContinue = onMatch(match)
    count++
    if (match.index === regex.lastIndex)
      regex.lastIndex = advanceStringIndex(text, regex.lastIndex, regex.unicode || regex.unicodeSets)
    if (shouldContinue === false)
      break
  }
  return { count, truncated: count === limit && regex.exec(text) !== null }
}

parentPort.on('message', ({ id, request }) => {
  try {
    if (request.text !== undefined) {
      cachedText = request.text
      ignoreCache = new Map()
      ignoreCacheIntervalCount = 0
    }
    if (request.cacheGeneration !== cachedGeneration) {
      cachedGeneration = request.cacheGeneration
      ignoreCache = new Map()
      ignoreCacheIntervalCount = 0
    }
    if (cachedText === undefined)
      throw new Error('Regular expression worker text is not initialized')
    const text = cachedText
    const maxIgnoreMatches = Math.max(request.maxMatches, 1000)
    const ignoreKey = JSON.stringify([request.ignores, maxIgnoreMatches])
    let mergedIgnored = ignoreCache.get(ignoreKey)
    if (!mergedIgnored) {
      const ignored = []
      for (const pattern of request.ignores) {
        const regex = new RegExp(pattern.source, pattern.flags)
        const collected = collect(regex, text, maxIgnoreMatches, (match) => {
          const span = match.indices && match.indices[0]
          if (span) {
            if (ignored.length >= MAX_IGNORE_INTERVALS) {
              const error = new Error('Ignore patterns exceeded ' + MAX_IGNORE_INTERVALS + ' total intervals')
              error.code = 'IGNORE_LIMIT'
              throw error
            }
            ignored.push(span)
          }
        })
        if (collected.truncated)
          {
          const error = new Error('Ignore pattern exceeded ' + maxIgnoreMatches + ' matches')
          error.code = 'IGNORE_LIMIT'
          throw error
        }
      }

      ignored.sort((a, b) => a[0] - b[0] || a[1] - b[1])
      mergedIgnored = []
      for (const span of ignored) {
        const previous = mergedIgnored[mergedIgnored.length - 1]
        if (previous && span[0] <= previous[1])
          previous[1] = Math.max(previous[1], span[1])
        else
          mergedIgnored.push([...span])
      }
      while (ignoreCache.size && (ignoreCache.size >= 100 || ignoreCacheIntervalCount + mergedIgnored.length > MAX_CACHED_IGNORE_INTERVALS)) {
        const oldest = ignoreCache.keys().next()
        if (oldest.done)
          break
        ignoreCacheIntervalCount -= ignoreCache.get(oldest.value).length
        ignoreCache.delete(oldest.value)
      }
      ignoreCache.set(ignoreKey, mergedIgnored)
      ignoreCacheIntervalCount += mergedIgnored.length
    }
    let maskedText = ''
    let cursor = 0
    for (const [start, end] of mergedIgnored) {
      const ignoredText = text.slice(start, end).replace(/[^\r\n]/g, ' ')
      maskedText += text.slice(cursor, start) + ignoredText
      cursor = end
    }
    maskedText += text.slice(cursor)

    function overlapsIgnored(span) {
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
        return false
      if (span[0] === span[1])
        return ignored[0] <= span[0] && span[0] < ignored[1]
      return span[0] < ignored[1] && ignored[0] < span[1]
    }

    function getSpans(match) {
      return request.targetGroups.map((groupIndex) => {
        let index = groupIndex
        if (index === undefined) {
          index = 0
          for (let candidate = 1; candidate < match.length; candidate++) {
            if (match.indices && match.indices[candidate]) {
              index = candidate
              break
            }
          }
        }
        const span = match.indices && match.indices[index]
        if (!span || span[0] < 0)
          return undefined
        return span
      })
    }

    function matchKey(fullSpan, spans) {
      return fullSpan.join(':') + '|' + spans.map(span => span ? span.join(':') : '-').join(',')
    }

    const hasIgnores = request.ignores.length > 0
    const regex = new RegExp(request.pattern.source, request.pattern.flags)
    const stickyFlags = request.pattern.flags.replace(/g/g, '').replace(/y/g, '') + 'y'
    const originalAtCandidate = hasIgnores ? new RegExp(request.pattern.source, stickyFlags) : undefined
    const maxSpans = request.maxSpans ?? 10000
    let spanCount = 0
    const results = []
    const collected = collect(regex, hasIgnores ? maskedText : text, request.maxMatches, (match) => {
      const fullSpan = match.indices && match.indices[0]
      if (!fullSpan)
        return
      const spans = getSpans(match)
      if (overlapsIgnored(fullSpan) || spans.some(span => span && overlapsIgnored(span)))
        return
      if (originalAtCandidate) {
        originalAtCandidate.lastIndex = fullSpan[0]
        const originalMatch = originalAtCandidate.exec(text)
        if (!originalMatch)
          return
        const originalFullSpan = originalMatch.indices && originalMatch.indices[0]
        if (!originalFullSpan || matchKey(originalFullSpan, getSpans(originalMatch)) !== matchKey(fullSpan, spans))
          return
      }
      const validSpanCount = spans.filter(Boolean).length
      if (spanCount + validSpanCount > maxSpans) {
        const error = new Error('Rule output exceeded the remaining ' + maxSpans + ' span budget')
        error.code = request.refreshSpanBudget ? 'REFRESH_BUDGET' : 'SPAN_BUDGET'
        throw error
      }
      if (validSpanCount) {
        spanCount += validSpanCount
        results.push({ spans })
      }
    })
    if (collected.truncated) {
      const error = new Error('Main pattern exceeded ' + request.maxMatches + ' matches')
      error.code = 'MATCH_LIMIT'
      throw error
    }
    parentPort.postMessage({ id, results })
  }
  catch (error) {
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
  private nextId = 0
  private readonly pending: PendingJob[] = []
  private worker?: WorkerType
  private workerText?: string

  constructor(
    private readonly timeoutMs = 500,
    private readonly workerFactory: WorkerFactory = createRegexWorker,
  ) {}

  get pendingCount(): number {
    return this.pending.length + (this.active ? 1 : 0)
  }

  resetCache(): void {
    this.cacheGeneration++
  }

  execute(request: WorkerRequest, signal?: AbortSignal): Promise<MatchResult[]> {
    if (this.disposed || signal?.aborted)
      return Promise.reject(new RegexExecutionAbortedError())

    return new Promise((resolve, reject) => {
      const job: PendingJob = { request, resolve, reject, signal }
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
    this.workerText = undefined
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
          this.workerText = undefined
        }
      })
      worker.on('exit', () => {
        if (this.worker === worker) {
          this.worker = undefined
          this.workerText = undefined
        }
      })
      this.workerText = undefined
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
      this.workerText = undefined
      job.reject(error instanceof Error ? error : new Error(String(error)))
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
    let timer: ReturnType<typeof setTimeout>
    let onError: (error: Error) => void
    let onExit: () => void
    let onMessage: (message: WorkerResponse) => void

    const cleanup = () => {
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
      if (terminate) {
        if (this.worker === worker) {
          this.worker = undefined
          this.workerText = undefined
        }
        void worker.terminate()
      }
      if (error)
        job.reject(error)
      else
        job.resolve(results ?? [])
      this.drain()
    }
    onError = (error: Error) => finish(error, undefined, true)
    onExit = () => finish(new Error('Regular expression worker stopped unexpectedly'), undefined, true)
    onMessage = (message: WorkerResponse) => {
      if (message.id !== id)
        return
      const error = message.error
        ? message.errorCode === 'REFRESH_BUDGET'
          ? new RegexExecutionBudgetError(message.error)
          : message.errorCode === 'IGNORE_LIMIT' || message.errorCode === 'MATCH_LIMIT' || message.errorCode === 'SPAN_BUDGET'
            ? new RegexExecutionLimitError(message.error)
            : new Error(message.error)
        : undefined
      finish(error, message.results)
    }

    this.activeCancel = error => finish(error, undefined, true)
    timer = setTimeout(
      () => finish(new RegexExecutionTimeoutError(this.timeoutMs), undefined, true),
      this.timeoutMs,
    )
    worker.on('message', onMessage)
    worker.once('error', onError)
    worker.once('exit', onExit)
    try {
      const { text, ...rest } = job.request
      const request = this.workerText === text
        ? { ...rest, cacheGeneration: this.cacheGeneration }
        : { ...job.request, cacheGeneration: this.cacheGeneration }
      worker.postMessage({ id, request })
      this.workerText = text
    }
    catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)), undefined, true)
    }
  }
}
