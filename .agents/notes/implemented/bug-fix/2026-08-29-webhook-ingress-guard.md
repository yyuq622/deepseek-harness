# Agent Note: Webhook ingress rate limiting and idempotent redelivery

Status: implemented

English | [中文](2026-08-29-webhook-ingress-guard.zh.md)

## Problem

The GitHub ingress answered every request with the full bounded-body read plus an HMAC verification — a flood paid exactly the cost a sender wanted to impose, with no rate bound beyond the 413 body cap. A redelivered `X-GitHub-Delivery` id re-invoked every rule, because the fire-and-forget dispatch reports 202 before any rule runs and GitHub retries on timeout.

## Decision

One in-memory guard per handler instance carries three mechanisms:

- A token bucket per source address (`rateLimitCapacity` burst, `rateLimitRefillPerSecond` refill — plugin config, since traffic volume is deployment-varying), consumed before any body work: a flood pays only the cheap header checks and answers 429. The 413 semantics are unchanged for a non-empty bucket.
- Ten consecutive signature failures from one source open a ten-second breaker that rejects the source with 503 before any HMAC or parse work; a verification success resets the streak, and after the cooldown the next attempt re-evaluates from clean. The bounds are fixed constants — abuse response, not traffic policy.
- The last 1000 dispatched delivery ids are remembered per handler; a verified redelivery is answered 202 without re-invoking rules. The id is recorded only after the dispatch has been accepted, so a delivery whose dispatch failed stays retryable, and only verified requests can reach the check — suppressing a genuine delivery requires the shared secret.

The state is per handler instance, in memory, and never persisted.

## Alternatives considered

**Bucket keyed by source address + delivery id.** Rejected: each delivery is one request, so a per-delivery bucket is meaningless; the two identifiers own different mechanisms — the address bounds rate, the delivery id bounds duplication.

**Make the breaker bounds plugin config.** Rejected for now: threshold and cooldown are abuse-response constants, not throughput a deployment tunes; promote them to config when a deployment actually needs a different posture.

**Dedup by recording at arrival instead of after dispatch.** Rejected: a dispatch that throws answers 503, and GitHub retries non-2xx — recording at arrival would answer the retry 202 while the rules never ran, silently dropping the delivery.

## Consequences

A flood from one source answers 429 after the burst without reading bodies; a signature-guessing source is locked out for ten seconds at a time; and GitHub's timeout redeliveries no longer double-invoke rules. The guard's memory is bounded (one bucket per source address seen — bounded by the source-address space actually observed — plus 1000 delivery ids). Concurrent same-id arrivals can still both dispatch (the window is per-arrival ordering), and a process restart forgets the window — GitHub's redelivery on a fresh process re-runs the rules, which is the pre-existing at-most-once shape of the fire-and-forget dispatch.

## Testing

`handler.spec` drives the real handler over HTTP: a three-request flood answers 429 after the burst with two dispatches, a redelivered id answers 202 once, and ten consecutive signature failures open the breaker against a valid signature with the streak reset by a success. `ingress.spec` pins the guard's state machine with an injected clock: refill by elapsed time, capacity bound, threshold and cooldown transitions, per-source independence, and the idempotency window eviction.
