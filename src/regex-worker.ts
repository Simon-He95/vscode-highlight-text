import type { Worker as WorkerType } from 'node:worker_threads'
import type { CompiledPattern, MatchResult } from './type'
import { Worker } from 'node:worker_threads'

interface WorkerRequest {
  ignores: CompiledPattern[]
  maxMatches: number
  pattern: CompiledPattern
  targetGroups: Array<number | undefined>
  text: string
}

const WORKER_SOURCE = String.raw`
const { parentPort } = require('node:worker_threads')

function collect(regex, text, limit, onMatch) {
  regex.lastIndex = 0
  let count = 0
  let match
  while (count < limit && (match = regex.exec(text)) !== null) {
    onMatch(match)
    count++
    if (match.index === regex.lastIndex)
      regex.lastIndex++
  }
}

parentPort.on('message', ({ id, request }) => {
  try {
    const ignored = []
    for (const pattern of request.ignores) {
      const regex = new RegExp(pattern.source, pattern.flags)
      collect(regex, request.text, request.maxMatches, (match) => {
        const span = match.indices && match.indices[0]
        if (span)
          ignored.push(span)
      })
    }

    const regex = new RegExp(request.pattern.source, request.pattern.flags)
    const results = []
    collect(regex, request.text, request.maxMatches, (match) => {
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
        if (ignored.some(([start, end]) => span[0] < end && start < span[1]))
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

export class RegexExecutor {
  private disposed = false
  private nextId = 0
  private queue = Promise.resolve()
  private worker?: WorkerType

  constructor(private readonly timeoutMs = 500) {}

  execute(request: WorkerRequest): Promise<MatchResult[]> {
    if (this.disposed)
      return Promise.reject(new Error('Regular expression executor has been disposed'))
    const result = this.queue.then(() => this.run(request))
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  dispose(): void {
    this.disposed = true
    void this.worker?.terminate()
    this.worker = undefined
  }

  private createWorker(): WorkerType {
    const worker = new Worker(WORKER_SOURCE, { eval: true })
    worker.unref()
    worker.once('exit', () => {
      if (this.worker === worker)
        this.worker = undefined
    })
    this.worker = worker
    return worker
  }

  private run(request: WorkerRequest): Promise<MatchResult[]> {
    if (this.disposed)
      return Promise.reject(new Error('Regular expression executor has been disposed'))
    const worker = this.worker ?? this.createWorker()
    const id = ++this.nextId

    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>

      function cleanup() {
        clearTimeout(timer)
        worker.off('message', onMessage)
        worker.off('error', onError)
        worker.off('exit', onExit)
      }
      function fail(error: Error) {
        cleanup()
        reject(error)
      }
      function onError(error: Error) {
        fail(error)
      }
      function onExit() {
        fail(new Error('Regular expression worker stopped unexpectedly'))
      }
      function onMessage(message: { error?: string, id: number, results: MatchResult[] }) {
        if (message.id !== id)
          return
        cleanup()
        if (message.error)
          reject(new Error(message.error))
        else
          resolve(message.results)
      }

      timer = setTimeout(() => {
        cleanup()
        if (this.worker === worker)
          this.worker = undefined
        void worker.terminate()
        reject(new Error(`Regular expression execution exceeded ${this.timeoutMs}ms`))
      }, this.timeoutMs)

      worker.on('message', onMessage)
      worker.once('error', onError)
      worker.once('exit', onExit)
      worker.postMessage({ id, request })
    })
  }
}
