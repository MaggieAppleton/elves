// Cascades successive spawns (new cards/sections) so they don't stack
// invisibly on top of each other when created at the viewport center.

export const CASCADE_STEP = 24
// Reset after this many steps so cards don't drift off-screen forever.
export const CASCADE_WRAP = 8

export function cascadeOffset(spawnIndex: number): { dx: number; dy: number } {
  const step = spawnIndex % CASCADE_WRAP
  return { dx: step * CASCADE_STEP, dy: step * CASCADE_STEP }
}
