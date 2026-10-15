---
name: review-branch
description: Review the code on this branch against staging for problems before pushing or merging. Read-only; reports findings with confidence scores.
---

# Review Branch

Review everything this branch changed relative to `staging`, find real problems, and
report them with a confidence score so low-signal noise never reaches the user.

**Read-only.** This skill reviews; it does not fix. Never edit, commit, or push while
running it. Offer the fixes at the end and let the user choose.

## The base is staging, never main

`main` is a **different, much older codebase** (pre-Postgres, pre-billing/trust work).
Diffing this branch against `main` produces hundreds of commits and 1000+ changed files
of unrelated migration churn, which drowns the actual change. Confirm the scale yourself
if tempted:

```bash
git rev-list --left-right --count origin/main...origin/staging
```

`main` is consulted only in the narrow "Prod applicability" step below, and never as a
diff base unless the user explicitly says the branch targets production.

## 1. Resolve the review scope

Fetch first, then pick the base by branch:

```bash
git fetch origin staging -q
git rev-parse --abbrev-ref HEAD
```

| Situation | Base | Scope to review |
|---|---|---|
| On the working branch, e.g. `dev` (the usual case) | `git merge-base origin/staging HEAD` | merge-base..HEAD + working tree |
| On `staging` | `origin/staging` | unpushed commits + working tree |
| User says it targets prod | `origin/main` | say so explicitly in the report |

Per `AGENTS.md`, work normally sits **uncommitted** on the current branch, so the working tree
is usually most of the change. Capture all three layers, because a plain `git diff` misses
two of them:

```bash
BASE=$(git merge-base origin/staging HEAD)
git diff "$BASE"..HEAD                          # committed but unpushed
git diff HEAD                                   # tracked, uncommitted (staged + not)
git ls-files --others --exclude-standard        # NEW FILES - invisible to any diff
```

Write the combined diff to a scratch file and `cat` each untracked file into it, then
hand reviewers that one path plus the file list. Regenerating the diff in four agents
wastes context and risks them each seeing a different snapshot.

If the scope is empty, say so and stop. Do not invent a review.

## 2. Load the guidelines that apply

Read the root `AGENTS.md` plus the package-level file for every directory the diff
touches (`backend/AGENTS.md`, `frontend/AGENTS.md`, `docs/AGENTS.md`). Only cite a
convention violation when the guideline **explicitly** states the rule; if you cannot
quote the line, it is a preference, not a finding.

## 3. Dispatch four reviewers in parallel

One message, four `Agent` calls, `subagent_type: general-purpose`. Each gets the diff
path, the untracked file list, the relevant `AGENTS.md` contents, and this instruction:
*read-only, report findings as `file:line` plus what is wrong and why it matters, and
only report what this change introduced.*

| Lens | Brief |
|---|---|
| **Conventions** | Compliance with the `AGENTS.md` files. Matter vs case terminology, comments that reference a chat/plan/phase, semantic theme tokens over hardcoded colors, enum values never rendered raw, dynamic `import()` for Firebase client code, no em dashes anywhere, including UI strings: `.claude/rules/no-em-dashes.md` covers code, comments and UI copy, and `guard-edit.js` guards `.tsx` as well as every `.md` under `docs/`. Also flag `ui/Button` inside a form without `htmlType="submit"`: it defaults to `'button'` and silently will not submit (`Button.tsx:23,41`); that one is a component-API trap, not an `AGENTS.md` rule. |
| **Correctness** | Bugs introduced by this change: broken logic, unhandled errors, null/undefined paths, races, wrong state deps, N+1 queries, leaks. Ignore anything pre-existing. |
| **Data & money** | The repo's high-risk surface. Tenant scoping through `law_firm_id` on raw SQL, integer `*_cents` math and rounding, day-only `date` columns parsed as UTC midnight (off-by-one for behind-UTC viewers), owner/admin queries that are member-scoped and undercount firm totals, trust append-only and commingling invariants, schema changes without a numbered idempotent migration. |
| **History** | `git log -p` and `git blame` on the touched lines. Does this revert or re-break something a recent commit deliberately fixed? Does it contradict a decision the surrounding history shows was made on purpose? |

## 4. Score confidence, then filter by severity

Score each finding 0-100 on **confidence only** — how sure you are the defect is real:
0 certainly a false positive, 50 plausible but unverified, 80 verified in the code, 100
certain with a concrete failure path. Severity is a separate axis; do not fold "it's
minor" into a low confidence score.

The cutoff scales with what the finding would cost if it were real:

| Severity | Report at | Rationale |
|---|---|---|
| Critical (data loss, money, tenant leak, security) | **30+** | A 30% chance of losing trust money is worth 10 seconds of reading. Never silently drop these. |
| Important (broken behavior, missing error path, test gap) | **50+** | A coin flip is enough; this is a private review, so the cost of being wrong is one line of reading. |
| Minor (style, naming, convention) | **50+** | Same bar. Surfacing a half-sure nit beats hiding a real convention drift. |

Anything a lens produced that clears its bar goes to **verification**: open the actual
file and confirm the defect before it enters the report. Verification is the real filter,
not the number, which is why the bar can sit this low. A Critical finding you could not
confirm still gets reported, but under "Worth a look" with the uncertainty stated
plainly, never as an assertion.

Drop these outright, at any score:

- Anything not introduced by this change.
- Nitpicks and general "quality" opinions with no guideline behind them.
- Anything CI already catches. `.github/workflows/ci.yml` runs `npm run typecheck` and
  `npm run lint` on both packages, all nine backend guards (`db:schema:check`,
  `check-js-count`, `db:drift`, `db:raw-query-ratchet`, `db:user-delete-guards`,
  `db:files-tree`, `db:coverage-scope-check`, `db:dead-exports`, `db:catalog-parity`), all seven
  frontend ones
  (`check:service-transport`, `check:class-migration`, `check:money-format`,
  `check:date-helpers`, `check:modal-sizing`, `check:dialog-shell`, `check:dead-exports`), and the `unit` Jest project. Note the workflow is
  manual dispatch only, so none of that runs unless somebody dispatches it: a finding a machine
  COULD report is still worth raising if nobody has run the machine.
- False terminology hits: `{{case}}`, `switch`/`case`, `snake_case` are all legitimate.
- "Missing tenant scope" where the query goes through `DrizzleRepository` or an audited context, both of which scope by `law_firm_id` already.

## 5. Prod applicability (the "if applicable, main" check)

For **Critical findings only**, decide whether prod carries the same defect. Do not
diff; check whether the file even exists on the old codebase:

```bash
git cat-file -e origin/main:<path> && echo "exists on main"
```

If the file exists on `main` and the same defective pattern is present there, note it as
a **separate prod fix**, because shipping to `staging` will not fix production. If the
file is absent from `main` (anything Postgres, billing, trust, or signatures generally
is), say "staging-only, no prod exposure" and move on.

## 6. Report

Terminal output only, no PR comment. Keep it tight:

```
## Branch review — <branch> vs <base> (<N> files, <N> findings)

### Critical
1. <one line> — `path/file.ts:120`
   Why it matters, and the fix.

### Important
### Minor

### Worth a look (unverified)
- <one line each> — `path/file.ts:44` — could not confirm because <reason>.

### Prod exposure
<per critical finding: also on main / staging-only>

**Verdict:** ship | fix-then-ship | rework
```

Findings you verified are stated as fact. Everything in "Worth a look" is explicitly
marked as a hunch and kept to one line, so a low-confidence item can never be mistaken
for a confirmed bug. That separation is what makes the low Critical bar safe.

If nothing clears its bar, say the branch is clean and name what you checked. Padding a
clean review with minor findings makes every future review less trustworthy.

Then offer to fix the Critical and Important items. Wait for the user to say yes.

## Quick reference

| Step | Command |
|---|---|
| Fetch + base | `git fetch origin staging -q && git merge-base origin/staging HEAD` |
| Committed scope | `git diff $BASE..HEAD` |
| Uncommitted scope | `git diff HEAD` |
| New files | `git ls-files --others --exclude-standard` |
| History on a file | `git log -p -3 -- <path>` / `git blame -L <n>,<m> <path>` |
| Prod exposure | `git cat-file -e origin/main:<path>` |

## Common mistakes

- **Diffing against `main`.** It is a different codebase; the review becomes noise.
- **Missing untracked files.** Work is normally uncommitted here, so a brand-new file
  shows in no diff at all. `git ls-files --others` or you review a fraction of the change.
- **Reporting pre-existing issues.** If `git blame` shows the line predates the base, it
  is out of scope.
- **Fixing while reviewing.** Read-only until the user approves.
- **Reviewing only frontend or only backend.** Most changes here span both; a hook change
  usually has a route behind it.
- **Trusting an agent's finding unverified.** Open the file and confirm before it goes in
  the report.
