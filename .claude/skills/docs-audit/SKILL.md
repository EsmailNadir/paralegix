---
name: docs-audit
description: Check AGENTS.md, CLAUDE.md, .claude/rules, .claude/agents and .claude/skills for drift against the codebase, and fix what is stale.
---

# Docs Audit

Find drift between what the repo's agent-facing docs (`AGENTS.md`/`CLAUDE.md` files,
`.claude/rules/*.md`, `.claude/agents/*.md`, `.claude/skills/*/SKILL.md`) claim and what the codebase actually
does, then fix every finding directly. Report what was found and what was changed; do not
stop and wait for approval before editing.

## Always implement findings

This skill fixes drift, it doesn't just log it. Once a finding is verified (read the
actual file/code it concerns, don't take a subagent's word for it), apply the fix in the
same run: edit the doc, correct the stale command, add the missing entry, remove the dead
reference. The report at the end documents what changed, it isn't a proposal awaiting
sign-off.

The one exception: if a finding implies a behavior change to application code (not the
docs themselves), such as a doc and the code it describes disagreeing about something the
code does, prefer fixing the doc to match current reality over silently changing app
behavior. Only touch application code when the fix is unambiguous and config-level (e.g.
correcting a hook path in `.claude/settings.json`). If you're ever unsure whether a fix is
safe to make unattended, say so in the report and leave that one item for the user instead
of guessing.

## Why this matters

Docs drift silently: a file gets renamed, a script gets removed from `package.json`, a new
module ships without an entry in the module list, and nothing breaks until an agent reading
the stale doc acts on it. There is no linter for this; file-path and command references in
markdown are just text. This skill is that linter, run periodically, closing the loop
itself instead of leaving a list for a human to work through later.

## Discover doc files fresh every run

Do not hardcode the list of files to check, that list is itself a thing that drifts. Find
it live:

```bash
find . -maxdepth 3 -iname "AGENTS.md" -not -path "*/node_modules/*"
find . -maxdepth 3 -iname "CLAUDE.md" -not -path "*/node_modules/*"
find .claude/rules -name "*.md"
find .claude/agents -maxdepth 1 -name "*.md"
find .claude/skills -mindepth 2 -maxdepth 2 -name "SKILL.md"
find .claude/skills -mindepth 2 -maxdepth 2 -name "*.md" ! -name "SKILL.md"
find .claude/skills -mindepth 3 -name "*.md"          # references/ files
```

`.claude/commands/` no longer exists. Commands were merged into skills; a file reappearing there
is itself a finding.

## What counts as drift

1. **Referential drift**: a file path, script name, module name, table name, or command
   quoted in a doc no longer exists or was moved/renamed.
2. **Command drift**: a documented `npm run X` doesn't match the actual `scripts` block in
   the relevant `package.json` (name changed, or the command it runs changed).
3. **Structural drift**: the codebase gained something a doc's inventory should mention but
   doesn't: a new module under `backend/src/modules/`, a new top-level route under
   `frontend/src/app/`, a new file in `.claude/agents/` or `.claude/skills/` not reflected
   anywhere it's meant to be listed (e.g. the dispatch list in
   `.claude/skills/delegating-to-subagents/SKILL.md`, the dispatch list that names every agent).
4. **Description drift**: a skill's or agent's frontmatter `description`/system prompt no
   longer matches what its body actually tells it to do (e.g. it claims read-only but the
   body now edits files, or the trigger conditions no longer match how it's invoked).
5. **Pointer integrity**: the `CLAUDE.md` files at repo root, `frontend/`, `backend/`,
   `docs/` exist specifically to avoid drift. Each is a one-line import of its sibling
   `AGENTS.md`. Flag immediately if real guidance has leaked directly into a `CLAUDE.md`
   instead of `AGENTS.md`; that reintroduces the exact mirror-drift problem the import
   pattern exists to prevent.
6. **Undocumented new conventions**: a pattern shows up repeatedly in recent commits (new
   env var, new lint rule, a new shared helper everyone's expected to use) but no doc
   mentions it yet.

## Procedure

### 1. Inventory

Run the `find` commands above. This is the fixed list of files in scope for this run.

### 2. Mechanical checks (cheap, do these directly, no subagent needed)

For every doc file:

- Extract backtick-quoted paths and `npm run <script>` invocations.
- For each path: `test -e <path>` (or `git cat-file -e HEAD:<path>` if it should be
  tracked). A path relative to a package (e.g. `db/schema.sql`) is relative to that
  package's root; resolve accordingly (`backend/db/schema.sql`).
- For each `npm run <script>`: grep the relevant `package.json`'s `scripts` block and
  confirm the script name exists and still does roughly what the doc says it does.
- For directory/module lists (backend "Modules:" line, frontend "Key routes:" line, root
  `delegating-to-subagents` dispatch list): `ls` the corresponding real directory and diff them by
  hand. Note anything present on disk but absent from the doc, and vice versa.

### 3. Judgment pass (needs a subagent, this is not mechanical)

Dispatch one `general-purpose` Agent per doc file (or batch small ones), read-only, with
this brief: *read this doc in full, then spot-check its substantive claims against the
current code it describes (not just paths, behavior, defaults, architecture decisions too).
Flag anything that reads as confidently wrong given what the code actually does now. Quote
the doc line and the contradicting code.* This catches drift the mechanical pass can't: a
described default that changed, an architectural claim that's no longer true, a "gotcha"
that was fixed and is no longer a gotcha.

For `.claude/skills/*/SKILL.md` and `.claude/agents/*.md`, add: *does this file's
frontmatter `description` accurately describe when to use it and (for agents) what tools it
needs, based on the body?*

### Frontmatter checks the mechanism now depends on

The invocation mechanism is frontmatter, not prose. Four specific checks:

1. **A skill with SHARED-STATE side effects must carry `disable-model-invocation: true`.** A
   push, a merge, a shared database, a started server, a driven browser. A body sentence saying
   "only run this when the user asks" instead of the flag is a finding. The reverse is also a
   finding: the flag on a read-only skill, or on one whose only effect is editing the
   uncommitted working tree, blocks the user's own natural-language request from reaching it.
   **Known exception, do not "fix" it:** `push-to-branch` pushes but is deliberately
   model-invocable, so that a plain "push this" reaches it. Its gate is the user's request, stated
   in its body. `push-to-staging` was made model-invocable on the same grounds, so that a plain
   "merge this into staging" reaches the skill that knows to apply migrations first rather than
   being reimplemented by hand without them; its body carries the same per-turn gate.
2. **A skill that is knowledge rather than an action should carry `user-invocable: false`.** If
   `/name` is not a meaningful thing for a person to type, the flag is missing.
3. **A `paths:` glob in a rule or skill must still match real directories.** Run the glob. A rule
   scoped to a directory that was renamed silently never loads again, and nothing reports it.
4. **A `skills:` preload list in `.claude/agents/*.md` must name skills that still exist**, and
   none of them may carry `disable-model-invocation: true`, which blocks preloading.

### Size checks

A `PreToolUse` hook enforces these budgets during a session. Run its audit mode to catch a file
that grew outside one, or that was added before the hook existed:

```bash
node .claude/hooks/guard-doc-size.js --report
```

It exits 1 and prints `OVER` for each file past budget: 220 lines for an `AGENTS.md` or a
`.claude/rules/` file, 500 for a `SKILL.md`. Fix an over-budget file by moving content into a
path-scoped rule or a skill `references/` file, not by deleting it.

### Duplication check

The point of the rules split is that a fact lives in exactly one place. Pick three or four
distinctive claims and confirm each appears once:

```bash
grep -rl "<a distinctive sentence>" AGENTS.md */AGENTS.md .claude/rules .claude/skills .claude/agents
```

Two copies of a rule is a finding even when both copies are currently correct, because they drift
next. The one exception is a deliberate one-line pointer from a file to where the detail lives.

### 4. Recent-history check for undocumented conventions

```bash
git log --since="30 days ago" --name-only --pretty=format: -- backend/src frontend/src .claude | sort -u
```

(Use the last-run date from the state file below instead of a fixed 30 days once one
exists.) Skim for: new top-level directories under `src/modules/` or `src/app/`, new files
in `.claude/agents/` or `.claude/skills/`, changes to `.env.example`-style files. Cross-check
each against the docs; if it's genuinely new and unmentioned anywhere it should be, that's a
finding. Also check whether a file that changed recently (e.g. a custom lint rule) is
already documented as a convention elsewhere; if the code enforces something the docs only
describe as a manual guideline, that's worth noting too.

### 5. Verify, then fix

For each candidate finding, confirm it by reading the actual file/code it concerns before
acting on it, not because a subagent claimed it. Then fix it immediately in the same file
you just verified:

- Referential/command drift: correct the path or command, or remove it if the thing it
  described no longer exists.
- Structural drift: add the missing entry to the inventory (module list, table list, route
  list) with a short, accurate description.
- Description drift: correct the frontmatter or the roster entry that's out of sync.
- Pointer integrity: move leaked guidance out of the `CLAUDE.md` and into the sibling
  `AGENTS.md`, then restore the `CLAUDE.md` to a pure import.
- Dead cross-references (a skill pointing at a memory note, skill, or agent that no longer
  exists): remove the dead pointer, or replace it with the real value inline if you can
  find it (e.g. a concrete ID reused from a sibling skill) rather than leaving a broken
  link.

Anything you couldn't verify stays unfixed and goes under "Worth a look" in the report with
the uncertainty stated, never silently applied on a guess.

Run `python3 .claude/docs-audit/test_docs.py` after fixes to check the frontend guard inventory,
shared build documentation, import pointers and the audited invocation gates.

### 6. Report

```
## Docs audit: <date> (<N> doc files checked, <N> findings, <N> fixed)

### Referential / command drift
- `path/to/AGENTS.md`: claimed `npm run X`, but package.json has no such script. Fixed: renamed to `Y`.

### Structural drift (undocumented additions/removals)
- `backend/src/modules/foo/` existed but wasn't in backend/AGENTS.md's Modules list. Fixed: added.

### Description drift (skills/agents)
- `.claude/skills/x/SKILL.md`: description said read-only, body now writes files at step 4. Fixed: updated description.

### Pointer integrity
- `frontend/CLAUDE.md`: contained real guidance beyond the AGENTS.md import. Fixed: moved to frontend/AGENTS.md.

### Undocumented new conventions
- <pattern>, seen in N recent commits, not mentioned anywhere. Fixed: documented in <file>.

### Worth a look (unverified, not fixed)
- <one line>: couldn't confirm because <reason>.

**Verdict:** clean | minor drift, fixed | needed attention, fixed
```

If nothing clears the bar, say so and name what was checked; don't invent findings to fill
out the report.

### 7. Update the state file

Write `.claude/docs-audit/last-run.md`:

```markdown
# Last docs audit

Date: <ISO date>
Findings: <N> (<N> fixed automatically, <N> left as "Worth a look")
```

This lets the next run use "since last audit" instead of a fixed 30-day window in step 4,
and gives a human-visible trail of cadence if this skill ends up driven by `/loop` or a
scheduled routine later.

## Common mistakes

- **Hardcoding the doc file list in this skill.** Defeats the purpose; discover it fresh
  every run (step 1).
- **Trusting a subagent's judgment-pass finding unverified.** Open the file and the code it
  concerns before fixing it.
- **Flagging `CLAUDE.md`/`AGENTS.md` drift between root and package-level files as if they
  should mirror each other.** They're deliberately different documents (root: whole repo,
  package: that package). Pointer integrity is about a `CLAUDE.md` and its own sibling
  `AGENTS.md`, not root vs. package.
- **Silently rewriting application code to match a doc's claim.** Fix the doc to match
  reality instead, unless the fix is an unambiguous config correction (see "The one
  exception" above).
- **Treating a stylistic preference as drift.** Only fix where the doc makes a factual claim
  (a path, command, default, list) that's demonstrably wrong now.
- **No em dashes.** Write fixes the way the rest of this repo's `AGENTS.md`/skill prose does
  when adding new sentences of your own: periods, commas, colons, semicolons, not "—".
