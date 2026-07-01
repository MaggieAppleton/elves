import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  fullyParallel: false,
  use: { baseURL: 'http://localhost:5173' },
  webServer: [
    {
      command: 'ELVES_CANVAS=.e2e/canvas.json PORT=5199 npm run start',
      port: 5199,
      reuseExistingServer: false,
    },
    {
      command: 'npm run dev',
      port: 5173,
      reuseExistingServer: false,
    },
  ],
})
