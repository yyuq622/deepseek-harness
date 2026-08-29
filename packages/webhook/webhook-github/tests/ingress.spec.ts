import { describe, expect, it } from 'vitest'
import { WebhookIngressGuard } from '../src/ingress.ts'

describe('webhook ingress guard', () => {
  it('refills the bucket by elapsed time and never beyond capacity', () => {
    let now = 0
    const guard = new WebhookIngressGuard({ capacity: 2, refillPerSecond: 1, now: () => now })
    expect(guard.consume('src')).toBe(true)
    expect(guard.consume('src')).toBe(true)
    expect(guard.consume('src')).toBe(false)
    // Half a second refills half a token: not enough for one request.
    now = 500
    expect(guard.consume('src')).toBe(false)
    // A full second past the last consume restores one token.
    now = 1000
    expect(guard.consume('src')).toBe(true)
  })

  it('tracks source addresses independently', () => {
    let now = 0
    const guard = new WebhookIngressGuard({ capacity: 1, refillPerSecond: 1, now: () => now })
    expect(guard.consume('a')).toBe(true)
    expect(guard.consume('a')).toBe(false)
    expect(guard.consume('b')).toBe(true)
  })

  it('opens the breaker on the tenth consecutive failure and closes it after the cooldown', () => {
    let now = 0
    const guard = new WebhookIngressGuard({ capacity: 30, refillPerSecond: 10, now: () => now })
    for (let index = 0; index < 9; index += 1) guard.recordVerificationFailure('src')
    expect(guard.isBroken('src')).toBe(false)
    guard.recordVerificationFailure('src')
    expect(guard.isBroken('src')).toBe(true)
    now = 9_999
    expect(guard.isBroken('src')).toBe(true)
    // The cooldown elapsed: the state resets, so the next failure starts a
    // fresh streak below the threshold.
    now = 10_000
    expect(guard.isBroken('src')).toBe(false)
    guard.recordVerificationFailure('src')
    expect(guard.isBroken('src')).toBe(false)
  })

  it('resets the breaker state on a verification success', () => {
    const guard = new WebhookIngressGuard({ capacity: 30, refillPerSecond: 10, now: () => 0 })
    for (let index = 0; index < 9; index += 1) guard.recordVerificationFailure('src')
    guard.recordVerificationSuccess('src')
    guard.recordVerificationFailure('src')
    expect(guard.isBroken('src')).toBe(false)
  })

  it('keeps source breaker states independent', () => {
    const guard = new WebhookIngressGuard({ capacity: 30, refillPerSecond: 10, now: () => 0 })
    for (let index = 0; index < 10; index += 1) guard.recordVerificationFailure('noisy')
    expect(guard.isBroken('noisy')).toBe(true)
    expect(guard.isBroken('quiet')).toBe(false)
  })

  it('evicts the oldest delivery id beyond the idempotency window', () => {
    const guard = new WebhookIngressGuard({ capacity: 30, refillPerSecond: 10, now: () => 0 })
    for (let index = 0; index < 1000; index += 1) guard.recordDelivery(`d-${index}`)
    expect(guard.isKnownDelivery('d-0')).toBe(true)
    guard.recordDelivery('d-1000')
    expect(guard.isKnownDelivery('d-0')).toBe(false)
    expect(guard.isKnownDelivery('d-1000')).toBe(true)
    expect(guard.isKnownDelivery('d-999')).toBe(true)
  })
})
