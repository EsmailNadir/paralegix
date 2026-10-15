---
name: check-builds
description: Use when you need to run the frontend and backend build, lint, test, and guard checks, fix failures, and confirm the repo will pass CI and the Vercel deploy.
---

You are the build error checker and fixer for Paralegix.

Goal:
- Check both the frontend and backend for build or lint issues
- Fix what can be fixed safely
- Re-run checks until they pass or only clearly manual follow-up remains

The authority on what must pass is `.github/workflows/ci.yml`. It runs on **manual dispatch
only** (`workflow_dispatch`), never on push or pull request, and `guard-bash.js` blocks the
commands that would trigger it. Never dispatch it. This file mirrors what it would run, so
reproduce those checks locally. If the two disagree, the workflow file is right and this file
is stale: say so in your report.

The three jobs are `backend-static` (typecheck, lint, and all nine guards:
`db:schema:check`, `db/check-js-count.ts`, `db:drift`, `db:raw-query-ratchet`,
`db:user-delete-guards`, `db:files-tree`, `db:coverage-scope-check`,
`db:dead-exports`, and `db:catalog-parity` in a step of its own), `backend-tests` (the `unit` project sharded four ways, plus
Codecov), and `frontend` (`ci:checks`, which already runs `typecheck`, then `test:unit` with
`TZ=America/Los_Angeles` pinned, so a test that only passes in the local timezone fails there,
plus `--coverage` uploaded to Codecov under the `frontend` flag).

Repo-wide, before the package checks:

```bash
node .claude/hooks/guard-doc-size.js --report
```

It exits 1 if any `AGENTS.md` or `.claude/rules/` file is over 220 lines, or any `SKILL.md` over
500. This is not part of CI; it is a local guard that catches a doc that grew outside a Claude
Code session, where the `PreToolUse` hook cannot see it.

Frontend procedure:
- Run `npm run ci:checks` from `frontend/`. This is the real frontend CI gate: `npm run lint`,
  then `npm run typecheck`, then the service-transport guard
  (`check:service-transport`), the class-migration guard (`check:class-migration`), the
  money-format guard (`check:money-format`), the date-helper guard (`check:date-helpers`) and
  the modal-sizing guard (`check:modal-sizing`), the dialog-shell guard (`check:dialog-shell`),
  and the dead-exports guard (`check:dead-exports`). Running bare `npm run lint` skips the
  typecheck and all seven.
- Run `npm run build` from `frontend/`
- `ci:checks` deliberately does NOT run Jest, so run the suites separately. `npm run test:unit`
  in `frontend/` is seconds and always worth running. The backend suite is different: root
  `AGENTS.md` forbids the full `npm test` unless the user asked for it, so run
  `npx jest --findRelatedTests <changed files>` instead, and say in your report that you did.
  It needs no HTTP server but it does need Postgres: each worker owns its own database.
- Parse all reported errors and warnings that block correctness or build success
- Fix issues such as unused imports, TypeScript errors, missing exports, incorrect imports, and JSX mistakes
- Re-run the failing command after each fix cycle to confirm progress
- Note which failure is which: `next build` type-checks but does NOT run ESLint (Next 16 dropped
  build-time linting), so a type error breaks the Vercel deploy while a lint error does not. Fix
  both, but treat type errors as the blocking ones. `npx tsc --noEmit` is the fast way to iterate
  on types without waiting for a full build.

Backend procedure (the backend is 100% TypeScript now; nothing runs under plain `node` from source):
- Run `npm run typecheck` from `backend/`: three programs, `tsc --noEmit`, then the
  `db/`+`scripts/` program via `tsconfig.tools.json`, then the tests via `tsconfig.test.json`. This is the fast, full-graph check: it resolves every import and catches
  missing modules, wrong relative paths, bad exports, and type errors without needing a live process.
- Run `npm run lint` from `backend/` (`eslint src db scripts tests`). This also catches the
  custom `paralegix/safe-drizzle-boundary` tenant-isolation rule.
- Run all nine repo guards from `backend/`, the same nine `backend-static` runs. Nothing catches
  them for you later: the workflow is manual dispatch only, so a guard skipped here is a guard
  nobody runs. Five are `npm run db:schema:check`, `db:files-tree`, `db:coverage-scope-check`,
  `db:dead-exports` and `db:catalog-parity`; the other four need a note each:
  - `npx tsx db/check-js-count.ts` (ratchets the `.js` count across `src/`, `db/`, `scripts/`
    and `tests/` against the baseline of 0 in `db/js-file-baseline.json`).
  - `npm run db:drift` (`db/check-drizzle-drift.ts`, catches a Drizzle schema that no longer
    matches the SQL schema).
  - `npm run db:raw-query-ratchet` (`db/check-raw-query-count.ts`, ratchets raw SQL usage down).
  - `npm run db:user-delete-guards` (`db/check-user-delete-guards.ts`, fails if a new cascading
    or set-null FK to `users(id)` is not checked by `findAccountActivity`, which is what stops
    the unverified-account sweep deleting a real person's data).
- `db:drift` and `db:catalog-parity` need a live database: `db:drift` runs `db:pull`, which is
  `drizzle-kit pull`, and `db:catalog-parity` builds a database from each of the two schema
  paths and compares the catalogs. The rest read files and need nothing. If `db:drift` fails on connection rather than on
  content, see the `local-database` skill.
- Fix what any of these surface, then re-run all of them.
- Do NOT use `node -e "require('./src/app.ts')"` or `node --check <file>` for this. Node cannot
  `require()` a `.ts` file at all (`export =` and other TS syntax throw `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`
  immediately), and `node --check` only parses a single file's syntax without resolving imports, so a file
  importing two nonexistent modules still passes.

Reporting requirements:
- Summarize what errors were found
- Summarize what was fixed
- Call out any remaining issues that need manual attention
