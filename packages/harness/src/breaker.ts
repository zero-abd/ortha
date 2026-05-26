// Per-provider circuit breaker. Opens after N consecutive failures; after a
// cooldown it half-opens (allows one probe). A success closes it. Keeps one slow
// or down provider from dragging every request into timeouts.
export type BreakerState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  readonly threshold?: number; // consecutive failures before opening
  readonly cooldownMs?: number; // time before a half-open probe is allowed
  readonly now?: () => number;
}

interface Entry {
  failures: number;
  state: BreakerState;
  openedAt: number;
}

export class CircuitBreaker {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.threshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  private entry(key: string): Entry {
    let e = this.entries.get(key);
    if (!e) {
      e = { failures: 0, state: "closed", openedAt: 0 };
      this.entries.set(key, e);
    }
    return e;
  }

  /** True if a call to `key` is allowed right now. */
  canRequest(key: string): boolean {
    const e = this.entry(key);
    if (e.state === "open" && this.now() - e.openedAt >= this.cooldownMs) {
      e.state = "half_open";
    }
    return e.state !== "open";
  }

  state(key: string): BreakerState {
    return this.entry(key).state;
  }

  recordSuccess(key: string): void {
    const e = this.entry(key);
    e.failures = 0;
    e.state = "closed";
  }

  recordFailure(key: string): void {
    const e = this.entry(key);
    e.failures += 1;
    if (e.state === "half_open" || e.failures >= this.threshold) {
      e.state = "open";
      e.openedAt = this.now();
    }
  }
}
