import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  fullyParallel: false,
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: 'http://localhost:5173' },
  webServer: [
    {
      command: 'ELVES_DATA=.e2e/data PORT=5199 npm run start',
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
