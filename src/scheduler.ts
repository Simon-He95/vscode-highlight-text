export interface LatestTaskContext {
  generation: number
  isCurrent: () => boolean
  signal: AbortSignal
}

interface TaskState {
  controller?: AbortController
  dirty: boolean
  generation: number
  running: boolean
  timer?: ReturnType<typeof setTimeout>
}

export class LatestTaskScheduler<Key> {
  private disposed = false
  private readonly states = new Map<Key, TaskState>()

  constructor(
    private readonly runTask: (key: Key, context: LatestTaskContext) => Promise<void>,
    private readonly delay: number,
    private readonly onError?: (error: unknown) => void,
  ) {}

  get size(): number {
    return this.states.size
  }

  get keys(): IterableIterator<Key> {
    return this.states.keys()
  }

  schedule(key: Key, immediate = false): void {
    if (this.disposed)
      return

    const state = this.states.get(key) ?? {
      dirty: false,
      generation: 0,
      running: false,
    }
    this.states.set(key, state)
    this.invalidateState(state)
    if (!immediate)
      state.dirty = false

    const requestRun = () => {
      state.timer = undefined
      if (this.disposed || this.states.get(key) !== state)
        return
      state.dirty = true
      void this.runLatest(key, state)
    }

    if (immediate)
      requestRun()
    else
      state.timer = setTimeout(requestRun, this.delay)
  }

  invalidate(key: Key): void {
    const state = this.states.get(key)
    if (state)
      this.invalidateState(state)
  }

  remove(key: Key): void {
    const state = this.states.get(key)
    if (!state)
      return
    if (state.timer)
      clearTimeout(state.timer)
    state.controller?.abort()
    this.states.delete(key)
  }

  dispose(): void {
    if (this.disposed)
      return
    this.disposed = true
    for (const state of this.states.values()) {
      if (state.timer)
        clearTimeout(state.timer)
      state.controller?.abort()
    }
    this.states.clear()
  }

  private invalidateState(state: TaskState): void {
    state.generation++
    state.controller?.abort()
    if (state.timer)
      clearTimeout(state.timer)
    state.timer = undefined
  }

  private async runLatest(key: Key, state: TaskState): Promise<void> {
    if (state.running)
      return

    state.running = true
    try {
      while (state.dirty && !this.disposed && this.states.get(key) === state) {
        state.dirty = false
        const generation = state.generation
        const controller = new AbortController()
        state.controller = controller
        const context: LatestTaskContext = {
          generation,
          signal: controller.signal,
          isCurrent: () => !this.disposed
            && !controller.signal.aborted
            && this.states.get(key) === state
            && state.generation === generation,
        }
        try {
          await this.runTask(key, context)
        }
        catch (error) {
          if (!controller.signal.aborted)
            this.onError?.(error)
        }
        if (state.controller === controller)
          state.controller = undefined
      }
    }
    finally {
      state.running = false
    }
  }
}
