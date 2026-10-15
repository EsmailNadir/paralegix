---
name: qa-sweep
description: Run one iteration of the browser QA sweep: pick the next untested feature from the QA matrix, exercise it, fix what is broken, record the result.
disable-model-invocation: true
---

# QA Sweep (one iteration)

Exercise Paralegix in a real browser, one feature at a time, and fix what breaks. This
skill is designed to be run repeatedly by `/loop`, so **each invocation must be
self-contained and must leave its state on disk**, not in the conversation.

**Prerequisite:** the browser steps below use the `mcp__playwright__*` tools (`browser_click`,
`browser_type`, and the rest). That MCP server is NOT configured in this repo or in the user's
Claude config, so the tools are usually absent. Confirm they exist before starting a sweep. If
they do not, say so and stop: a sweep that cannot drive the browser cannot record a real result,
and writing "passed" from a skipped run corrupts the matrix. `preview_start` is from the Browser
pane and is always available, which is why the server-start step uses it.

State lives in:

- `.claude/qa/FEATURES.md` — the feature matrix (what has been tested, what passed)
- `.claude/qa/bugs/<ID>-<slug>.md` — one file per bug found
- `.claude/qa/runs/<YYYY-MM-DD>.md` — append-only run log

## Iteration procedure

### 1. Read the matrix first

Read `.claude/qa/FEATURES.md` before anything else. Areas are worked in order —
**Matters, then Tasks, then Files, then Messages**. Within the current area:

1. Re-test any `fail` rows first (an earlier fix may have resolved them).
2. Then any `blocked` row whose stated dependency has since passed (check the Bug column
   for what it's waiting on, e.g. a row blocked on another row's feature landing becomes
   testable once that row shows `pass`).
3. Otherwise take the lowest-numbered `todo` row.

Do not skip ahead to a later area while the current one still has `todo` rows.

If every row in every area is `pass`, `fixed`, `blocked`, or `deferred`, the sweep is
complete: report that, and if running under a dynamic `/loop`, end the loop rather than
scheduling another wakeup.

### 2. Bring the app up

Check whether the servers are already running before starting anything:

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000
```

If they are not up, start them with `preview_start` using the launch-config names from
`.claude/launch.json` — never `npm run dev`/`npm start` in Bash, so the servers stay
listable and stoppable:

1. `preview_start` with `{ name: "backend-no-watch" }` → http://localhost:5001
2. `preview_start` with `{ name: "frontend" }` → http://localhost:3000

**Use `backend-no-watch`, not the plain `backend` config.** `backend` runs `npm run dev`
(`tsx watch server.ts`), which restart-thrashes during a sweep (the Playwright MCP writes snapshot
and console files into the repo root on every call). A restart mid-test makes the next
request fail with `ERR_CONNECTION_REFUSED`, which looks exactly like an app bug and wastes
an iteration chasing it. `backend-no-watch` runs `npm start` instead, so nothing reloads
underneath you — but that means if you change backend code to fix something, you must
rebuild and restart it before re-verifying: `npm run build` in `backend/`, then `preview_stop`
and `preview_start`. `npm start` serves the compiled `dist/`, so a restart without a build still
runs the old code.

**Only stop servers this iteration started.** If they were already running, leave them
alone — the next loop iteration will reuse them, which is the whole point.

### 3. Drive the browser

Follow the `playwright-mcp-testing` skill for login and navigation. The parts that bite
every time:

- Log in as `test3@gmail.com` / `password`. The persisted profile may already be signed
  in as the client; sign out first if so.
- Go straight to `/lawfirm/1354e5d3-1b94-46b2-b78d-0e04faece7d4` — the owner belongs to
  two firms and login lands on either.
- Sidebar `<Link>` clicks often do not trigger Next.js navigation. Use
  `browser_evaluate` → `document.querySelector('a[href="..."]').click()`.
- Matter tabs are deep-linkable. The eleven values in `MATTER_TABS` are
  `?tab=overview|tasks|events|clients|contacts|messages|team|notes|time-tracking|billing|documents`.

Three harness gotchas that will otherwise cost you a false bug report every time:

- **`browser_click` often does not fire React `onClick`.** Dropdowns and toggles stay
  shut. Use a native DOM click:
  `browser_evaluate` → `Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('...')).click()`.
- **`browser_type` / `fill` does not reliably update React state.** The DOM value changes
  but the component keeps the old value, so filters silently keep applying. Set it
  through the native setter and dispatch an input event:
  ```js
  const set = (el, v) => {
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    s.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  ```
  Always read the value back afterwards to confirm it took.
- **`browser_drag` does not work on the dnd-kit drag surfaces** (dashboard widgets and
  the sidebar order in Settings, Customization; every kanban board was removed).
  `PointerSensor` has `activationConstraint: { distance: 5 }` and needs a real event
  sequence; Playwright's `dragTo` fires a single move and nothing happens. Dispatch the
  sequence yourself: `pointerdown` on the card, ~12 `pointermove` events on `document`
  stepping toward the target, then `pointerup`, with short awaits between. Then wait
  ~1s before reading the result: a failed save reverts only once the request rejects,
  so reading too early shows a success that is about to undo itself.
- **Modals are `<div role="dialog">`, not `<dialog>`.** `document.querySelector('dialog')`
  returns null whether the modal is open or closed, so it is useless as an open/closed
  check. Query `[role="dialog"]` instead.

Before reporting a bug, rule out the harness first: confirm the input values and filter
state are what you think they are. A stale filter looks exactly like a broken query.

Test the feature the way a user would: perform the action, then confirm the result
actually persisted. A row is only `pass` if you saw the effect survive a reload or a
refetch. Rendering without an error is not a pass.

Check `browser_console_messages` and `browser_network_requests` for each row. A silent
500 or an unhandled promise rejection is a `fail` even if the screen looks fine.

### 4. When something is broken

Write the bug file **before** attempting a fix, so the finding survives even if the fix
goes badly. `.claude/qa/bugs/<ID>-<short-slug>.md`:

```markdown
# <ID> — <one-line summary>

- **Area / row:** <e.g. Matters / M14 Tab: Clients>
- **Found:** <date>
- **Severity:** high | medium | low

## Repro
1. ...
2. ...

## Expected
## Actual
## Evidence
<console error, failing request + status, or screenshot path>

## Root cause
## Fix
<files changed, or "deferred — reason">
```

Then fix it, and **re-verify in the browser**. A fix is not done because the code looks
right; it is done when you re-ran the repro and the bug is gone. Mark the row `fixed`.

> **Add a regression test for anything you FIX during a sweep.** Tests are required on this
> repo. Run the one backend test file directly (`npx jest path/to/thing.test.ts`), never the full
> `npm test`: it runs in process against a per-worker Postgres with no server and no Firebase
> credentials. Use `tests/support/setupInProcess.ts`.
>
> The browser repro stays the discovery tool: it is how a sweep finds the problem. It is not the
> record that the problem stays fixed.

**Know when to stop.** If a fix would touch more than a handful of files, requires a
schema migration, or is architectural, do not attempt it inside a loop iteration. Write
the bug file, mark the row `deferred`, and move on. An unattended loop making
architectural changes is how you wake up to a broken branch.

### 5. Stop condition for the iteration

End the iteration when **either**:

- you fixed a bug (one fix per iteration — keeps the diff reviewable), **or**
- you have passed four rows.

Then update `.claude/qa/FEATURES.md` (status, last-tested date, bug link) and append to
`.claude/qa/runs/<YYYY-MM-DD>.md`:

```markdown
- HH:MM — M14 pass, M15 pass, M16 fail (bug: M16-matter-thread-500), M16 fixed
```

### 6. Report

Close with a short summary: rows tested, rows passing, bugs found, bugs fixed, and how
many rows remain. Keep it to a few lines — under `/loop` this prints every iteration.

## Standing rules

- **Never commit or push.** Leave everything uncommitted on the current branch, per
  `AGENTS.md`. The user reviews and commits.
- **One fix per iteration.** Bounded diffs stay reviewable.
- Prefer real fixes over test workarounds. If the app is wrong, fix the app.
- Test data is disposable — this is the local dev database. Create matters, tasks, and
  files freely rather than mutating data another row depends on. Clean up only what
  would confuse a later row.
- If a row cannot be tested (plan gate, needs a second concurrent browser session,
  missing fixture), mark it `blocked` with the reason. Don't fake a pass.
- Never disable, skip, or weaken an assertion to make something look green.
