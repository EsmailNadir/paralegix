---
name: refactor
description: Use when restructuring, cleaning up, or improving existing code without changing what it does — renaming, splitting, deduplicating, simplifying, or extracting shared logic into reusable components/functions.
---

# Refactor

## Overview

Refactoring improves the **structure** of code without changing its **behavior**. The observable output, side effects, and public contracts stay identical — only the internals get cleaner.

**Core principle: same behavior in, same behavior out. If behavior changes, it is not a refactor.**

## The Two Rules

1. **Do not change the implementation's behavior.** Inputs, outputs, side effects, error handling, edge cases, ordering, and public APIs must stay the same. No "while I'm here" feature changes or bug fixes — flag those separately and ask first.

2. **Deduplicate by extracting, not copying.** If logic is (or will be) used in more than one place, pull it into a single reusable unit: a function, hook, component, util, or service. Update all call sites to use it. Never leave two copies of the same logic.

## When to Use

- Code is duplicated across files or components
- A function/component is too long or does too many things
- Names are unclear; structure is hard to follow
- Repeated inline logic should become a shared helper
- Tangled code needs to be split into smaller, focused units

**When NOT to use:** if the task requires changing what the code *does* (new feature, bug fix, behavior change). That is not refactoring — handle it as its own change.

## Workflow

1. **Understand current behavior** — read the code and its call sites. Know exactly what it does before touching it.
2. **Identify the shape of the change** — rename / split / extract / simplify / deduplicate.
3. **For shared logic:** create one reusable unit (function, component, hook, util) and point every call site at it. Match the codebase's existing patterns (file location, naming, export style).
4. **Make the change** in small, behavior-preserving steps.
5. **Check the call sites** — every caller you touched still lines up with the new shape. What
   you may then claim about the result is `verification-before-completion`'s call.

## Extraction Guide

| Duplication | Extract into |
|---|---|
| Repeated JSX / UI markup | A shared React component (`ui/` or `[domain]Comp/`) |
| Repeated stateful UI logic | A custom hook (`[domain]Hooks/`) |
| Repeated pure logic / formatting | A util function (`shared/utils/` or `src/lib`) |
| Repeated API calls | A method on the relevant service class |
| Repeated backend logic | A service/repository function, not inline in routes |

Always follow the conventions already in the codebase — don't invent a new location or pattern when one exists.

## Common Mistakes

- **Sneaking in behavior changes.** "I'll just fix this bug too" turns a safe refactor into a risky one. Surface it separately.
- **Copy-paste instead of extract.** Duplicating logic to "reuse" it defeats the purpose. Extract one source of truth.
- **Over-abstracting.** Don't extract a helper used in exactly one place with no reuse on the horizon. Reuse (actual or imminent) justifies extraction.
- **Breaking call sites.** When you extract, update every caller — don't leave the old inline version behind.

## Red Flags — STOP

- "While refactoring I also changed/fixed..." → that's a behavior change, separate it
- Two near-identical blocks left in place after the refactor → extract them
