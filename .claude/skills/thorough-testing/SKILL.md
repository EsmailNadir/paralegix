---
name: thorough-testing
user-invocable: false
description: Use when writing or expanding backend or frontend test coverage, for a new route, a bug fix, a feature, or a coverage-gap sweep.
---

# Thorough Testing

## Overview

A test suite that only exercises the happy path proves the demo works. It proves nothing
about the inputs a real law firm actually sends: the empty string, the already-deleted
record, the second request that arrives while the first is still writing, the id that
belongs to a different firm. Those are where this codebase's real defects tend to live,
not in the golden path, which every manual click-through already covers.

**Core principle:** name what has to break for a test to go red. If you cannot name a
concrete input or state transition that would flip the assertion, the test does not
belong in the suite yet, no matter how it reads. This is the same bar `AGENTS.md`'s
"Tests are required" section already sets; this skill is about how to reach it.

## Before writing a test

1. **Read the real source first.** Grep the function or route the scenario is about
   before assuming a gap exists. Writing a test against an assumption of how the code
   *should* work, rather than how it *does*, produces either a false failure or a
   vacuous pass.
2. **Check for existing coverage.** Search the target's test file and sibling files for
   a `describe`/`it` that already exercises this shape. Three copies of the same
   assertion under different names is padding, not depth — see Reuse below.
3. **Decide: new feature, bug fix, or characterization?** If the code doesn't exist yet, follow
   `test-driven-development` from the start — write the test against the wished-for behavior,
   watch it fail because the feature is missing, then implement. If the code exists and is
   already wrong, follow `test-driven-development` — red first, against the unfixed code. If the
   code does exactly what it was built to do and the question is only whether that's a gap in
   test coverage, write the test against the real, current behavior.

## What "in-depth" means, concretely

Beyond the golden path, work through:

- **Boundary and shape**: empty string vs. missing field vs. null vs. whitespace-only;
  zero, negative, and max values; an array with one item, zero items, and duplicates.
- **Cross-tenant and cross-entity**: does this scope by `law_firm_id`, or by the
  narrower record (client, matter, organization) the caller should be confined to? A
  positive case ("the owner can see it") proves nothing without the paired negative
  ("a different firm's owner cannot").
- **State transitions, not just current state**: what a record looked like a moment
  ago and what it becomes after a delete, a revoke, a status change, or a re-link. A
  revoke that didn't invalidate a cache, or a delete that left a dependent row
  orphaned, is only visible in the *transition* and invisible in a static snapshot of
  either state alone.
- **On a frontend detail page specifically, check two shapes that have each recurred
  more than once in this codebase without anyone specifically looking for them:**
  (1) a single `error` state shared between the initial load and every action handler
  on the page (delete, status change, remove a linked record, ...) — since the loaded
  entity is never cleared once populated, gating the "not found" fallback on
  `error || !entity` rather than `!entity` alone means a REFUSED ACTION blanks the
  whole page into a not-found panel instead of showing a banner on the page that's
  still right there; (2) a page whose data loading is plain `useState`/`useEffect`
  (no React Query) has no built-in guard against a slow in-flight fetch for the OLD
  entity id overwriting state after the viewer navigated to a different instance of
  the same dynamic route (browser back/forward can reuse the page instance rather
  than remounting it) — fix with a generation-counter ref, not by assuming React
  Query is always in the data path.
- **Concurrency, where two requests can race.** A bare `Promise.all` does not prove two
  operations overlapped; use `tests/support/gate.ts` to hold both inside the contested
  function and assert `waiting() === 2` before releasing them. It replaced a suite full of
  `await Promise.all([withdraw(), withdraw()])`, which starts two requests and then hopes:
  Node runs one callback at a time, so the second may not reach the contested read until the
  first has committed, and the test then passes just as happily against code with no locking
  at all. `tests/support/gate.ts` explains the rest.

  When the two racing operations are HTTP requests through supertest, fire each one
  through an `async function` that `return`s the supertest chain
  (`async function fire() { return api.put(url).send(body); }`), never a bare
  `const req = api.put(url).send(body)` assignment. Superagent does not dispatch a
  request until something calls `.then()`/`.end()` on it, and a plain assignment does
  neither — the request silently never sends until something later `await`s it, which
  defeats a `gate.arrived()` wait completely and looks exactly like a gate-wiring bug
  (`entered() === 0`, timeout) when the gate was correct the whole time. Returning a
  thenable from an `async function` is what actually triggers dispatch, because the
  language itself calls `.then()` on it to adopt the resolution. This cost a full
  session's stuck attempt before being found.
- **The error path, not only the success path.** A malformed-input case that gets
  ignored, an unauthorized caller that gets a misleading status code, a partial failure
  midway through a multi-step operation — these are exactly where a `500` hides where a
  `400` or `403` belongs.
- **Through the real route or service**, using the harness described in
  `.claude/rules/backend-tests.md` (`tests/support/setupInProcess.ts`) or the frontend transport
  harness in `.claude/rules/frontend-tests.md`. A test that mocks the function under test cannot
  detect a defect in that function.

Before trusting a new test, mutation-test it: temporarily break the exact line it
claims to guard, confirm the test goes red for that reason, then revert. If it doesn't
go red, it isn't testing what you think.

**Name the test as a sentence, not a template.** This repo does not use `WhenX_ShouldY`
or `Given/When/Then` naming. An `it(...)` string states the behavior and, where it
matters, why it matters: `'a billing-enabled roster member loses the organization trust
balance on removal'`, not `'test_trust_balance_removed'`. A reader should be able to
tell what broke from the test name alone, before opening the failure diff.

## Reuse across features

`AGENTS.md`'s "Matters, tasks and clients grow the same features" section already names
the trap for *source* code: the same capability gets built three times, and the copies
drift. The identical trap exists for *tests*. Before writing a scenario for one of these
repeated shapes (notes, events, attached clients, time tracking, messages, or any
capability matters/tasks/clients all carry), check whether a sibling entity already has
a test for it:

- If the sibling's test is scenario-shaped rather than entity-shaped (it takes an
  adapter, a fixture factory, or a parameterized target rather than hardcoding "matter"),
  extend it to cover the new entity instead of writing a parallel file.
- If no shared shape exists yet and you're about to write the third near-identical copy,
  that's the signal to extract one, the same threshold the source-code section uses.
- The shared test harness, which expects reuse rather than reinvention, is at `frontend/tests/support/` (`apiMock.ts`, `permissions.ts`,
  `renderWithProviders.tsx`) and `backend/tests/support/` (`setupInProcess.ts`,
  `gate.ts`, `factories.ts`). Extend a helper there before hand-rolling a new one.

## Routing what you find

Testing in depth surfaces things. Route each one correctly — this is the part that's
easy to get backwards:

**It's a bug. Fix it in the code, right now, in this change.** A bug is code that
doesn't do what it was clearly built to do: a scoping check that's missing, a status
code that contradicts its own error message, a null check that should be there and
isn't, a race with no lock where the code's own comments assume one. Follow
`test-driven-development`: red against the unfixed code, fix, green. Do not write it
into a document instead of fixing it, and do not leave it half-fixed with a comment
promising a follow-up.

**It's a functionality question. Log it, don't change it.** Some behavior is
deliberate, passes its own tests, and still doesn't fit how a law firm actually works —
or diverges from what a comparable product (Clio, for instance) does in the same spot.
That's not yours to silently "fix": it's a product decision. Record it in
`docs/superpowers/functionality-questions.md` using the existing entry format (What the
code does / Why it may not fit / Elsewhere, if you're confident of the comparison /
Decision: open), pin the current behavior with a CHARACTERISATION test so it can't
silently change underneath the open question, and move on. Do not block the test work
you're actually doing on getting a product decision.

The dividing line: if the fix is "make the code do what it already claims to do," it's
a bug — fix it. If the fix would be "make the product work differently than it was
designed to," it's a functionality question — log it.

## Recording the work

If you're working through a tracked plan (`docs/superpowers/plans/*.md`), record progress
in it rather than leaving the result only in conversation, since the plan is how the next
session picks up where this one left off. A tick names the exact command that produced a
pass, not just a claim that it passed. A plan is deleted once its phases ship (see
`docs/superpowers/plans/README.md`), so anything durable moves out of it first.
