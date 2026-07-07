import { promises as dns } from 'node:dns'
import net from 'node:net'

/**
 * SSRF protection for outbound unfurl fetches. A pasted URL is attacker-
 * controllable (it can point anywhere), so before fetching we resolve its
 * hostname and refuse to talk to anything in a private/loopback/link-local/
 * multicast/metadata range — otherwise `/unfurl` becomes a proxy any web
 * page (or LAN device, once CORS/host binding are also open) can use to
 * probe this machine's own network.
 */

/** True if `ip` (a literal IPv4 or IPv6 address) is in a blocked range. */
export function isBlockedAddress(ip: string): boolean {
  const type = net.isIP(ip)
  if (type === 4) return isBlockedIPv4(ip)
  if (type === 6) return isBlockedIPv6(ip)
  return true // not a recognisable IP literal — refuse rather than guess
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0
}

function inCidr4(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask)
}

function isBlockedIPv4(ip: string): boolean {
  return (
    inCidr4(ip, '10.0.0.0', 8) || // private
    inCidr4(ip, '172.16.0.0', 12) || // private
    inCidr4(ip, '192.168.0.0', 16) || // private
    inCidr4(ip, '127.0.0.0', 8) || // loopback
    inCidr4(ip, '169.254.0.0', 16) || // link-local, incl. 169.254.169.254 (cloud metadata)
    inCidr4(ip, '0.0.0.0', 8) || // "this network"
    inCidr4(ip, '224.0.0.0', 4) // multicast
  )
}

function isBlockedIPv6(ip: string): boolean {
  const norm = ip.toLowerCase()
  if (norm === '::1' || norm === '::') return true // loopback / unspecified
  if (/^fe[89ab][0-9a-f]:/.test(norm)) return true // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(norm)) return true // fc00::/7 unique local
  const mapped = norm.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) // IPv4-mapped IPv6
  if (mapped) return isBlockedIPv4(mapped[1])
  return false
}

export interface DnsResolver {
  lookup: typeof dns.lookup
}

export type HostCheck = { ok: true; addresses: string[] } | { ok: false }

/** Resolve `hostname` and reject if it (or any of its addresses) is blocked. */
export async function resolveHostSafe(
  hostname: string,
  resolver: DnsResolver = dns,
): Promise<HostCheck> {
  // A bracketed IPv6 literal (e.g. `http://[::1]/`) keeps its brackets in
  // URL.hostname, but net.isIP('[::1]') is 0 — strip them so the literal-IP
  // path catches it (private → blocked) instead of falling through to a DNS
  // lookup that would wrongly reject a legitimate PUBLIC IPv6 literal too.
  const literal = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
  if (net.isIP(literal)) {
    return isBlockedAddress(literal) ? { ok: false } : { ok: true, addresses: [literal] }
  }
  let records: { address: string }[]
  try {
    records = await resolver.lookup(hostname, { all: true })
  } catch {
    return { ok: false }
  }
  if (records.length === 0 || records.some((r) => isBlockedAddress(r.address))) {
    return { ok: false }
  }
  return { ok: true, addresses: records.map((r) => r.address) }
}

export class BlockedAddressError extends Error {
  constructor(url: string) {
    super(`refusing to fetch a private/local address: ${url}`)
    this.name = 'BlockedAddressError'
  }
}

export interface SafeFetchOptions {
  maxRedirects?: number
  resolver?: DnsResolver
  fetchImpl?: typeof fetch
}

/**
 * `fetch`, but SSRF-guarded: every hop (initial URL and each redirect target)
 * has its hostname resolved and checked against `resolveHostSafe` BEFORE the
 * request is made, and redirects are followed manually (never `redirect:
 * 'follow'`) so a same-origin-looking URL can't rebind to a private address
 * partway through the chain.
 */
export async function safeFetch(
  url: string,
  init: RequestInit = {},
  opts: SafeFetchOptions = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 5
  const doFetch = opts.fetchImpl ?? fetch
  let currentUrl = url

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsed = new URL(currentUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BlockedAddressError(currentUrl)
    }
    const check = await resolveHostSafe(parsed.hostname, opts.resolver)
    if (!check.ok) throw new BlockedAddressError(currentUrl)

    const res = await doFetch(currentUrl, { ...init, redirect: 'manual' })
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      currentUrl = new URL(location, currentUrl).toString()
      continue
    }
    return res
  }
  throw new Error(`too many redirects fetching ${url}`)
}
