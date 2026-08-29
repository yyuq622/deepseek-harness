/**
 * In-memory ingress guard for the GitHub webhook route: a per-source-address
 * token bucket bounds request rate, a bounded delivery-id set short-circuits
 * redeliveries idempotently, and a streak of consecutive signature failures
 * opens a short breaker that rejects without paying the HMAC + parse cost.
 * All state is per-handler-instance and never persisted; the breaker bounds
 * are abuse-response constants, while the bucket is deployment-varying
 * traffic policy supplied from plugin config.
 * @module @deepseek-ai/dsh-webhook-github/ingress
 */

/** Consecutive signature failures from one source that open the breaker. */
const FAILURE_BREAKER_THRESHOLD = 10

/** How long the breaker stays open once tripped. */
const FAILURE_BREAKER_MS = 10_000

/** How many dispatched delivery ids the idempotency window remembers. */
const DELIVERY_MEMORY = 1_000

/** Guard knobs. The bucket is traffic policy from plugin config; the breaker and idempotency bounds are fixed. */
export interface IngressGuardOptions {
  /** Bucket capacity (burst size) per source address. */
  capacity: number
  /** Tokens refilled per second, per source address. */
  refillPerSecond: number
  /** Millisecond clock, injectable for deterministic tests. */
  now: () => number
}

/** One source's breaker state: the failure streak and when the breaker opened. */
interface FailureState {
  streak: number
  openedAt: number
}

/**
 * The ingress guard. Create one per route handler; every method is
 * synchronous and safe for concurrent requests (single-threaded access).
 */
export class WebhookIngressGuard {
  private readonly buckets = new Map<string, { tokens: number; last: number }>()
  private readonly failures = new Map<string, FailureState>()
  private readonly dispatchedDeliveries = new Set<string>()

  constructor(private readonly options: IngressGuardOptions) {}

  /**
   * Consume one token for the source address, refilling by elapsed time.
   * @param source - the request's remote address.
   * @returns false when the bucket is empty and the request should be rate limited.
   */
  consume(source: string): boolean {
    const now = this.options.now()
    let bucket = this.buckets.get(source)
    if (bucket === undefined) {
      bucket = { tokens: this.options.capacity, last: now }
      this.buckets.set(source, bucket)
    }
    const elapsedSeconds = (now - bucket.last) / 1000
    if (elapsedSeconds > 0) {
      bucket.tokens = Math.min(this.options.capacity, bucket.tokens + elapsedSeconds * this.options.refillPerSecond)
      bucket.last = now
    }
    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }

  /**
   * Record one signature-verification failure. From the threshold on, every
   * failure re-opens the breaker for {@link IngressGuardOptions}’ fixed
   * cooldown, so continued abuse keeps it closed until the failures stop.
   * @param source - the request's remote address.
   */
  recordVerificationFailure(source: string): void {
    const state = this.failures.get(source) ?? { streak: 0, openedAt: 0 }
    state.streak += 1
    if (state.streak >= FAILURE_BREAKER_THRESHOLD) state.openedAt = this.options.now()
    this.failures.set(source, state)
  }

  /**
   * Record one signature-verification success: the source's breaker state resets.
   * @param source - the request's remote address.
   */
  recordVerificationSuccess(source: string): void {
    this.failures.delete(source)
  }

  /**
   * Whether the breaker is open for the source — signature failures are
   * rejected without HMAC or parse work until the cooldown elapses, after
   * which the next attempt re-evaluates from a clean streak.
   * @param source - the request's remote address.
   * @returns true while the breaker is open.
   */
  isBroken(source: string): boolean {
    const state = this.failures.get(source)
    if (state === undefined || state.openedAt === 0) return false
    if (this.options.now() - state.openedAt < FAILURE_BREAKER_MS) return true
    this.failures.delete(source)
    return false
  }

  /**
   * Register a dispatched delivery id, evicting the oldest beyond the memory
   * window. Call it only after the dispatch has been accepted — a delivery
   * whose dispatch failed must stay retryable.
   * @param deliveryId - the X-GitHub-Delivery id.
   */
  recordDelivery(deliveryId: string): void {
    this.dispatchedDeliveries.add(deliveryId)
    if (this.dispatchedDeliveries.size > DELIVERY_MEMORY) {
      const oldest = this.dispatchedDeliveries.values().next()
      if (oldest.done !== true) this.dispatchedDeliveries.delete(oldest.value)
    }
  }

  /**
   * Whether this delivery id was already dispatched. Reachable only after
   * signature verification, so suppressing a genuine delivery requires the
   * shared secret.
   * @param deliveryId - the X-GitHub-Delivery id.
   * @returns true for a redelivery that must be answered 202 without re-invoking rules.
   */
  isKnownDelivery(deliveryId: string): boolean {
    return this.dispatchedDeliveries.has(deliveryId)
  }
}
