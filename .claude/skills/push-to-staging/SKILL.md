---
name: push-to-staging
description: Merge the current branch into staging and apply its pending migrations first.
---

# Push to staging

Take the whole current branch into `staging` and ship it. Detect its migrations first, apply the
backward-compatible expansion ones to local and then staging, and only then merge and push. This
ordering is the point of the skill: it stops Cloud Run deploying code before the schema it needs
exists.

Run this only when the user asks in that request. It mutates the shared staging database and the
shared `staging` branch, and the ask covers that turn alone: it does not carry over to a later
turn, and "we are shipping this" earlier in a session is not authorization now.

Like `/push-to-branch`, this skill is model-invocable so that a plain "merge this into staging"
reaches it rather than being reimplemented by hand with the migration ordering left out. The gate
is the user's request, not the invocation mechanism. Never run it on your own initiative, and
never as a follow-on step you decided was implied.

## Preconditions

Stop and say why if any of these fails.

- Everything in the working tree is meant to ship. Uncommitted work is invisible to a merge, so
  step 0 commits and pushes it to the current branch first. Stop only if the tree holds work the
  user did not mean to send to staging, which is the case to raise with them rather than decide.
- The current branch is not `main` and not `staging`. `main` is a separate, much older
  pre-Postgres codebase and is never a source or a target here.
- `backend/.env` has working `DATABASE_URL_LOCAL` and `DATABASE_URL_STAGING` values.
- The local Podman Postgres is running.

Never use the production database target, `--allow-prod`, or `apply-schema --reset`.
`guard-bash.js` blocks all three. `run-sql --force` no longer exists; the script hard-errors and
tells you to correct an applied migration with a new numbered one.

## Migration rules

- `run-sql.ts` records numbered migrations and checksums in `schema_migrations`.
- New files carry a `-- migration-mode: expand` or `-- migration-mode: contract` header.
- **Nothing in this workflow waits for the user's approval.** The request to push to staging is
  the approval for every migration in the shipment, expand and contract alike. Do not stop to ask.
- **Contract migrations are applied too**, with `--allow-contract`, in the same numeric order.
  Staging holds disposable test data, so the short window where the deployed code and the new
  schema disagree (until Cloud Run finishes deploying the merge) is accepted. Name each contract
  migration in the report and say what breaks during that window, so the user knows.
- Apply in ascending numeric order, local first and staging second.
- Never edit or replay an applied migration. Add a new numbered one.
- **A migration that rewrites, merges or removes data gets a dump first, then proceeds.** Dump the
  affected tables from staging into the scratchpad before applying it, check the file is non-empty,
  and name its path in the report:
  `podman exec paralegix-pg pg_dump "<DATABASE_URL_STAGING>" -t <table> > <scratchpad>/staging-<table>-<date>.sql`.

## Workflow

### 0. Commit and push the working tree

A merge only carries commits, so anything uncommitted would be left behind on the branch while
staging deployed without it. Run `/push-to-branch` and follow it through: it shows the shipment
scope, runs the checks for the packages the diff touches, and pushes.

Skip this only when `git status --short` is already empty. Everything below assumes the branch and
its remote agree.

### 1. Capture the shipment and its migrations

```bash
git rev-parse --abbrev-ref HEAD
git status --short
git fetch origin -q
git log --oneline origin/staging..HEAD
git diff --name-only --diff-filter=AM origin/staging..HEAD -- backend/db/migrations/ | sort -u
```

Save the migration list and show the user the commits about to land. Inspect each migration file
completely. Confirm its mode header, verify that the currently deployed application stays
compatible with the expanded schema, and identify its pre and post invariants. Do not infer safety
from `IF NOT EXISTS` alone.

### 2. Check the merge will not collide

```bash
git diff --name-only origin/staging...HEAD | sort -u > /tmp/branch-files
git diff --name-only HEAD...origin/staging | sort -u > /tmp/remote-files
comm -12 /tmp/branch-files /tmp/remote-files
```

Anything printed by `comm` was changed on both sides. Read those files before merging rather than
discovering the conflict mid-merge.

### 3. Apply pending migrations to local

For each migration, in numeric order:

```bash
DB_TARGET=local npx tsx backend/db/run-sql.ts backend/db/migrations/<file>.sql
```

Add `--allow-contract` for a `-- migration-mode: contract` file. Add `--non-transactional` only
for an already-verified single-statement concurrent index.

Run each migration's invariants, then:

```bash
cd backend && npm run typecheck && DB_TARGET=local npm run db:drift
```

If local application or verification fails, stop before touching staging.

### 4. Apply the same migrations to staging

Apply only the exact files that passed locally, in the same order, with the same flags:

```bash
DB_TARGET=staging npx tsx backend/db/run-sql.ts backend/db/migrations/<file>.sql
```

Then `DB_TARGET=staging npm run db:drift` and the same invariants. If anything fails, stop. Do not
merge code that assumes the migration succeeded.

Staging holds disposable test data. Its ledger was emptied when the chain was collapsed and
staging was rebuilt from `schema.sql`, so it records only migrations written since. Write a
compensating migration rather than proposing another rebuild.

### 5. Merge into staging

```bash
BRANCH=$(git rev-parse --abbrev-ref HEAD)
git checkout staging
git pull --ff-only origin staging
git merge --no-ff "$BRANCH" -m "<conventional-commit summary of what the branch did>"
```

Write the message from the actual range, not from the branch name. Never reference a chat, a plan
or a phase. If the merge conflicts, resolve it yourself when the code makes both sides' intent
clear, rerun the checks for the touched packages, and list what you resolved in the report. Stop
only when the two sides genuinely contradict and nothing in the code says which should win.

### 6. Push, then realign the branch with staging

```bash
git push origin staging
git checkout "$BRANCH"
git pull origin staging
git push
```

The pull brings the merge commit back down, so the branch and staging end on the same commit
rather than the branch sitting one merge behind. It fast-forwards, because the merge was made from
this branch's own tip. If it does not, something landed on staging from elsewhere: stop and report
it rather than resolving a merge the user has not seen.

Confirm the four refs agree before reporting:

```bash
for r in "$BRANCH" "origin/$BRANCH" staging origin/staging; do echo "$(git rev-parse --short $r)  $r"; done
```

Leave the user on the branch they started on.

## Report

Name the branch, the merge commit, the commits that landed, and each migration file and checksum
applied to each database. Give the commit the branch and staging now share, so the user can see
they are aligned. Then stop.

Do not wait for the Cloud Run or Vercel deploys, do not poll the staging health endpoint, and do
not exercise the feature against staging. The user does not want this run to block on deployment
verification.

`.github/workflows/ci.yml` is manual dispatch only, so this push starts nothing and there is no CI
result to wait for. This skill does not run the full suite itself, so say plainly which checks you
did run.

## Failure rules

- **Local failure**: staging is untouched. Fix locally.
- **Staging migration failure**: do not merge dependent code. Inspect the state and use a new
  compensating migration if needed. Never force or replay the failed file blindly.
- **Merge conflict**: resolve it when the intent is clear and report it; stop only on a genuine
  contradiction.
- **Push failure after a successful additive migration**: leave the compatible expansion in place
  and retry the push. Do not roll back by dropping the new schema object.
- **A check fails in step 0**: nothing has been committed or merged. Fix it and rerun that step.
- **The realigning pull is not a fast-forward**: staging moved from elsewhere between the push and
  the pull. Staging already has the work, so stop there and report it. Do not merge staging back
  into the branch to force them level.
