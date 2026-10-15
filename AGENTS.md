# AGENTS.md

Guidance for coding agents. This file holds only what applies repo-wide; `frontend/AGENTS.md`,
`backend/AGENTS.md` and `docs/AGENTS.md` (the separate VitePress site) hold each package's layout,
commands and patterns, and `.claude/rules/` holds the area-specific rules that load on demand. The
`CLAUDE.md` files are thin pointers that import their sibling `AGENTS.md`: edit the `AGENTS.md`.

Paralegix is a legal practice management SaaS. Law firms manage matters, tasks, time entries, invoices, clients, and messaging. Clients have a separate portal. Calendar sync with Google and Outlook is supported.

## Terminology

**"Matter"** is the canonical term for a legal case or engagement everywhere: the route, module,
tables and all UI copy. Keep new code, copy and comments on "matter(s)". "Case" is legitimate only
in its plain-English sense, in `switch`/`case`, and in `snake_case` names.

**"Organization" / "Org"** is the canonical UI term for a non-person client. Keep new labels,
tooltips and badges on it. The database enum `client_type = 'company'` and the internal API
parameter keys stay as they are.

## Git & Branching

Make changes directly in the working tree on the current branch and leave them **uncommitted**.
Do NOT create feature branches for routine work, and do NOT run `git commit` or `git push`. Only
commit or push when the user asks in that request, and a push request applies to that turn only,
not to the rest of the session. `/push-to-branch` commits and pushes the current branch.
`/push-to-staging` merges the branch into `staging` and applies its migrations first.

**Several Claude sessions share this one checkout.** A commit sweeps in their uncommitted work
too, so list what you are about to include before committing.

## Browser Verification

Do NOT open the Browser pane or preview tools (`preview_start`, `navigate`, `computer`) to click
through a change unless the user asks for it in that request. Ship the change, confirm it lints,
typechecks and builds, then stop. The user reviews behavior themselves. This overrides the
general "verify in a browser before claiming done" default.

## Tests are required, not optional

**Every change ships with tests.** Add them for new behaviour, and update them when you change
behaviour they already cover. This is not a preference: the backend suite is the only thing
standing between a change and a cross-firm data leak, a wrong invoice, or an overdrawn trust
account, and none of those look wrong on screen.

- **New route or service function**: write the test first, through the real route, then write the
  code that makes it pass.
- **Bug fix**: a test that FAILS before the fix and passes after. If it passes on the broken code
  it does not cover the bug.
- **Changed behaviour**: find the specific test that pinned the old behaviour and change only the
  assertion tied to the intended change. Every other pre-existing test stays untouched.
- **Refactor with no behaviour change**: the existing tests stay green untouched.

**Name what has to break for a test to go red.** If you cannot, delete it. The recurring failure
here is a test that passes while proving nothing: an absence asserted before proving the action
ran, a status asserted where the behaviour is content, a `??` fallback chain, or no data seeded
for the thing under test. Break the code a green test claims to protect and watch it fail.
Follow `test-driven-development` for the cycle and `thorough-testing` for depth.

### Before you call it done

- **Typecheck and lint** for the package you touched. Seconds, and non-negotiable.
- **The test(s) for what you changed**, run directly (`npx jest path/to/thing.test.ts`, or
  `--findRelatedTests <changed files>`), not the whole suite.

**Never run the full backend `npm test` unless the user explicitly asks.** It is memory-heavy:
four workers each hold the whole app graph, beside the Postgres container. It is no longer slow,
so that half of the old reason is gone: about 750 suites, a few minutes on four workers. The frontend
`test:unit` is seconds and close to free. When a full backend run is genuinely needed, the
`backend-testing` skill has the memory lever and the failure index.

A failing command means the change is not done yet. Fix it and rerun, rather than reporting the
failure as a caveat alongside "done".

Never state that tests, lint, or the build pass without having run them in that same message
(`verification-before-completion`).

## Guard hooks

Three `PreToolUse` hooks (`.claude/hooks/`, registered in `.claude/settings.json`) enforce what
prose cannot. A block is **not** a tool failure or a permissions problem; confirm with the user
instead of rephrasing around it.

- **`guard-bash.js`** blocks nine command shapes: recursive delete, force push, hard reset, a fork
  bomb, a GitHub Actions dispatch or re-run, a production database target, the production
  override flag, and a schema reset.
- **`guard-edit.js`** blocks introducing an em-dash into a `.ts`, `.tsx`, `.js`, `.jsx`, `.sql`,
  `.css` or `.json` file or a page under `docs/`, and blocks an Edit to an existing numbered
  migration (write a new one instead; `Write` is exempt so new files can be created).
- **`guard-doc-size.js`** blocks an edit that grows an `AGENTS.md` or a `.claude/rules/` file past
  **220 lines**, or a `SKILL.md` past **500**. It is a ratchet: a file already over budget can
  still be repaired, and an edit that shrinks a file is never blocked. Overflow belongs in a
  path-scoped rule or a skill `references/` file, not in a longer doc. Run
  `node .claude/hooks/guard-doc-size.js --report` to see every budgeted file and its headroom.

`guard-bash.js` and `guard-edit.js` match the raw string, so they also block a harmless command
that merely quotes one of those patterns. Write that content through a file rather than inline.

## Codebase Search

Prefer `ast-grep` over grep (`sg` is a deprecated alias that prints a warning) for structural searches: every call site of a pattern,
every component taking a prop, every route handler of a given shape. It matches AST shape, so
formatting and substring collisions (`case` in a `switch` versus the legal sense) do not fool it.
Plain grep is fine for a single-string lookup.

## Dev Commands

`npm run dev` and `build` work everywhere; `typecheck` and `lint` only in the code packages, not
`docs/`. Backend runs on 5001, frontend on 3000, docs on 3005, and all three run at once. No
monorepo tooling: each package has its own `node_modules`, so `npm install` runs in each.

Two that are not what you would guess:

- **Frontend**: `npm run ci:checks` is the real gate (lint, typecheck, and seven guards).
  `npm test` is `test:unit`, the offline half only. `next build` type-checks but does not lint.
- **Backend**: `npm test` is the whole `unit` Jest project. Do not run it unless asked. `npm start`
  runs the built `dist/`, so it needs `npm run build` first. Local Postgres runs under **Podman**,
  not Docker; see `backend/AGENTS.md`.

## CI

`.github/workflows/ci.yml` runs on **manual dispatch only** (`workflow_dispatch`). **Do not
trigger it unless the user explicitly asks for a GitHub Actions run in that request.**
`guard-bash.js` blocks the dispatch and re-run verbs, including the read-only watch, so
tailing an already-running job is refused too. This is a cost
control: the account's Actions budget is capped at $0, so an unscheduled run burns the free-tier
allowance and gets killed mid-job. Verify locally instead.

Three jobs run when it is dispatched: `backend-static` (typecheck, lint, nine guards),
`backend-tests` (the sharded `unit` project plus Codecov), and `frontend` (`ci:checks`, which
already includes typecheck, then `test:unit` pinned to `TZ=America/Los_Angeles`). The `check-builds` agent holds the
per-job detail and is the authority when this summary drifts.

The backend deploy is a second, separate gate. `backend/cloudbuild.yaml` re-runs typecheck, lint
and four guards, compiles, then boot tests the built server against `/api/health`. Neither file
runs the test suite.

## Architecture

**Monorepo**: `frontend/` (Next.js 16, React 19, TypeScript) + `backend/` (Express 5, CommonJS)

**Database**: Postgres (Supabase), the sole data store. Drizzle is the application query layer over the single `pg` pool in `backend/src/shared/database/db.ts`; the connection string comes from `resolveDbUrl()`, which reads `DATABASE_URL_${DB_TARGET}` first and falls back to `DATABASE_URL`. SQL files remain the schema/migration authority. | **Auth**: Firebase Auth (Google/Microsoft OAuth + email) | **Storage**: GCS | **Deploy**: Vercel (frontend) + GCP Cloud Run (backend)

**Environments**: `main` → production. The `staging` branch is deployed at `https://staging.paralegix.com` with a dedicated backend at `https://api-staging.paralegix.com`, with its own Supabase project, GCS bucket and Stripe test-mode keys. It is not fully isolated: there is no production Supabase project yet, and Firebase Auth may still be shared. Use staging for pre-release testing. Runbook: `docs/STAGING_SETUP.md`.

> **⚠️ `main` is not this codebase yet.** Everything in these docs is on the **`staging`
> branch**. `main` still carries the old stack, so it is thousands of files away and is useless
> as a diff baseline. Compare against `origin/staging` until the cutover lands.

## Data Model

`backend/db/schema.sql` is the source of truth (105 tables), with numbered migrations layered on
top in `backend/db/migrations/*.sql`. The chain that ran to `0262` was folded into `schema.sql`,
staging was rebuilt from it, and the numbering restarted at `0001`. `schema.sql` is GENERATED from `backend/db/schema/*.sql`: edit a
domain file, never `schema.sql`, and run `npm run db:catalog-parity` to prove both paths agree. Grep it before assuming a table does not exist. The table inventory
loads from `.claude/rules/backend-data-model.md` when you open anything under `backend/db/`.

Four rules that apply everywhere, including the frontend:

- **Multi-tenancy**: nearly every table carries a `law_firm_id` (uuid, FK to `law_firms`). The primary key stays `(id)` or a natural composite; what 55 tables add is a SECONDARY `unique (law_firm_id, id)`, which is what composite foreign keys point at. Scoping is the app's job, enforced by audited Drizzle query contexts. Every table is flat, with FK columns rather than nesting.
- **Money** is integer cents (`*_cents`, `bigint`); some derived totals are `generated always as ... stored`. Never store or send a float.
- **Dates**: day-only fields are `date` and come back as raw `'YYYY-MM-DD'` strings (node-pg parser for oid 1082); `timestamptz` keeps pg's own parser and comes back as a JS `Date`, which `rowIso()` shapes to ISO for the wire.
- **User types**: `firm_member`, `client`, `pending`.
- **Never copy a name into another table** (`*_name` columns) and **never add a `(type, id)`
  pair**. Join at read; give a row one nullable FK per possible parent plus a CHECK. Schema work
  reads `.claude/rules/backend-data-model.md` first, and `tests/schema/conventions.test.ts`
  enforces it. Adding a table, column, index or migration is the `new-migration` skill.

## UI Consistency

Paralegix has one visual language, defined by what already ships, not by your taste and not by
this file. Reproduce it; never design. If a reader can tell which screen was built most recently,
it is wrong.

**Invoke the `paralegix-frontend` skill before building or changing anything visible.** It owns
the decision procedure, the exemplar to copy per surface, the measured value for every primitive,
the `src/components/ui/` inventory, the token vocabulary, and the list of files that look like
precedent but are drift. When there is genuinely no precedent, say so and ask instead of
inventing a pattern. A one-off becomes what the next person copies.

## Environment

**`backend/.env.example` is the tracked, authoritative list.** Read it rather than any prose
summary. Per-package detail lives in each `AGENTS.md`; `docs/STAGING_SETUP.md` has the staging set.

The one cross-cutting variable: **`DB_TARGET`** (`local` | `staging` | `prod`) selects
`DATABASE_URL_LOCAL` / `_STAGING` / `_PROD`, falling back to `DATABASE_URL` when unset. See
`backend/src/shared/database/resolveDbUrl.ts` and the `local-database` skill.

`backend/serviceAccountKey.json` is gitignored and required for local dev (Firebase Auth/GCS only).

## Code Conventions

Comments must describe what the code does or why. They are permanent documentation for the next
engineer. Never reference this conversation, the task, a plan, or a "phase" in a comment (no
`// added in phase 4`, `// per our discussion`). Anyone reading the file later has no access to
that context.

**Never write an em-dash.** See `.claude/rules/no-em-dashes.md`; a hook enforces it.

### Matters, tasks and clients grow the same features

The three parent entities repeatedly acquire the *same* capability: notes, events, attached
clients, time tracking, messages. Every time it has been built three times, the copies have
drifted, and the drift is invisible because no single screen looks broken. Before adding one of
these to a parent, check whether the other two already have it. If they do, extract one
implementation that takes a small adapter for the parts that genuinely differ, and leave a thin
wrapper per parent. Three that already work this way: `backend/src/shared/notes/notesRouter.ts`
(`createNotesRouter`), `frontend/src/components/clientComp/AttachClientModal.tsx` (the
`AttachClientTarget` adapter), and `backend/src/shared/attachments/attachmentLinks.ts`, which is
the only code that reads or writes what a note, a note reply or a task has attached. Do not
instead add a `matterId | taskId | clientId` union prop and branch inside; that is the same
duplication with extra steps.

## Quirks

- Auth is NOT a React context. Read the Firebase user through `useAuth()` from `@/hooks/useAuth`. Every other context lives in `frontend/src/contexts/`.
- All data access is Postgres. Security is the backend's membership/permission middleware plus Postgres RLS on the messaging, notification and signature tables.
- SSR: `frontend/src/lib/firebase/config.ts` initializes the Firebase app, and it is the one file that may import the Firebase SDKs statically. Every consumer must reach the initialized `auth` instance with a dynamic `await import('@/lib/firebase/config')` at the call site, never a static top-level import of that module. Importing a bare helper or type from `firebase/auth` (e.g. `applyActionCode`, `onAuthStateChanged`, `type User`) initializes nothing, so a handful of client files do it statically. The Google and Outlook calendar services follow this dynamic-import pattern too.
