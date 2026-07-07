/**
 * Single source of truth for "which browser origins may talk to this server".
 * Used by both the CORS middleware (app.ts) and the WebSocket `verifyClient`
 * check (realtime.ts) so the two can never drift apart.
 *
 * Secure by default: only localhost/127.0.0.1 on the Vite client's dev port
 * and the server's own port are allowed, so a page open in any other tab (or
 * any other device on the LAN) cannot read or write the canvas. Set
 * `ELVES_ALLOWED_ORIGINS` (comma-separated, e.g.
 * "http://localhost:5173,https://my-tunnel.example") to explicitly widen
 * this — for example when accessing the app through a tunnel or a
 * non-default port.
 */

const DEFAULT_CLIENT_DEV_PORT = 5173

export function getAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const fromEnv = (env.ELVES_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (fromEnv.length) return fromEnv

  const serverPort = Number(env.PORT ?? 5199)
  return [
    `http://localhost:${DEFAULT_CLIENT_DEV_PORT}`,
    `http://127.0.0.1:${DEFAULT_CLIENT_DEV_PORT}`,
    `http://localhost:${serverPort}`,
    `http://127.0.0.1:${serverPort}`,
  ]
}

/**
 * Requests with no Origin header (same-origin navigation, curl, server-to-
 * server calls, and every existing test using supertest directly) are always
 * allowed — mirroring the `cors` package's own default behaviour of treating
 * a missing Origin as "not a cross-origin request" rather than as
 * disallowed. Only a *present but unlisted* Origin is rejected.
 */
export function isOriginAllowed(origin: string | undefined | null, allowed: string[]): boolean {
  if (!origin) return true
  return allowed.includes(origin)
}
