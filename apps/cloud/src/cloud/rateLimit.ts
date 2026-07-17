/**
 * In-memory token buckets for per-key rate limiting. Single-process by
 * design (Pitolet Cloud runs one node per deployment today); swap the
 * backing map for shared storage before scaling out.
 *
 * A bucket starts full at `capacity` and refills continuously at
 * `capacity / windowMs` — i.e. "capacity requests per window" with burst
 * up to `capacity`. The clock is injectable so tests can freeze time.
 */

export interface TokenBucketOptions {
  /** Burst size and per-window allowance (e.g. 60 = 60 req/min). */
  capacity: number;
  /** Refill window in ms (default 60s). */
  windowMs?: number;
  /** Injectable clock (default Date.now). */
  clock?: () => number;
  /** Bound on tracked keys — a stale sweep runs past this (default 10k). */
  maxKeys?: number;
}

interface Bucket {
  tokens: number;
  last: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly windowMs: number;
  private readonly clock: () => number;
  private readonly maxKeys: number;

  constructor(options: TokenBucketOptions) {
    if (options.capacity < 1) throw new Error('capacity must be >= 1');
    this.capacity = options.capacity;
    this.windowMs = options.windowMs ?? 60_000;
    this.clock = options.clock ?? Date.now;
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  /** Take one token for `key`; false = over the limit right now. */
  allow(key: string): boolean {
    const now = this.clock();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) {
        this.sweep(now);
        // A hostile stream of fresh keys can keep every bucket younger than
        // one window. Keep maxKeys a hard bound by dropping the oldest
        // remaining key before admitting another.
        if (this.buckets.size >= this.maxKeys) {
          let oldestKey: string | undefined;
          let oldestAt = Infinity;
          for (const [candidate, value] of this.buckets) {
            if (value.last < oldestAt) {
              oldestKey = candidate;
              oldestAt = value.last;
            }
          }
          if (oldestKey !== undefined) this.buckets.delete(oldestKey);
        }
      }
      bucket = { tokens: this.capacity, last: now };
      this.buckets.set(key, bucket);
    } else {
      const elapsed = now - bucket.last;
      if (elapsed > 0) {
        bucket.tokens = Math.min(
          this.capacity,
          bucket.tokens + (elapsed / this.windowMs) * this.capacity,
        );
        bucket.last = now;
      }
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Drop keys idle long enough to be fully refilled (memory bound). */
  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.last >= this.windowMs) this.buckets.delete(key);
    }
  }
}
