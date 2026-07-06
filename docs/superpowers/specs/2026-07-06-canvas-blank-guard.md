# Guard against blanking a canvas (data-loss fix)

**Date:** 2026-07-06
**Status:** Approved, implementing

## Incident

On 2026-07-05 the "Augment Essay" project (`data/projects/my-first-essay`) was blanked:
`canvas.json` was overwritten with the empty sentinel `{"document":null,"session":null}`,
losing 117 cards. Recovered from the rolling `canvas.json.bak` (see `server/store.ts`).

### Root cause (confirmed)

Not a client load-race. It was a misconfigured e2e run hitting the live dev server:

1. `e2e/helpers.ts` defined `BASE = process.env.ELVES_E2E_BASE ?? 'http://localhost:5199'`.
2. An e2e run set `ELVES_E2E_SERVER_PORT=5399` / `ELVES_E2E_WEB_PORT=5373` but **not**
   `ELVES_E2E_BASE`. Playwright started its own isolated server on 5399, but the test
   helper's `BASE` fell back to `http://localhost:5199` — the developer's **real** dev
   server, serving real data.
3. `resetProject` runs in every test's `beforeEach`: `GET /projects` → takes
   `projects[0]` → `POST /projects/<id>/canvas` with `{document:null,session:null}` to
   "reset" it. Against the real server, `projects[0]` was `my-first-essay` ("Augment Essay").
4. The server's `POST /canvas` handler (`server/app.ts`) wrote the body unconditionally,
   so the empty sentinel blanked the real canvas. The `.bak` in `store.ts` preserved the
   last good document, which is what made recovery possible.

Two latent defects combined to let a misconfigured test destroy real data:

- **Server:** a "save" can blank a canvas that holds a real document. There is no guard.
- **E2e harness:** `ELVES_E2E_SERVER_PORT` and `ELVES_E2E_BASE` are independent knobs;
  override one without the other and the *destructive* `resetProject` silently targets
  whatever is on :5199, blanking an arbitrary `projects[0]`.

## Fix — defense in depth

### Layer 1 — server: a save can never blank a non-empty canvas

- `writeCanvas` refuses to overwrite a canvas that currently holds a real document with
  one that has no document (`document == null`). It throws `EmptyCanvasOverwriteError`.
  - Incoming has a real document → always allowed (normal saves; a mounted tldraw store
    always serializes a non-null `document`, even with zero cards).
  - Incoming has no document, on-disk is empty/missing → allowed (nothing to lose).
  - Incoming has no document, on-disk has a real document → **refused** (the data-loss case).
- `POST /projects/:id/canvas` translates `EmptyCanvasOverwriteError` into **409** and does
  not write.
- A new **`DELETE /projects/:id/canvas`** endpoint provides the *explicit, intentional*
  clear (backs the current document up to `.bak`, then removes the file so a subsequent
  read returns the empty sentinel). Clearing is now a distinct operation from saving.

This alone would have prevented the incident: the misconfigured `resetProject`'s empty POST
would have returned 409 and left the real canvas untouched.

### Layer 2 — e2e harness: tests can't accidentally target real data

- `e2e/helpers.ts`: derive `BASE` from the **same** env var the Playwright config keys off
  (`ELVES_E2E_SERVER_PORT`), so the base and the server port cannot diverge. Overriding the
  port automatically moves the base to the isolated server.
- `resetProject` clears the test canvas via the new `DELETE` endpoint instead of POSTing the
  empty sentinel (which the Layer-1 guard now refuses).

## Behavior change

The existing store test `'a degenerate write cannot clobber a good backup with junk'`
encodes the *old* behavior (an empty write lands on the main file; `.bak` recovers it). Under
the new guarantee the empty write is **refused outright**, so that test is rewritten to assert
the main file and `.bak` are both left intact.

## Out of scope

- No change to the client save path — it already guards with `canvasLoadedRef` and never
  serializes a null document; it was not the cause here.
- The `.bak` mechanism stays as a second line of defense (e.g. a document-bearing but lossy
  write the guard can't detect).

## Files

- `server/store.ts` — `hasDocument`, `EmptyCanvasOverwriteError`, guard in the write path, `clearCanvas`.
- `server/app.ts` — 409 on refused save; `DELETE /canvas` route.
- `e2e/helpers.ts` — base derived from server port; `resetProject` clears via `DELETE`.
- `tests/server/store.test.ts` — rewrite the clobber test; add guard + `clearCanvas` tests.
- `tests/server/api.test.ts` — 409-on-blank, `DELETE`-clears, empty-allowed-when-empty tests.
