# Agent Transcript Height Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the in-app agent transcript to display up to 500px of conversation before scrolling.

**Architecture:** Keep the existing flex layout and viewport-relative safety limit. Increase only the transcript's pixel cap for both standard and dynamic viewport units.

**Tech Stack:** React, CSS, Vitest

---

### Task 1: Increase the transcript cap

**Files:**
- Modify: `src/components/agentBox.css:189-190`
- Test: `tests/components/AgentBox.test.tsx`

- [ ] **Step 1: Update both transcript max-height declarations**

```css
max-height: min(42vh, 500px);
max-height: min(42dvh, 500px);
```

- [ ] **Step 2: Run the focused component test**

Run: `npm test -- --run tests/components/AgentBox.test.tsx`

Expected: PASS.

- [ ] **Step 3: Commit the CSS adjustment and plan**

```bash
git add src/components/agentBox.css docs/superpowers/plans/2026-07-15-agent-transcript-height.md
git commit -m "Increase agent transcript height"
```
