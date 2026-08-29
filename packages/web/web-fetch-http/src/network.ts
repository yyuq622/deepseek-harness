/**
 * Public-network resolution and address-pinned HTTP transport for `web-fetch-http`.
 * One DNS answer set is validated before Undici receives it through a custom lookup,
 * so the connection cannot resolve the hostname again to a private address. Pinning
 * dispatchers are pooled briefly per validated address set + host: reuse within the
 * pool's TTL, rebuild and re-pin when it expires or the answer set changes.
 *
 * @module @deepseek-ai/dsh-web-fetch-http/network
 */

import { lookup as systemLookup } from 'node:dns/promises'
import type { LookupAddress, LookupOptions } from 'node:dns'
import { isIP } from 'node:net'
import type { Dispatcher, Response } from 'undici'
import ipaddr from 'ipaddr.js'
import { WebError } from '@deepseek-ai/dsh-web'

/** One address resolved and retained for the subsequent pinned connection. */
export interface PublicAddress {
  /** Canonical textual IPv4 or IPv6 address. */
  readonly address: string
  /** Address family accepted by Node's connection lookup callback. */
  readonly family: 4 | 6
}

/** The result of one address-pinned request. */
export interface PinnedResponse {
  /** HTTP response whose body remains readable until `close()` is called. */
  readonly response: Response
  /**
   * Release the request's dispatcher. Under the shared agent pool this is a
   * no-op: the pool owns dispatcher lifetime (agents close on eviction and at
   * pool disposal), and undici discards a broken socket on its next use.
   */
  close(): Promise<void>
}

/** Resolver signature used to test public-address policy without process DNS changes. */
export type AddressResolver = (hostname: string, options: { all: true; order: 'verbatim' }) => Promise<LookupAddress[]>

/** RFC 6052 prefix lengths that may carry an IPv4 destination through NAT64. */
const RFC6052_PREFIX_LENGTHS = [32, 40, 48, 56, 64, 96] as const
const IPV4ONLY_DISCOVERY_HOST = 'ipv4only.arpa'
const IPV4ONLY_SENTINELS = new Set(['192.0.0.170', '192.0.0.171'])

interface Nat64Prefix {
  readonly bytes: readonly number[]
  readonly length: typeof RFC6052_PREFIX_LENGTHS[number]
}

/**
 * Return whether an address is globally reachable unicast. IPv4-mapped IPv6 is
 * classified by its embedded IPv4 address; transition and translation prefixes
 * remain blocked because their eventual IPv4 destination cannot be pinned here.
 *
 * @param input - textual IPv4 or IPv6 address.
 * @returns true only for a public unicast destination.
 */
export function isPublicIpAddress(input: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6
  try {
    parsed = ipaddr.parse(stripIpv6Brackets(input))
  } catch {
    return false
  }
  if (parsed instanceof ipaddr.IPv4) return parsed.range() === 'unicast'
  if (parsed.isIPv4MappedAddress()) return parsed.toIPv4Address().range() === 'unicast'
  return parsed.range() === 'unicast'
}

/**
 * Resolve a hostname once and reject the complete answer set if any destination
 * is not public. The returned addresses are the only ones the transport may use.
 *
 * @param hostname - URL hostname, including brackets when it is an IPv6 literal.
 * @param signal - aborts the wait for system resolution; an in-flight OS lookup may finish unused.
 * @param resolver - lookup implementation, overridden only by focused tests.
 * @returns the validated, non-empty address set.
 */
export async function resolvePublicAddresses(
  hostname: string,
  signal: AbortSignal,
  resolver: AddressResolver = systemLookup,
): Promise<PublicAddress[]> {
  const unbracketed = stripIpv6Brackets(hostname)
  const literalFamily = isIP(unbracketed)
  const resolved = literalFamily === 0
    ? await raceWithSignal(resolver(unbracketed, { all: true, order: 'verbatim' }), signal)
    : [{ address: unbracketed, family: literalFamily }]

  if (resolved.length === 0) {
    throw new WebError(`hostname "${hostname}" resolved to no addresses`, 'WEB_PROVIDER_ERROR')
  }

  const hasIpv6 = resolved.some(entry => entry.family === 6 && isIP(entry.address) === 6)
  const nat64Prefixes = hasIpv6
    ? await discoverNat64Prefixes(signal, resolver)
    : []

  const addresses: PublicAddress[] = []
  for (const entry of resolved) {
    if ((entry.family !== 4 && entry.family !== 6) || isIP(entry.address) !== entry.family) {
      throw new WebError(`hostname "${hostname}" resolved to an invalid IP address`, 'WEB_PROVIDER_ERROR')
    }
    if (!isPublicIpAddress(entry.address)) {
      throw new WebError(`URL hostname "${hostname}" resolves to a non-public IP address`, 'WEB_BLOCKED_URL')
    }
    const translatedIpv4 = translatedIpv4Address(entry.address, nat64Prefixes)
    if (translatedIpv4 !== undefined && !isPublicIpAddress(translatedIpv4)) {
      throw new WebError(`URL hostname "${hostname}" resolves through NAT64 to a non-public IPv4 address`, 'WEB_BLOCKED_URL')
    }
    addresses.push({ address: entry.address, family: entry.family })
  }
  return addresses
}

/** Discover the active DNS64 prefix set using RFC 7050's reserved hostname. */
async function discoverNat64Prefixes(signal: AbortSignal, resolver: AddressResolver): Promise<Nat64Prefix[]> {
  const discovered = await raceWithSignal(
    resolver(IPV4ONLY_DISCOVERY_HOST, { all: true, order: 'verbatim' }),
    signal,
  )
  const prefixes: Nat64Prefix[] = []
  const seen = new Set<string>()
  for (const entry of discovered) {
    if (entry.family !== 6 || isIP(entry.address) !== 6) continue
    const bytes = ipaddr.parse(entry.address).toByteArray()
    for (const length of RFC6052_PREFIX_LENGTHS) {
      const embedded = embeddedIpv4Address(bytes, length)
      if (embedded === undefined || !IPV4ONLY_SENTINELS.has(embedded)) continue
      const prefixBytes = bytes.slice(0, length / 8)
      const key = `${String(length)}:${prefixBytes.join('.')}`
      if (seen.has(key)) continue
      seen.add(key)
      prefixes.push({ bytes: prefixBytes, length })
    }
  }
  return prefixes
}

/** Return the RFC 6052-embedded IPv4 address when an IPv6 address matches a discovered prefix. */
function translatedIpv4Address(input: string, prefixes: readonly Nat64Prefix[]): string | undefined {
  if (isIP(input) !== 6) return undefined
  const bytes = ipaddr.parse(input).toByteArray()
  for (const prefix of prefixes) {
    if (!prefix.bytes.every((byte, index) => bytes[index] === byte)) continue
    const embedded = embeddedIpv4Address(bytes, prefix.length)
    if (embedded !== undefined) return embedded
  }
  return undefined
}

/** Extract one IPv4 address from an RFC 6052 IPv6 layout. */
function embeddedIpv4Address(bytes: readonly number[], prefixLength: Nat64Prefix['length']): string | undefined {
  if (prefixLength === 96) return bytes.slice(12, 16).join('.')
  if (bytes[8] !== 0) return undefined
  const prefixBytes = prefixLength / 8
  const beforeReservedOctet = 8 - prefixBytes
  const ipv4 = [
    ...bytes.slice(prefixBytes, prefixBytes + beforeReservedOctet),
    ...bytes.slice(9, 9 + 4 - beforeReservedOctet),
  ]
  return ipv4.join('.')
}

/** How long one pooled pinning may serve: short enough to bound how far a stale resolution can keep routing, long enough to amortize a burst of same-site fetches. */
const AGENT_POOL_TTL_MS = 30_000

/** Upper bound on pooled dispatchers; the least recently used is closed beyond it. */
const AGENT_POOL_MAX_ENTRIES = 16

/** One pooled dispatcher with its closing handle — the pool's entry payload. */
export interface PooledDispatcher {
  readonly dispatcher: Dispatcher
  close(): Promise<void>
}

/**
 * Brief pool of pinning dispatchers keyed by the validated address set + host
 * ({@link poolKey}). A hit reuses the pooled agent's keep-alive connections;
 * TTL expiry, capacity pressure, or a changed address set rebuild the
 * dispatcher and re-pin it to the fresh resolution. Expiry is counted from
 * creation and a hit never extends it: one pin can serve at most `ttlMs` of
 * traffic before being rebuilt, which is the security/reuse tradeoff — the
 * pin itself stays exact (the key carries the validated address set), and the
 * TTL bounds how long one resolution may keep routing.
 */
export class PinnedAgentPool<T extends { close(): Promise<void> }> {
  private readonly entries = new Map<string, { entry: T; createdAt: number }>()

  constructor(
    private readonly ttlMs: number = AGENT_POOL_TTL_MS,
    private readonly maxEntries: number = AGENT_POOL_MAX_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Acquire one live entry for `key`, creating it on a pool miss or after the
   * previous entry's TTL expired. Acquisition refreshes recency, so capacity
   * pressure evicts the least recently used entry.
   * @param key - the pinning identity (host + validated address set).
   * @param create - builds the entry when the pool has no live one.
   * @returns the live entry for the key.
   */
  acquire(key: string, create: () => T): T {
    const now = this.now()
    const current = this.entries.get(key)
    if (current !== undefined && now - current.createdAt < this.ttlMs) {
      this.entries.delete(key)
      this.entries.set(key, current)
      return current.entry
    }
    if (current !== undefined) this.evict(key, current.entry)
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      const victim = this.entries.get(oldest.value)
      if (victim !== undefined) this.evict(oldest.value, victim.entry)
    }
    const created = create()
    this.entries.set(key, { entry: created, createdAt: now })
    return created
  }

  /**
   * Close every pooled entry and empty the pool (provider runtime disposal,
   * tests). Evicted entries close asynchronously; disposal waits.
   */
  async dispose(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    await Promise.allSettled(entries.map(({ entry }) => entry.close()))
  }

  private evict(key: string, entry: T): void {
    this.entries.delete(key)
    // Eviction closes asynchronously: an agent with an in-flight body keeps
    // serving it (undici close waits for pending work) and never blocks the
    // acquire path.
    void entry.close().catch(() => {})
  }
}

/** The process-wide pool behind every `requestPinned` call. Entries close on TTL expiry, capacity eviction, and pool disposal; the OS closes whatever remains at process exit. */
const sharedAgentPool = new PinnedAgentPool<PooledDispatcher>()

/**
 * Close every dispatcher pooled behind {@link requestPinned} and empty the
 * shared pool. Runtime teardown and test servers use this before closing
 * their listeners: pooled keep-alive sockets would otherwise hold
 * `server.close()` open. Requests after it rebuild their agents.
 * @returns resolves once every pooled dispatcher has closed.
 */
export async function closePinnedAgentPool(): Promise<void> {
  await sharedAgentPool.dispose()
}

/**
 * The pinning identity of one request: the URL hostname plus the full
 * validated answer set, sorted so resolution order cannot split the pool.
 * @param hostname - URL hostname.
 * @param addresses - public addresses returned by {@link resolvePublicAddresses}.
 * @returns the pool key.
 */
export function poolKey(hostname: string, addresses: readonly PublicAddress[]): string {
  return `${hostname}|${addresses.map(address => `${address.family}/${address.address}`).sort().join(',')}`
}

/**
 * Fetch through an Undici agent whose lookup callback returns only the already
 * validated address set. The URL hostname remains intact for HTTP Host and TLS SNI.
 * The agent comes from the pool for this request's pinning identity, so
 * same-site fetches reuse keep-alive connections within the pool's TTL.
 *
 * @param url - validated HTTP(S) URL.
 * @param addresses - public addresses returned by {@link resolvePublicAddresses}.
 * @param headers - request headers.
 * @param signal - request and body-read cancellation signal.
 * @param pool - the pool backing this request; defaults to the shared pool.
 * @returns a response whose `close()` releases nothing (the pool owns the dispatcher's lifetime).
 */
export async function requestPinned(
  url: URL,
  addresses: readonly PublicAddress[],
  headers: Record<string, string>,
  signal: AbortSignal,
  pool: PinnedAgentPool<PooledDispatcher> = sharedAgentPool,
): Promise<PinnedResponse> {
  // Keep the Node-only transport out of browser-worker startup. The preview
  // can load the provider and fail loud at its DNS stub without evaluating
  // Undici; a real request on Node resolves this maintained dependency here.
  const { Agent, fetch } = await import('undici')
  const pooled = pool.acquire(poolKey(url.hostname, addresses), () => {
    const dispatcher = new Agent({
      autoSelectFamily: true,
      connect: { lookup: createPinnedLookup(addresses) },
    })
    return { dispatcher, close: () => dispatcher.close() }
  })
  const response = await fetch(url, { method: 'GET', redirect: 'manual', headers, signal, dispatcher: pooled.dispatcher })
  return { response, close: () => Promise.resolve() }
}

/** Production network operations kept as an object so provider tests can replace resolution only. */
export const publicHttpNetwork = {
  resolve: resolvePublicAddresses,
  request: requestPinned,
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void

/**
 * Build the connector lookup that serves a fixed validated answer set.
 *
 * @param addresses - public addresses retained from the preceding resolution.
 * @returns a Node-compatible lookup callback that performs no network resolution.
 */
export function createPinnedLookup(addresses: readonly PublicAddress[]): (
  hostname: string,
  options: LookupOptions,
  callback: LookupCallback,
) => void {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    const family = typeof options.family === 'number'
      ? options.family
      : options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : 0
    const eligible = family === 0 ? addresses : addresses.filter(address => address.family === family)
    const selected = eligible[0]
    if (selected === undefined) {
      const error = Object.assign(new Error(`no validated address for ${hostname} in family ${family}`), {
        code: 'ENOTFOUND',
        hostname,
      })
      callback(error, options.all === true ? [] : '', family)
      return
    }
    if (options.all === true) {
      callback(null, eligible.map(address => ({ ...address })))
      return
    }
    callback(null, selected.address, selected.family)
  }
}

/** Race a non-cancellable OS lookup without letting it delay tool cancellation. */
function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const abortError = () => new Error('web fetch aborted during hostname resolution', { cause: signal.reason })
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const abort = () => { reject(abortError()) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
  })
}

/** WHATWG URL retains brackets around IPv6 hostnames; IP parsers do not. */
function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}
