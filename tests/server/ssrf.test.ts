import { describe, expect, test } from 'vitest'
import {
  isBlockedAddress, resolveHostSafe, safeFetch, BlockedAddressError,
} from '../../server/ssrf'

describe('isBlockedAddress', () => {
  const cases: [string, boolean][] = [
    ['10.0.0.5', true], // private
    ['10.255.255.255', true], // private
    ['172.16.0.1', true], // private
    ['172.31.255.255', true], // private
    ['172.32.0.1', false], // just outside 172.16.0.0/12
    ['192.168.1.1', true], // private
    ['127.0.0.1', true], // loopback
    ['169.254.169.254', true], // cloud metadata
    ['169.254.0.1', true], // link-local
    ['0.0.0.0', true],
    ['224.0.0.1', true], // multicast
    ['8.8.8.8', false], // public
    ['93.184.216.34', false], // public (example.com)
    ['::1', true], // loopback
    ['fc00::1', true], // unique local
    ['fd12:3456:789a::1', true], // unique local
    ['fe80::1', true], // link-local
    ['::ffff:127.0.0.1', true], // IPv4-mapped loopback
    ['::ffff:8.8.8.8', false], // IPv4-mapped public
    ['2001:4860:4860::8888', false], // public (Google DNS)
  ]

  test.each(cases)('%s -> blocked=%s', (ip, expected) => {
    expect(isBlockedAddress(ip)).toBe(expected)
  })

  test('a non-IP string is treated as blocked (fail closed)', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true)
  })
})

describe('resolveHostSafe', () => {
  test('rejects a hostname that resolves to a private address', async () => {
    const resolver = { lookup: async () => [{ address: '10.0.0.1', family: 4 }] as any }
    const result = await resolveHostSafe('internal.example', resolver)
    expect(result.ok).toBe(false)
  })

  test('accepts a hostname that resolves to a public address', async () => {
    const resolver = { lookup: async () => [{ address: '93.184.216.34', family: 4 }] as any }
    const result = await resolveHostSafe('example.com', resolver)
    expect(result).toEqual({ ok: true, addresses: ['93.184.216.34'] })
  })

  test('a literal loopback IP is rejected without a DNS lookup', async () => {
    const resolver = { lookup: async () => { throw new Error('should not be called') } }
    const result = await resolveHostSafe('127.0.0.1', resolver)
    expect(result.ok).toBe(false)
  })

  test('a DNS failure is treated as blocked', async () => {
    const resolver = { lookup: async () => { throw new Error('ENOTFOUND') } }
    const result = await resolveHostSafe('nowhere.invalid', resolver)
    expect(result.ok).toBe(false)
  })

  test('a bracketed IPv6 loopback literal ([::1]) is caught by the literal path, not DNS', async () => {
    const resolver = { lookup: async () => { throw new Error('should not be called') } }
    const result = await resolveHostSafe('[::1]', resolver)
    expect(result.ok).toBe(false)
  })

  test('a bracketed PUBLIC IPv6 literal is allowed without a DNS lookup', async () => {
    const resolver = { lookup: async () => { throw new Error('should not be called') } }
    const result = await resolveHostSafe('[2001:4860:4860::8888]', resolver)
    expect(result).toEqual({ ok: true, addresses: ['2001:4860:4860::8888'] })
  })
})

describe('safeFetch', () => {
  test('rejects a target that resolves to a private address, without fetching', async () => {
    const resolver = { lookup: async () => [{ address: '169.254.169.254', family: 4 }] as any }
    const fetchImpl = async () => { throw new Error('should not be called') }
    await expect(
      safeFetch('http://metadata.internal/', {}, { resolver, fetchImpl: fetchImpl as any }),
    ).rejects.toBeInstanceOf(BlockedAddressError)
  })

  test('fetches a public target', async () => {
    const resolver = { lookup: async () => [{ address: '93.184.216.34', family: 4 }] as any }
    const fetchImpl = async () => new Response('ok', { status: 200 })
    const res = await safeFetch('http://example.com/', {}, { resolver, fetchImpl: fetchImpl as any })
    expect(res.status).toBe(200)
  })

  test('re-validates the host of a redirect hop and rejects a rebind to a private address', async () => {
    const resolver = {
      lookup: async (hostname: string) =>
        hostname === 'public.example'
          ? [{ address: '93.184.216.34', family: 4 }]
          : [{ address: '127.0.0.1', family: 4 }],
    }
    const fetchImpl = async (url: string | URL) =>
      String(url).startsWith('http://public.example')
        ? new Response(null, { status: 302, headers: { location: 'http://internal.example/secret' } })
        : new Response('should not get here', { status: 200 })
    await expect(
      safeFetch('http://public.example/', {}, { resolver: resolver as any, fetchImpl: fetchImpl as any }),
    ).rejects.toBeInstanceOf(BlockedAddressError)
  })

  test('follows a redirect chain to an allowed final host', async () => {
    const resolver = { lookup: async () => [{ address: '93.184.216.34', family: 4 }] as any }
    const fetchImpl = async (url: string | URL) =>
      String(url) === 'http://public.example/'
        ? new Response(null, { status: 302, headers: { location: 'http://public.example/final' } })
        : new Response('final', { status: 200 })
    const res = await safeFetch('http://public.example/', {}, { resolver: resolver as any, fetchImpl: fetchImpl as any })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('final')
  })
})
