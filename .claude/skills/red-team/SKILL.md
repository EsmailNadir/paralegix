---
name: red-team
description: Adversarially review the current change or a design with a Breaker, Hardener and Judge panel, and return a prioritized verdict.
argument-hint: "[target: diff, file, or design doc]"
---

Red-team the target below. If none is given, use the working-tree diff (`git diff` and
`git diff --staged`). Target: $ARGUMENTS

Run three passes. Use subagents so each starts with a clean perspective.

## Pass 1: Breaker (dispatch a subagent)
You are a skeptical senior engineer trying to make this FAIL. Find concrete ways it breaks:
edge cases, malformed/empty/huge input, concurrency/race conditions, error paths, broken
invariants, resource leaks, security holes, wrong assumptions about the environment.
For each: a short name, the exact trigger, and what goes wrong. Only report failures you
can explain end-to-end. Ignore style. Return a numbered list.

## Pass 2: Hardener (dispatch a subagent, given the Breaker's list)
You are a defensive architect. For each Breaker finding, give a specific fix (code or
design change), not generic advice. Separately, list what is already done well so it
doesn't get broken in a rewrite. Return: Fixes (per finding) + Strengths.

## Pass 3: Judge (dispatch a subagent, given both lists + the diff)
You are a pragmatic tech lead. For each finding, rule: REAL (worth fixing) / THEORETICAL
(note only) / FALSE. Weigh blast radius, likelihood, and fix effort. Don't inflate.
Return:
- **Verdict:** ship as-is | fix-then-ship | rework
- **Must-fix (REAL):** ordered list. Finding, why it matters, the fix, ~effort
- **Optional (THEORETICAL):** brief list
- **Dismissed (FALSE):** one line each, why

Then I (the main session) will summarize the Judge's verdict and offer to apply the
must-fix items.
