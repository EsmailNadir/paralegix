---
name: worktree
description: Work in a git worktree, or land work already done in one. Covers entering, merging back, and deleting the branch.
disable-model-invocation: true
---

# Worktree

Isolate a change in a git worktree, then land it on the working branch and delete every trace of the worktree branch.

Only use a worktree when the user explicitly asks for one. Routine work goes straight in the main checkout per `AGENTS.md`.

## Preconditions

- Current branch must be the working branch (currently `dev`), never `main` and never `staging`. `.claude/settings.json` sets `worktree.baseRef: "head"`, so the worktree branches from wherever HEAD is. Entering from `main` would base the work on the ancient pre-Postgres production codebase, and a merge into `staging` would strand the work: `push-to-branch` and `push-to-staging` both refuse to run on `staging`.
- Run `git worktree list`. If stale worktrees from earlier sessions are sitting there, mention them and offer to clean them up (step 5 commands).
- Run `git status --short` and save the list of already-dirty files in the main checkout. There usually are some, and they matter at merge time.

## Workflow

### 1. Enter

```
EnterWorktree { name: "<short-kebab-description>" }
```

Use a descriptive name, not a generated one. Never `git worktree add` by hand.

### 2. Work, and commit inside the worktree

**This is the one exception to the repo's never-commit rule.** The branch is throwaway and there is nothing to merge without commits. Commit as often as is useful; the messages only need to be good enough to summarize in the merge.

Only commits leave the worktree. Anything still uncommitted when you exit is invisible to the merge, so finish with a commit and confirm it took:

```bash
git add -A
git commit -m "<what changed>"
git status --short          # must print nothing before you exit
```

Do NOT try to build, lint, test, or run the app inside the worktree. It gets tracked files only,
plus the three `node_modules` directories `.claude/settings.json` symlinks in
(`symlinkDirectories`), so there is no `backend/.env`, no `frontend/.env.local` and no
`serviceAccountKey.json`. All verification happens in step 4, after the merge. Ports 3000 and
5001 are single-occupancy anyway.

### 3. When the work is done, ask (while still in the worktree)

Use `AskUserQuestion`:

> Work in worktree `<name>` is done. Merge it into the working branch?
>
> - **Merge, push, delete**: merges the branch into the current branch, ships it, then deletes the worktree and branch.
> - **Keep it for now**: leaves the branch and worktree on disk to come back to.

If the answer is keep, run `ExitWorktree { action: "keep" }`, then tell the user the branch name and that `EnterWorktree { path: ".claude/worktrees/<name>" }` returns to it. Stop there.

To throw the work away instead, `ExitWorktree { action: "remove", discard_changes: true }`. Only on an explicit request.

### 4. Merge (only on a yes)

First re-check `git status --short` inside the worktree. If it is not empty, commit the rest before going any further.

```bash
ExitWorktree { action: "keep" }        # must leave the worktree before merging
```

`ExitWorktree` cannot be used to delete the worktree later, because once the session is out of it the tool is a no-op. Step 5 uses plain git.

Before merging, check whether the main checkout's dirty files overlap the branch's changed files:

```bash
git diff --name-only HEAD..<branch> | sort -u
git status --short
```

If any path appears in both, git will refuse the merge. Stop and tell the user which files collide.

```bash
git merge --no-ff <branch> -m "<concise conventional-commit summary of the change>"
```

On a conflict, stop and ask. Do not auto-resolve.

Then run the `check-builds` agent. Nothing is pushed yet, so any failure gets fixed in place and ships with the push.

### 5. Push, then delete

Ask the user which target they want, then run the matching skill:

- `push-to-branch` commits the working tree and pushes the current branch. Nothing deploys.
- `push-to-staging` merges the current branch into `staging`, applying any migrations the
  worktree added to local and then staging before the merge lands.

Either way the worktree's commits are already in the current branch, so `origin/staging..HEAD`
sees the migrations it added.

Only after the push succeeds:

```bash
git worktree remove .claude/worktrees/<name>
git branch -d <branch>                 # -d, not -D
git worktree prune
```

`-d` refuses to delete an unmerged branch. That is the safety net. If it refuses, the merge did not land, so investigate instead of forcing it. If `worktree remove` fails because a process is holding a file, close it and retry rather than deleting the directory by hand.

### 6. Report

Branch name, merge commit hash, what `push-to-staging` pushed and applied, and confirmation that the worktree and branch are gone.

## Quick reference

| Step | Action |
|------|--------|
| Check base | `git rev-parse --abbrev-ref HEAD` must be the working branch, not `main` or `staging` |
| Find stale worktrees | `git worktree list` |
| Enter | `EnterWorktree { name }` |
| Leave (always keep) | `ExitWorktree { action: "keep" }` |
| Collision check | `git diff --name-only HEAD..<branch>` vs `git status --short` |
| Merge | `git merge --no-ff <branch> -m "..."` |
| Delete | `git worktree remove <path>` + `git branch -d <branch>` + `git worktree prune` |
| Re-enter later | `EnterWorktree { path: ".claude/worktrees/<name>" }` |

## Common mistakes

- **Exiting with uncommitted changes.** The merge only sees commits, so uncommitted work silently does not land. `git status --short` must be empty before you exit.
- **`ExitWorktree { action: "remove" }` before merging.** It deletes the branch and every commit on it. Always exit with `keep`; delete in step 5.
- **Entering from `main` or `staging`.** `baseRef: "head"` means the worktree inherits whatever HEAD is. From `main` that is the old production codebase; from `staging`, the push skills refuse to run after the merge.
- **Running lint, build, or tests in the worktree.** `node_modules` is symlinked in, but the env
  files and the service account key are not. Verify after the merge.
- **Deleting the branch before the push lands.** Push first, then delete, so a failed push still has the work.
- **Forcing with `git branch -D`.** If `-d` refuses, the merge did not happen.
- **Merging with an overlapping dirty main checkout.** Git aborts partway. Check for overlap first.
