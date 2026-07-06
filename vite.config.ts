import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// When Vite runs from a git worktree (`.claude/worktrees/*`), the worktree's own
// node_modules is empty, so dependencies resolve to the MAIN checkout's
// node_modules — which lives outside the worktree and is blocked by the dev
// server's default fs.allow. The result is fonts/assets 404ing and the app never
// booting. Allow serving from both the worktree (this config's dir) and wherever
// node_modules actually resolves. In a normal checkout these are the same path,
// so this is a no-op there.
const require = createRequire(import.meta.url)
const projectRoot = dirname(fileURLToPath(import.meta.url))
// node_modules/vite/package.json → node_modules/vite → node_modules → install root
const installRoot = dirname(dirname(dirname(require.resolve('vite/package.json'))))

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    fs: { allow: [projectRoot, installRoot] },
  },
})
