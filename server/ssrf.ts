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
    inCidr4(ip, '100.64.0.0', 10) || // CGNAT (RFC 6598)
    inCidr4(ip, '224.0.0.0', 4) || // multicast
    inCidr4(ip, '240.0.0.0', 4) // reserved, incl. 255.255.255.255 broadcast
  )
}

// Expand an IPv6 literal (already validated by net.isIP) to its 16 bytes.
// Handles `::` compression and an embedded IPv4 tail in EITHER form —
// dotted (`::ffff:127.0.0.1`) or hex (`::ffff:7f00:1`). Returns null if the
// text doesn't parse, so callers can refuse rather than guess.
function ipv6ToBytes(ip: string): number[] | null {
  let s = ip.toLowerCase()
  // Fold a trailing dotted-IPv4 into two hextets so the parser below only ever
  // deals in hex groups (`::ffff:127.0.0.1` → `::ffff:7f00:1`).
  const v4 = s.match(/:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (v4) {
    const oct = v4[1].split('.').map(Number)
    if (oct.some((n) => n > 255)) return null
    const hi = ((oct[0] << 8) | oct[1]).toString(16)
    const lo = ((oct[2] << 8) | oct[3]).toString(16)
    s = s.slice(0, s.length - v4[1].length) + `${hi}:${lo}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const groups =
    halves.length === 2
      ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
      : left
  if (groups.length !== 8) return null
  const bytes: number[] = []
  for (const g of groups) {
    const v = parseInt(g, 16)
    if (Number.isNaN(v) || v < 0 || v > 0xffff) return null
    bytes.push((v >> 8) & 0xff, v & 0xff)
  }
  return bytes
}

function isBlockedIPv6(ip: string): boolean {
  const b = ipv6ToBytes(ip)
  if (!b) return true // unparseable — refuse rather than guess
  // Any address embedding an IPv4 in its low 32 bits is only as safe as that
  // IPv4: ::/96 (loopback ::1, unspecified ::, deprecated IPv4-compatible),
  // ::ffff:0:0/96 (IPv4-mapped — the range URL literals like [::ffff:7f00:1]
  // land in), and 64:ff9b::/96 (NAT64). Check the embedded IPv4 for all three
  // so no encoding of a private/loopback/metadata v4 slips through.
  const embeddedV4 = () => isBlockedIPv4(b.slice(12).join('.'))
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0)
  if (zero(0, 12)) return embeddedV4() // ::/96
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return embeddedV4() // ::ffff:0:0/96
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) {
    return embeddedV4() // 64:ff9b::/96 NAT64
  }
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true // fe80::/10 link-local
  if ((b[0] & 0xfe) === 0xfc) return true // fc00::/7 unique local
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
 *
 * Known residual (documented follow-up): each hop is validated by hostname and
 * then fetched by hostname, so the runtime does its own second DNS lookup —
 * a low-TTL attacker domain could resolve public on the check and private on
 * the connect (classic same-host DNS rebinding). Closing it fully means
 * pinning the vetted IP and connecting to it with the original Host header,
 * which fetch/undici don't expose cleanly. The loopback-default bind keeps the
 * blast radius local until then.
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
