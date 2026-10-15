---
name: delegating-to-subagents
description: Deciding whether to hand work to a subagent, fan out parallel agents, or verify findings a dispatched agent returned.
user-invocable: false
---

# Delegating to Subagents

## Overview

Subagents buy breadth by spending context. Each runs in its own window, cannot see this
conversation, and returns a conclusion nobody watched being reached. Worth it for wide independent
work; harmful for interlinked work.

## Dispatching on your own initiative

The project owner has granted standing authorization: dispatch an `Agent` whenever your judgment
says it earns its cost — no need to ask first. Two obligations come with it: name what you are
dispatching and why before you do it, and verify whatever comes back.

`Workflow` stays closed. Dozens of agents and a large bill need explicit opt-in: the keyword
**ultracode**, "use a workflow", or a direct request for orchestration.

If a session's own rules forbid self-dispatch, respect them and offer instead.

## Dispatch when

- **The answer spans many files but only the conclusion matters.** "Does any module skip
  `law_firm_id` scoping?", "Which services touch Stripe?" → `Explore`, one agent, no fan-out.
- **A cross-cutting change is done.** You are the worst reviewer of your own
  diff — `spec-verifier` for "did I build what was asked", `code-reviewer`
  for quality, `security-reviewer` after auth, permissions, trust, or payments work.
- **The change spans frontend and backend.** Two halves, two independent lenses —
  `frontend-specialist` and `backend-specialist`, in parallel.
- **You are about to edit an unfamiliar subsystem.** `explainer` on the calendar sync engine or
  signature session flow beats reading it all yourself.
- **Output would flood this context.** Full lint and build logs → the `check-builds` agent.
- **You need a plan before deciding.** A change whose shape spans both packages goes to the
  built-in `Plan` agent. Every subagent already receives the root `AGENTS.md`, so none of them
  needs a separate agent to hand it repository context.
- **A mechanical sweep across many disjoint call sites** — one agent per file group, with
  `isolation: "worktree"` if they write.
- **A risky claim needs attacking from several angles** before you state it as true.

Prefer project agents over `general-purpose` — they carry context a generic agent must rediscover.

## Do not dispatch when

- The pieces cross-reference each other, so a locally-correct fix leaves the set inconsistent
- Debugging — find, understand, fix, verify is a chain, not a fan
- Briefing the agent costs more than doing the task
- Two agents would write the same files without worktree isolation — the tree normally carries
  uncommitted work awaiting review, with no per-agent checkpoint to recover to

## Treat every report as a claim

An agent's summary is unwitnessed. Before relaying it, open the files and lines it cites and
confirm they say what it says — agents produce confident, plausible, wrong findings.

## Writing the prompt

They inherit nothing from this conversation. Spell out scope, goal, constraints, and the exact
output wanted — vague scope produces a lost agent.
