import { recoverDataRootOwnership } from './dataRootOwnership'

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main() {
  const dataRoot = option('--data-root')
  if (!dataRoot) throw new Error('Usage: npm run data:recover -- --data-root <path> --force')
  const result = await recoverDataRootOwnership(dataRoot, { force: process.argv.includes('--force') })
  console.log(`Recovered Elves data-root ownership for ${result.canonicalRoot}. Removed ${result.markerPath}.`)
}

main().catch((error) => {
  console.error('Elves data-root recovery failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
