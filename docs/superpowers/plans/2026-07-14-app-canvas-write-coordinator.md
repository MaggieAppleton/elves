# App Canvas Write Coordinator Cutover

## Ownership boundary

`App` currently owns initial load, debounced autosave, reconnect/realtime resync,
switch flushing, rename persistence, and several project-id refs. The cutover makes
one mount-scoped `CanvasWriteCoordinator` the only canvas I/O owner. React keeps
only UI identity, lifecycle cleanup, event routing, and accessible status.

## Small slices

1. Add an App race test proving editor-dependent controls stay disabled until the
   coordinator finishes initialization.
2. Replace `handleMount` legacy load/autosave/resync with one coordinator and the
   tldraw adapter. Install the user document listener only after initialization;
   dispose the coordinator and listeners on switch/unmount. Guard every async
   continuation by mount generation and offer an explicit retry after init failure.
3. Route realtime changes and reconnects through `requestRemoteSync` only when the
   mount coordinator owns the project. Remove `projectIdRef` and old resync state.
4. Await `flushOrThrow` before switching and keep the current project on failure.
   Keep a mount key stable across rename and advance it only after a successful
   switch. Conservatively admit same-tick edits before flushing because tldraw's
   document listener is frame-throttled. Serialize switch/rename transitions.
5. Route rename through the coordinator. Adopt committed identity from both the
   normal result and `CanvasRenameCommittedDrainError.project`, without remounting.
6. Expose coordinator status as an accessible live status and disable canvas
   controls until initialization completes. Lock mutations during rename ambiguity
   and expose same-name retry/recovery.
7. Track upload/unfurl commands on the mount, await them before switch/rename, and
   re-check generation and coordinator ownership after each await before applying
   results to the editor.

## Verification

- Focused unit/integration tests for initialization, switch failure, rename identity,
  ownership routing, cleanup, and accessible status.
- Reuse the deterministic mount/reconcile, reconnect/edit, and project-switch race
  Playwright coverage from the precursor branches where it still matches the new
  coordinator contract.
- Run focused Playwright, full `npm test`, typecheck/build, and a static search
  proving `App` has no direct canvas writers, legacy autosave/resync refs, or
  `projectIdRef` routing.
- Review every remaining effect for external synchronization, cleanup symmetry,
  stale closure risk, and accidental render/update loops.

Asset project binding remains unchanged for issue #137; this cutover does not add
or duplicate asset ownership logic.
