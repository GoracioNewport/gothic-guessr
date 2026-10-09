/**
 * In-memory rate limiting (SPEC §10.9): a token bucket per key with an injected clock. Pure: no timers. The bucket
 * map is kept in least-recently-used order and bounded by `maxKeys`: when it grows past that, refilled buckets and,
 * if still needed, the least recently used ones are dropped from the front (amortised O(1) per `take`).
 *
 * Limits in use (see {@link RATE_LIMITS}; "per IP" = per client key of core/ip.ts, an IPv6 /64 counts as one):
 * player creation 10/h per IP, solo games 20/10 min per token, node lookups 10/s per token, guesses 2/s per token,
 * hits 60/min per IP, admin login 5/15 min per IP, room code misses (unknown codes, REST and WebSocket) 30/10 min per
 * IP. Rooms keep their own limiters (server/rooms/registry.ts, hub.ts).
 */

export interface RateLimitRule {
  /** Burst size = tokens available on an idle key. */
  limit: number;
  /** Time in which `limit` tokens refill, ms. */
  windowMs: number;
}

export const RATE_LIMITS = {
  createPlayer: { limit: 10, windowMs: 60 * 60_000 },
  createSolo: { limit: 20, windowMs: 10 * 60_000 },
  nodeLookup: { limit: 10, windowMs: 1_000 },
  guess: { limit: 2, windowMs: 1_000 },
  hits: { limit: 60, windowMs: 60_000 },
  adminLogin: { limit: 5, windowMs: 15 * 60_000 },
  roomMiss: { limit: 30, windowMs: 10 * 60_000 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof RATE_LIMITS;

export interface RateDecision {
  ok: boolean;
  /** When refused: ms until one token is available again. */
  retryAfterMs: number;
}

interface Bucket {
  tokens: number;
  at: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    readonly rule: RateLimitRule,
    private readonly maxKeys = 50_000,
  ) {}

  /** Try to take one token for `key` at time `now` (epoch ms). */
  take(key: string, now: number): RateDecision {
    const tokens = this.tokens(key, now);
    // Delete + set moves the key to the end: the map stays in least-recently-used order.
    this.buckets.delete(key);
    if (tokens >= 1) {
      this.buckets.set(key, { tokens: tokens - 1, at: now });
      this.evict(now);
      return { ok: true, retryAfterMs: 0 };
    }
    this.buckets.set(key, { tokens, at: now });
    this.evict(now);
    return { ok: false, retryAfterMs: this.retryAfter(tokens) };
  }

  /** What {@link take} would decide, without taking a token or touching the bucket. */
  peek(key: string, now: number): RateDecision {
    const tokens = this.tokens(key, now);
    return tokens >= 1 ? { ok: true, retryAfterMs: 0 } : { ok: false, retryAfterMs: this.retryAfter(tokens) };
  }

  /** Forget a key (e.g. after a successful admin login). */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** Drop buckets that have fully refilled (they behave like absent ones). */
  prune(now: number): void {
    for (const [key, b] of this.buckets) {
      if (now - b.at >= this.rule.windowMs) this.buckets.delete(key);
    }
  }

  private tokens(key: string, now: number): number {
    const { limit, windowMs } = this.rule;
    const bucket = this.buckets.get(key);
    if (!bucket) return limit;
    return Math.min(limit, bucket.tokens + Math.max(0, now - bucket.at) * (limit / windowMs));
  }

  private retryAfter(tokens: number): number {
    return Math.ceil((1 - tokens) / (this.rule.limit / this.rule.windowMs));
  }

  /**
   * Keep at most `maxKeys` buckets. Walks from the least recently used end and stops at the first bucket that is
   * both needed (the map is within bounds) and not yet refilled, so each call does work proportional to what it
   * frees. Dropping a bucket that is not refilled forgives that key's debt; it only happens to the oldest keys
   * while more than `maxKeys` distinct keys are active within one window.
   */
  private evict(now: number): void {
    if (this.buckets.size <= this.maxKeys) return;
    for (const [key, b] of this.buckets) {
      if (this.buckets.size <= this.maxKeys && now - b.at < this.rule.windowMs) break;
      this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

/**
 * One limiter per named rule; `check` throws nothing, it returns the decision. Rules not given fall back to
 * {@link RATE_LIMITS}.
 */
export class RateLimits {
  private readonly limiters = new Map<RateLimitName, RateLimiter>();

  constructor(rules: Partial<Record<RateLimitName, RateLimitRule>> = {}) {
    const merged: Record<RateLimitName, RateLimitRule> = { ...RATE_LIMITS, ...rules };
    for (const [name, rule] of Object.entries(merged) as [RateLimitName, RateLimitRule][]) {
      this.limiters.set(name, new RateLimiter(rule));
    }
  }

  check(name: RateLimitName, key: string, now: number): RateDecision {
    return this.limiter(name).take(key, now);
  }

  /** The decision `check` would make, without taking a token. */
  peek(name: RateLimitName, key: string, now: number): RateDecision {
    return this.limiter(name).peek(key, now);
  }

  limiter(name: RateLimitName): RateLimiter {
    const l = this.limiters.get(name);
    if (!l) throw new Error(`ratelimit: unknown rule ${name}`);
    return l;
  }
}
