export interface RuleFailureState {
  disabledUntil: number
  failures: number
}

export class RuleFailureRegistry<DocumentKey extends object> {
  private entries = new WeakMap<DocumentKey, Map<string, RuleFailureState>>()

  constructor(
    readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
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

  get exhausted(): boolean {
    return this.remainingRanges === 0 || this.now() - this.startedAt >= this.maxDurationMs
  }

  consumeRange(): boolean {
    if (this.exhausted)
      return false
    this.ranges++
    return true
  }
}
