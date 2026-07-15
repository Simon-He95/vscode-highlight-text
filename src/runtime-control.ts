export function aggregateSnapshots<Value>(
  snapshots: Iterable<Map<string, Value[]>>,
  maxValues: number,
  getValueKey?: (styleId: string, value: Value) => string,
): Map<string, Value[]> | undefined {
  const aggregated = new Map<string, Value[]>()
  const seen = new Map<string, Set<string>>()
  let total = 0
  for (const snapshot of snapshots) {
    for (const [styleId, values] of snapshot) {
      const target = aggregated.get(styleId) ?? []
      const styleKeys = seen.get(styleId) ?? new Set<string>()
      for (const value of values) {
        const key = getValueKey?.(styleId, value)
        if (key !== undefined && styleKeys.has(key))
          continue
        total++
        if (total > maxValues)
          return
        target.push(value)
        if (key !== undefined)
          styleKeys.add(key)
      }
      aggregated.set(styleId, target)
      seen.set(styleId, styleKeys)
    }
  }
  return aggregated
}

export interface RuleFailureState {
  failedInputKey: string
  inputDisabledUntil: number
  recentTimeouts: number[]
}

export interface RuleFailureStatus {
  disabled: boolean
  retryAfterMs: number
}

export class BoundedSet<Value> {
  private readonly values = new Set<Value>()

  constructor(readonly capacity: number) {
    if (capacity < 1)
      throw new Error('BoundedSet capacity must be positive')
  }

  get size(): number {
    return this.values.size
  }

  add(value: Value): boolean {
    if (this.values.has(value))
      return false
    if (this.values.size >= this.capacity) {
      const oldest = this.values.values().next()
      if (!oldest.done)
        this.values.delete(oldest.value)
    }
    this.values.add(value)
    return true
  }

  clear(): void {
    this.values.clear()
  }
}

export class RuleFailureRegistry<DocumentKey extends object> {
  private entries = new WeakMap<DocumentKey, Map<string, RuleFailureState>>()

  constructor(
    readonly cooldownMs: number,
    private readonly now: () => number = () => Date.now(),
    readonly maxTimeoutsPerWindow = 3,
    readonly timeoutWindowMs = cooldownMs,
  ) {
    if (maxTimeoutsPerWindow < 1)
      throw new Error('Rule failure timeout limit must be positive')
  }

  getStatus(document: DocumentKey, ruleId: string, inputKey: string): RuleFailureStatus {
    const rules = this.entries.get(document)
    const state = rules?.get(ruleId)
    if (!state)
      return { disabled: false, retryAfterMs: 0 }
    const now = this.now()
    state.recentTimeouts = state.recentTimeouts.filter(timestamp => timestamp + this.timeoutWindowMs > now)
    const sameInputRetryAfter = state.failedInputKey === inputKey
      ? Math.max(0, state.inputDisabledUntil - now)
      : 0
    const circuitRetryAfter = state.recentTimeouts.length >= this.maxTimeoutsPerWindow
      ? Math.max(0, state.recentTimeouts[0] + this.timeoutWindowMs - now)
      : 0
    const retryAfterMs = Math.max(sameInputRetryAfter, circuitRetryAfter)
    if (!retryAfterMs && !state.recentTimeouts.length) {
      rules!.delete(ruleId)
      if (!rules!.size)
        this.entries.delete(document)
    }
    return { disabled: retryAfterMs > 0, retryAfterMs }
  }

  recordFailure(document: DocumentKey, ruleId: string, inputKey: string): RuleFailureStatus {
    const now = this.now()
    const rules = this.entries.get(document) ?? new Map<string, RuleFailureState>()
    const previous = rules.get(ruleId)
    const recentTimeouts = (previous?.recentTimeouts ?? [])
      .filter(timestamp => timestamp + this.timeoutWindowMs > now)
    recentTimeouts.push(now)
    const state = {
      failedInputKey: inputKey,
      inputDisabledUntil: now + this.cooldownMs,
      recentTimeouts,
    }
    rules.set(ruleId, state)
    this.entries.set(document, rules)
    return this.getStatus(document, ruleId, inputKey)
  }

  clearDocument(document: DocumentKey): void {
    this.entries.delete(document)
  }

  clear(): void {
    this.entries = new WeakMap()
  }
}

export class RefreshBudget {
  private ranges = 0
  private readonly startedAt: number

  constructor(
    readonly maxRanges: number,
    readonly maxDurationMs: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.startedAt = now()
  }

  get remainingRanges(): number {
    return Math.max(0, this.maxRanges - this.ranges)
  }

  get timeExceeded(): boolean {
    return this.now() - this.startedAt >= this.maxDurationMs
  }

  get exhausted(): boolean {
    return this.remainingRanges === 0 || this.timeExceeded
  }

  consumeRange(): boolean {
    if (this.exhausted)
      return false
    this.ranges++
    return true
  }
}
