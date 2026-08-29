# Agent Note: Pooled pinning dispatchers for web-fetch

Status: implemented

English | [中文](2026-08-29-pinned-agent-pool.zh.md)

## Problem

Every web-fetch request built a fresh Undici agent and closed it after the body was consumed, so consecutive same-site fetches — the common burst — paid a full TCP + TLS handshake each and allocated a dispatcher per request. The per-request dispatcher was deliberate (the pinning lookup is baked into the agent), but its lifetime was not.

## Decision

Pin-carrying dispatchers are pooled briefly, keyed by the pinning identity: the URL hostname plus the full validated address set, sorted so resolution order cannot split the pool. A hit reuses the pooled agent's keep-alive connections; a miss — a new host, a changed answer set, or TTL expiry — builds a fresh agent with a pinned lookup built from that request's own resolution. Expiry is counted from creation and a hit never extends it: one pin serves at most 30 seconds of traffic before being rebuilt, which is the security/reuse tradeoff — the pin itself stays exact, and the TTL bounds how far one resolution may keep routing. Capacity (16 entries) evicts the least recently used agent, closing it asynchronously so an in-flight body keeps streaming (Undici's close waits for pending work). `PinnedResponse.close()` becomes a release no-op — the pool owns dispatcher lifetime — and `closePinnedAgentPool()` closes everything for runtime teardown and test servers, whose `server.close()` pooled keep-alive sockets would otherwise hold open.

The Linux side is untouched here by design; the POSIX-side per-tick `/proc` cost is the process-inspector's concern (see the async-termination note).

## Alternatives considered

**Keep a per-request dispatcher (status quo).** Rejected: the handshake cost per same-site fetch is the defect; pinning does not require a per-request dispatcher, only a per-request-resolved address set, which the pool key carries.

**Share one global dispatcher without a key or TTL.** Rejected: a global agent would keep serving a stale resolution indefinitely and mix unrelated hosts' sockets into one unpinnable agent; the key pins the validated answer set and the TTL bounds its lifetime.

**Reference-count claims and close at zero.** Rejected: the provider releases after every body, so zero claims is the steady state — closing there would delete the reuse the pool exists for. Undici's own keep-alive plus TTL eviction manage idle sockets instead.

## Consequences

Consecutive same-site fetches reuse one TCP/TLS connection within 30 seconds; a changed DNS answer set takes effect immediately through the key, and an unchanged set is re-pinned at most one TTL later. Pooled keep-alive sockets stay open up to the TTL after a fetch — the cost of reuse — and test servers must release the pool before closing (the suite does). The pool is process-wide and self-evicting; the OS closes whatever remains at exit.

## Testing

`fetch-http.spec` covers the pool directly (same-key reuse, TTL rebuild with the expired entry closed, LRU capacity eviction, disposal) and the pinning identity key (sorted address sets, host and address-set sensitivity), plus a real loopback scenario: consecutive same-site fetches reuse one TCP connection, and after the TTL the connection count grows — the rebuild observed through the server, not a mock.
