import { describe, expect, test } from 'vitest'
import { getAllowedOrigins, isOriginAllowed } from '../../server/origins'

describe('getAllowedOrigins', () => {
  test('defaults to localhost/127.0.0.1 on the client dev port and the server port', () => {
    expect(getAllowedOrigins({})).toEqual([
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:5199',
      'http://127.0.0.1:5199',
    ])
  })

  test('uses PORT for the server-port entries when set', () => {
    expect(getAllowedOrigins({ PORT: '4000' })).toEqual([
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:4000',
      'http://127.0.0.1:4000',
    ])
  })

  test('ELVES_ALLOWED_ORIGINS overrides the defaults entirely', () => {
    expect(getAllowedOrigins({ ELVES_ALLOWED_ORIGINS: 'https://a.example, https://b.example' })).toEqual([
      'https://a.example',
      'https://b.example',
    ])
  })
})

describe('isOriginAllowed', () => {
  const allowed = ['http://localhost:5173']

  test('a missing Origin (same-origin, curl, server-to-server) is always allowed', () => {
    expect(isOriginAllowed(undefined, allowed)).toBe(true)
    expect(isOriginAllowed(null, allowed)).toBe(true)
    expect(isOriginAllowed('', allowed)).toBe(true)
  })

  test('a listed origin is allowed', () => {
    expect(isOriginAllowed('http://localhost:5173', allowed)).toBe(true)
  })

  test('an unlisted origin is rejected', () => {
    expect(isOriginAllowed('https://evil.example', allowed)).toBe(false)
  })
})
