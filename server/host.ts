/**
 * Which network interface the HTTP server binds to. Secure by default:
 * loopback-only, so the canvas server isn't reachable from other devices on
 * the LAN. Set `ELVES_HOST=0.0.0.0` (or a specific interface address) to
 * opt in to LAN/remote access.
 */
export function resolveHost(env: NodeJS.ProcessEnv = process.env): string {
  return env.ELVES_HOST ?? '127.0.0.1'
}
