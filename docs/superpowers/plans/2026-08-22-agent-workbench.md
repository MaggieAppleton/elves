# Agent Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the `/` agent entry point into a scoped command dock with useful, non-auto-running suggestions and a clear active-run hierarchy.

**Architecture:** A pure suggestion module chooses bounded prompt text from selection scope. `AgentBox` owns suggestion insertion and continues to own run/transcript state. CSS and semantic event wrappers distinguish a user request, agent prose, tool progress and final/error states without changing the agent stream protocol.

**Tech Stack:** TypeScript, React 18, Vitest, react-test-renderer, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-22-annotations-and-agent-workbench-design.md`

## Global Constraints

- Suggestions insert text only; they never send or start an agent run.
- `/` remains literal in editable content and Escape never cancels a run.
- The existing one-run-at-a-time, cancellation, collapse and transcript history contracts remain unchanged.
- The command dock and status pill stay bottom-centre and do not compete with the annotation right rail.

---

### Task 1: Scope-aware suggestions and command dock

**Files:**
- Create: `src/client/agentSuggestions.ts`
- Modify: `src/components/AgentBox.tsx`
- Modify: `src/components/agentBox.css`
- Test: `tests/client/agentSuggestions.test.ts`
- Test: `tests/components/AgentBox.test.ts`
- Test: `e2e/agent-box.spec.ts`

**Interfaces:**
- Produces: `agentSuggestions(hasSelection: boolean): readonly AgentSuggestion[]`, where `AgentSuggestion = { id: string; label: string; prompt: string }`.
- Consumes: existing `selectedCount`, `prompt` state and `submit` function in `AgentBox`.

- [ ] **Step 1: Write failing pure and component tests**

```ts
import { agentSuggestions } from '../../src/client/agentSuggestions'

test('selection suggestions are scoped editorial prompts', () => {
  expect(agentSuggestions(true).map((s) => s.prompt)).toEqual([
    'Critique the selected cards.',
    'Find claims in the selected cards that need evidence.',
    'Suggest a clearer structure for the selected cards.',
  ])
})
```

```tsx
test('a suggestion fills but does not send the prompt', () => {
  const send = tree.root.findByProps({ 'data-testid': 'agent-send' })
  tree.root.findByProps({ 'data-testid': 'agent-suggestion-critique' }).props.onClick()
  expect(tree.root.findByProps({ 'data-testid': 'agent-input' }).props.value).toBe('Critique the selected cards.')
  expect(send.props.disabled).toBe(false)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client/agentSuggestions.test.ts tests/components/AgentBox.test.ts`

Expected: FAIL because the suggestion module and test ids do not exist.

- [ ] **Step 3: Implement fixed, scope-aware suggestion buttons**

```ts
export function agentSuggestions(hasSelection: boolean): readonly AgentSuggestion[] {
  return hasSelection ? SELECTED_SUGGESTIONS : CANVAS_SUGGESTIONS
}
```

```tsx
{!hasTranscript && (
  <div className="elves-agentbox__suggestions" aria-label="Suggested agent tasks">
    {agentSuggestions(hasSelection).map((suggestion) => (
      <button key={suggestion.id} type="button" data-testid={`agent-suggestion-${suggestion.id}`}
        onClick={() => setPrompt(suggestion.prompt)}>{suggestion.label}</button>
    ))}
  </div>
)}
```

Keep the selection scope chip prominent, add a quiet keyboard hint, and hide
suggestions after the first submitted message. Do not alter `runAgent`, request
payloads or `submit` semantics.

- [ ] **Step 4: Run focused verification**

Run: `npx vitest run tests/client/agentSuggestions.test.ts tests/components/AgentBox.test.ts && npm run e2e -- e2e/agent-box.spec.ts`

Expected: PASS; suggestion click fills input, Enter and Send remain the only run
triggers, and `/` remains literal while editing a card or the composer.

- [ ] **Step 5: Commit**

```bash
git add src/client/agentSuggestions.ts src/components/AgentBox.tsx src/components/agentBox.css tests/client/agentSuggestions.test.ts tests/components/AgentBox.test.ts e2e/agent-box.spec.ts
git commit -m "feat(agent): add scoped command suggestions"
```

### Task 2: Transcript event hierarchy and activity polish

**Files:**
- Modify: `src/components/AgentBox.tsx`
- Modify: `src/components/agentBox.css`
- Test: `tests/components/AgentBox.test.ts`
- Test: `e2e/agent-box.spec.ts`

**Interfaces:**
- Consumes: existing `Entry`, `deriveStatus`, `runPhase`, collapse and cancellation state.
- Produces: stable transcript event selectors: `data-kind="user|text|tool|error|working"` and `data-testid="agent-result"` for terminal prose.

- [ ] **Step 1: Add failing hierarchy tests**

```ts
test('streamed tool activity is presentationally distinct from the final result', async ({ page }) => {
  await openReadyCanvas(page)
  await page.keyboard.press('/')
  await page.getByTestId('agent-input').fill('critique this')
  await page.getByTestId('agent-send').click()
  await expect(page.locator('[data-kind="tool"]')).toContainText('read map')
  await expect(page.getByTestId('agent-result')).toContainText('Found two weak spots.')
})
```

- [ ] **Step 2: Run the E2E test to verify it fails**

Run: `npm run e2e -- e2e/agent-box.spec.ts`

Expected: FAIL because transcript lines have no event-kind contract or terminal-result selector.

- [ ] **Step 3: Add semantic event wrappers and visual hierarchy**

```tsx
<p className="elves-agentbox__tool" data-kind="tool" key={i}>…</p>
<p className="elves-agentbox__text" data-kind="text" data-testid={isLastAgentText ? 'agent-result' : undefined} key={i}>…</p>
<p className="elves-agentbox__working" data-kind="working" aria-live="polite">…</p>
```

Use CSS to make request bubbles secondary, tool lines compact and muted, result
prose visually complete, and errors unmistakable. Keep the collapsed status
pill as the non-blocking active state; do not move it to the annotation rail or
change its click/cancel behavior.

- [ ] **Step 4: Run full agent verification**

Run: `npm test -- tests/client/agentStatus.test.ts tests/components/AgentBox.test.ts && npm run typecheck && npm run e2e -- e2e/agent-box.spec.ts e2e/references.spec.ts`

Expected: PASS; transcript hierarchy is semantic, collapse preserves the run,
and the existing short-viewport sweep remains green.

- [ ] **Step 5: Commit**

```bash
git add src/components/AgentBox.tsx src/components/agentBox.css tests/components/AgentBox.test.ts e2e/agent-box.spec.ts
git commit -m "feat(agent): clarify run activity hierarchy"
```
