import type { Worker as WorkerType } from 'node:worker_threads'
import type { CompiledPattern, MatchResult } from './type'
import { Worker } from 'node:worker_threads'

export interface WorkerRequest {
  cacheGeneration?: number
  ignores: CompiledPattern[]
  maxMatches: number
  pattern: CompiledPattern
  targetGroups: Array<number | undefined>
  text: string
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
let cachedGeneration = -1

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
    onMatch(match)
    count++
    if (match.index === regex.lastIndex)
      regex.lastIndex = advanceStringIndex(text, regex.lastIndex, regex.unicode || regex.unicodeSets)
  }
  return { count, truncated: count === limit && regex.exec(text) !== null }
}

parentPort.on('message', ({ id, request }) => {
  try {
    if (request.text !== undefined) {
      cachedText = request.text
      ignoreCache = new Map()
    }
    if (request.cacheGeneration !== cachedGeneration) {
      cachedGeneration = request.cacheGeneration
      ignoreCache = new Map()
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
          if (span)
            ignored.push(span)
        })
        if (collected.truncated)
          throw new Error('Ignore pattern exceeded ' + maxIgnoreMatches + ' matches')
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
      if (ignoreCache.size >= 100) {
        const oldest = ignoreCache.keys().next()
        if (!oldest.done)
          ignoreCache.delete(oldest.value)
      }
      ignoreCache.set(ignoreKey, mergedIgnored)
    }
    let maskedText = ''
    let cursor = 0
    for (const [start, end] of mergedIgnored) {
      maskedText += text.slice(cursor, start) + ' '.repeat(end - start)
      cursor = end
    }
    maskedText += text.slice(cursor)

    const regex = new RegExp(request.pattern.source, request.pattern.flags)
    const results = []
    collect(regex, maskedText, request.maxMatches, (match) => {
      const spans = request.targetGroups.map((groupIndex) => {
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
      if (spans.some(Boolean))
        results.push({ spans })
    })
    parentPort.postMessage({ id, results })
  }
  catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
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

export function isRegexExecutionAbortedError(error: unknown): error is RegexExecutionAbortedError {
  return error instanceof RegexExecutionAbortedError
}

export function isRegexExecutionTimeoutError(error: unknown): error is RegexExecutionTimeoutError {
  return error instanceof RegexExecutionTimeoutError
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
    let onMessage: (message: { error?: string, id: number, results: MatchResult[] }) => void

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
    onMessage = (message: { error?: string, id: number, results: MatchResult[] }) => {
      if (message.id !== id)
        return
      finish(message.error ? new Error(message.error) : undefined, message.results)
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
