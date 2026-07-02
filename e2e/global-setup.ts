import { rm } from 'node:fs/promises'

// Start every e2e run from a clean data root so project ids are deterministic.
// Safe regardless of whether this runs before or after the webServer boots — the
// server reads the data dir per-request and creates folders lazily on write.
export default async function globalSetup() {
  await rm('.e2e/data', { recursive: true, force: true })
}
