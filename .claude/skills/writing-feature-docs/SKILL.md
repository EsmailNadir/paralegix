---
name: writing-feature-docs
description: Use when documenting a feature, module, subsystem, or flow — writing a markdown doc that explains how something works for other engineers. Covers what to include, the required structure (summary + key takeaways first, improvements last), and how to research the feature before writing.
---

# Writing Feature Documentation

## Overview

Feature documentation explains how one feature actually works to an engineer who has never seen it. Document the real behavior in the code — not how you wish it worked, not a sales pitch. If the doc disagrees with the code, the doc is wrong.

**Core principle:** Read the code first, write second. Every claim in the doc must be traceable to a file. Cite files as `path:line` so readers can verify and dig in.

**Every feature doc MUST follow this skeleton, in this order:**

1. **Summary + Key Takeaways** (at the very top)
2. **The body** (how it works — the bulk of the doc)
3. **What Can Be Improved** (at the very end)

## Required Structure

### 1. Summary + Key Takeaways (top of the doc)

Before any detail, a reader must be able to learn what the feature does and the most important facts in under 60 seconds. Put this FIRST, always.

- **Summary:** 2–5 sentences. What is this feature, who uses it, what problem does it solve. Plain language, no jargon dump.
- **Key Takeaways:** 3–7 bullets. The things a reader must remember even if they read nothing else — the entry point, the data store, a critical gotcha, a security/tenancy rule, a non-obvious constraint.

Write this section LAST (after the body), but place it FIRST in the file. You can't summarize what you haven't yet explained.

### 2. The Body (how it works)

This is the bulk. Adapt the sub-sections to the feature, but cover:

- **Entry points** — routes, pages, hooks, or commands that trigger the feature. Cite `file:line`.
- **Data flow** — trace one full request/action end to end: UI → service → repository → DB (and back). Concrete, ordered steps.
- **Data model** — the tables/collections/types involved and how they relate.
- **Key logic & rules** — validation, permissions, tenancy scoping, edge cases, money/date handling, anything non-obvious.
- **External dependencies** — other modules, third-party services, env vars, jobs.
- **Examples** — a real request/response, a sample payload, or a concrete walkthrough. One good example beats three vague ones.

Use tables for reference material (routes, fields, statuses), numbered lists for sequences, and short prose for the "why."

### 3. What Can Be Improved (end of the doc)

Close every feature doc with a forward-looking section. While reading the code you WILL notice rough edges — capture them here instead of losing them.

- Known limitations, tech debt, TODOs, and hacks you found
- Performance concerns (N+1 queries, missing indexes, unbounded loops)
- Missing validation, error handling, or test coverage
- Refactors or simplifications worth considering
- Open questions the code couldn't answer

Be specific and cite `file:line`. "Could be cleaner" is useless; "`matters.repository.ts:120` runs a query per matter in a loop — batch it" is actionable. If the feature is genuinely solid, say so and list smaller nice-to-haves rather than inventing problems.

## Workflow

1. **Find the feature's surface.** Locate routes, pages, services, repositories, and types. Grep for the feature name and follow imports.
2. **Trace one end-to-end path** through the code, reading the actual implementation. Take notes with `file:line` as you go.
3. **Write the body** from your notes.
4. **Write the Summary + Key Takeaways** from the finished body, and place it at the top.
5. **Write What Can Be Improved** from the rough edges you noticed while tracing.
6. **Verify** — reread the doc against the code. Delete any claim you can't point to a line for.

## Template

```markdown
# <Feature Name>

## Summary

<2–5 sentences: what it is, who uses it, what problem it solves.>

## Key Takeaways

- <Entry point / where to start>
- <Data store / model>
- <Critical rule or gotcha>
- <Security / tenancy constraint>
- <Anything else a reader must not miss>

---

## How It Works

### Entry Points
<routes / pages / hooks, with file:line>

### Data Flow
1. <step> (`file:line`)
2. <step> (`file:line`)
...

### Data Model
<tables/types and relationships>

### Key Logic & Rules
<validation, permissions, tenancy, edge cases>

### Dependencies
<other modules, services, env vars>

### Example
<concrete request/response or walkthrough>

---

## What Can Be Improved

- <limitation / tech debt> (`file:line`)
- <performance concern> (`file:line`)
- <missing coverage or refactor idea>
- <open question>
```

## Where to Save

Default to `docs/features/<feature-name>.md` unless the user says otherwise. Use kebab-case file names.

Then **add the page to `devSidebar` in `docs/.vitepress/config.ts`**. `features/**` is internal
engineering reference: it is excluded from the public docs build and only appears in the admin
build (`DOCS_INCLUDE_DEV=true`). A page that is not in the sidebar is orphaned even there. See
`docs/AGENTS.md`.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Summary at the bottom or missing | It goes FIRST. Always. |
| No "What Can Be Improved" section | It goes LAST. Always — find something real. |
| Claims with no code references | Cite `file:line`; delete unverifiable claims. |
| Describing intended behavior, not actual | Document what the code does, not the design goal. |
| Marketing tone ("powerful", "seamless") | Plain, factual engineering language. |
| Wall of prose | Tables for reference, numbered lists for flows. |
| Vague improvements ("could be better") | Specific + actionable + `file:line`. |
