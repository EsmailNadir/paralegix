---
name: push-to-branch
description: Commit the working tree and push it to the current branch.
---

# Push to branch

Commit everything real in the working tree and push it to `origin/<current branch>`. No
migrations, no merge, no deploy. Use `/push-to-staging` when the work should reach staging.

Run this ONLY when the user asks in that request. The ask covers that turn, not the rest of the
session, and it does not carry over to a later turn.

This skill is deliberately model-invocable even though it pushes, so that a plain "push this"
reaches it. The gate is the user's request, not the invocation mechanism. Never run it on your own
initiative.

## Preconditions

Stop and say why if any of these fails.

- **Not on `main`.** `main` is a separate, much older pre-Postgres codebase. Nothing from here
  belongs on it.
- **Not on `staging`.** Staging is reached by merging, which is `/push-to-staging`. It applies
  pending migrations before the code lands, and this skill does not.
- The branch has an upstream, or you are ready to set one with `--set-upstream`.

## 1. Show the shipment scope

```bash
git rev-parse --abbrev-ref HEAD
git status --short
git fetch origin -q
```

**Several Claude sessions share this checkout.** Anything another session left uncommitted will be
swept into your commit. Show the user the complete list before committing, and call out any file
you did not touch yourself.

## 2. Prune only obvious debris

Inspect untracked temp scripts, screenshots, logs, editor files and generated scratch output.
Delete only what is clearly throwaway. Never delete source, tests, docs, migrations, or anything
ambiguous. Everything real left in the tree ships.

## 3. Check for migrations

```bash
{ git ls-files --others --exclude-standard 'backend/db/migrations/*.sql'; \
  git diff --name-only --diff-filter=AM origin/staging..HEAD -- backend/db/migrations/; } | sort -u
```

A migration in the shipment is not a blocker here, because pushing a feature branch deploys
nothing. Name it in the report so the later `/push-to-staging` is expected to apply it.

## 4. Verify before committing

Run the checks for the packages the diff touches:

```bash
cd backend  && npm run typecheck && npm run lint
cd frontend && npm run ci:checks
```

Run the tests for what changed, not the whole suite:

```bash
npx jest --findRelatedTests <changed files>
```

**Never run the full backend `npm test` unless the user asks.** A failing check means the change
is not ready. Fix it and rerun rather than committing and mentioning it as a caveat.

## 5. Check for em-dashes

```bash
git add -A
git diff --cached -U0 | grep -n '^+.*—' || echo "clean"
```

An em-dash in added code, comments, UI copy or a `docs/` page must be reworded. The `guard-edit`
hook catches most, but a file written before the hook existed can still carry one.

## 6. Commit and push

```bash
git add -A
git status --short
git commit -m "<conventional commit describing the actual staged diff>"
git push origin HEAD
```

Message style, taken from this repo's history: `fix(trust): close the compliance gaps around the
ledger`, `refactor(db): consolidate the schema from 110 tables to 103`, `test: expand hook,
component and producer coverage`. A scope in parentheses when one domain dominates, none when the
change is broad. Write it from the staged diff. Never reference a chat, a plan, or a phase.

One commit per coherent piece of work, not one per file touched. Frequent tiny commits read as
noise in this history.

## Report

Name the branch, the commit subject and hash, the file count, any migration in the shipment, and
which checks you actually ran. If you did not run something, say so plainly rather than implying
a clean bill of health.

Do not wait for CI. `.github/workflows/ci.yml` is manual dispatch only and this push starts
nothing.
