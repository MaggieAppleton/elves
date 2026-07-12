import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'

// Ports (and the data dir) default to the standard dev setup but can be
// overridden by env, so a run can sidestep a dev server already holding 5199/5173.
// ELVES_E2E_BASE (read by e2e/helpers) must point at the same server port.
const SERVER_PORT = Number(process.env.ELVES_E2E_SERVER_PORT ?? 5199)
const WEB_PORT = Number(process.env.ELVES_E2E_WEB_PORT ?? 5173)
const DATA = process.env.ELVES_DATA ?? '.e2e/data'

// Review passes now spawn a headless agent SERVER-SIDE (server/app.ts's
// launchReviewRun), so unlike the chat box it can't be stubbed via browser-
// level page.route — the server process itself needs a fake CLI to spawn.
// ELVES_CLI_BIN points the runner (server/agentRun.ts) at this deterministic
// stub instead of the real `claude`; ELVES_STUB_URL tells the stub which
// server to call back into.
const STUB_AGENT_PATH = fileURLToPath(new URL('./e2e/fixtures/stub-agent.mjs', import.meta.url))

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  fullyParallel: false,
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: `http://localhost:${WEB_PORT}` },
  webServer: [
    {
      command:
        `ELVES_DATA=${DATA} PORT=${SERVER_PORT} ` +
        `ELVES_CLI_BIN=${STUB_AGENT_PATH} ELVES_STUB_URL=http://localhost:${SERVER_PORT} ` +
        `npm run start`,
      port: SERVER_PORT,
      reuseExistingServer: false,
    },
    {
      command: `VITE_SERVER_URL=http://localhost:${SERVER_PORT} npm run dev -- --port ${WEB_PORT} --strictPort`,
      port: WEB_PORT,
      reuseExistingServer: false,
    },
  ],
})
