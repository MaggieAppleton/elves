#!/usr/bin/env node
// Deterministic stand-in for `claude`, spawned by server/agentRun.ts during e2e.
//
// The real review runner (server/app.ts's launchReviewRun) spawns a headless
// `claude` that drives the review over the elves MCP tools (start_review →
// add_comment → complete_review). That's real model reasoning against a real
// process — nothing an e2e test can control. So instead, e2e points
// ELVES_CLI_BIN at THIS file: the server spawns it with the exact same argv a
// real `claude` would get, and it simulates one review pass by hitting the
// same HTTP endpoints the elves MCP tools call, straight from Node.
//
// It never touches Anthropic, never reasons about anything — it just parses
// the review id and project id back out of its own argv and plays the review
// state machine forward.

async function main() {
  const argv = process.argv.slice(2)

  // `-p <prompt>` carries the review id: "...id `<reviewId>`. Call `start_review`..."
  const pIndex = argv.indexOf('-p')
  const prompt = pIndex >= 0 ? argv[pIndex + 1] : ''
  const reviewIdMatch = /id `([^`]+)`/.exec(prompt || '')
  const reviewId = reviewIdMatch?.[1]

  // `--append-system-prompt <preamble>` carries the project id: 'Operate on the
  // project with id "<projectId>".'
  const sysIndex = argv.indexOf('--append-system-prompt')
  const preamble = sysIndex >= 0 ? argv[sysIndex + 1] : ''
  const projectIdMatch = /Operate on the project with id "([^"]+)"/.exec(preamble || '')
  const projectId = projectIdMatch?.[1]

  const base = process.env.ELVES_STUB_URL
  if (!base || !reviewId || !projectId) {
    console.error(
      `stub-agent: missing base url / reviewId / projectId (base=${base} reviewId=${reviewId} projectId=${projectId})`,
    )
    process.exit(1)
  }

  const reviewsUrl = `${base}/projects/${projectId}/reviews`
  const statusUrl = `${base}/projects/${projectId}/reviews/${reviewId}/status`
  const canvasUrl = `${base}/projects/${projectId}/canvas`
  const changesetUrl = `${base}/projects/${projectId}/changeset`

  const { reviews } = await (await fetch(reviewsUrl)).json()
  const review = reviews.find((r) => r.id === reviewId)
  if (!review) {
    console.error(`stub-agent: review ${reviewId} not found`)
    process.exit(1)
  }

  // Fail mode: leave the review pending (never claim it) — the server's own
  // launchReviewRun completion handler sees it still pending/in-progress once
  // this process exits nonzero, and marks it `failed`. This exercises the
  // failed+Retry UI without the stub needing to know about that state itself.
  if (review.focus === '__fail__') {
    console.error('stub-agent: simulating a failing run (focus=__fail__)')
    process.exit(1)
  }

  // Claim the pass.
  await fetch(statusUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'in-progress', agent: 'claude' }),
  })

  // Leave one tagged comment, if there's a card to hang it on. The comment
  // type must be one this personality's UI legend actually recognizes.
  const commentTypeByPersonality = {
    'devils-advocate': 'counterpoint',
    'fact-checker': 'needs-evidence',
    trimmer: 'tighten',
    'first-reader': 'unclear',
    architect: 'structure',
  }
  const commentType = commentTypeByPersonality[review.personality] ?? 'tighten'

  const canvas = await (await fetch(canvasUrl)).json()
  const records = Object.values(canvas.document?.store ?? canvas.document?.records ?? {})
  const card = records.find((r) => r && r.typeName === 'shape' && r.type === 'card')

  if (card) {
    await fetch(changesetUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: `cs-stub-${Date.now()}`,
        author: 'claude',
        ops: [
          {
            kind: 'add_comment',
            cardId: card.id,
            comment: { type: commentType, text: 'stub note', reviewId },
          },
        ],
      }),
    })
  }

  // Complete the pass.
  await fetch(statusUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'done', verdict: 'Stub verdict — looks fine.' }),
  })

  process.exit(0)
}

main().catch((err) => {
  console.error('stub-agent: unexpected error', err)
  process.exit(1)
})
