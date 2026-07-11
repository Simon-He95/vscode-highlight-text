export interface RuleFailureState {
  disabledUntil: number
  failures: number
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
  ) {}

  isDisabled(document: DocumentKey, ruleId: string): boolean {
    const rules = this.entries.get(document)
    const state = rules?.get(ruleId)
    if (!state)
      return false
    if (state.disabledUntil > this.now())
      return true
    rules!.delete(ruleId)
    if (!rules!.size)
      this.entries.delete(document)
    return false
  }

  recordFailure(document: DocumentKey, ruleId: string): RuleFailureState {
    const rules = this.entries.get(document) ?? new Map<string, RuleFailureState>()
    const previous = rules.get(ruleId)
    const state = {
      disabledUntil: this.now() + this.cooldownMs,
      failures: (previous?.failures ?? 0) + 1,
    }
    rules.set(ruleId, state)
    this.entries.set(document, rules)
    return state
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
