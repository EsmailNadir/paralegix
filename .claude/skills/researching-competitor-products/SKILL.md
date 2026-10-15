---
name: researching-competitor-products
description: Draw ideas from established legal case management products for a feature, page or workflow: UI layout, information architecture, naming, data model.
---

# Researching Competitor Products

## Overview

Paralegix is a legal practice management SaaS. Before building or redesigning a feature, page, or workflow, look at how mature competitors already solved the same problem and borrow what works. Established products have spent years and many user-research cycles on these decisions — their layouts, labels, and flows are a strong prior.

**Core principle:** Don't design in a vacuum. Find 2–4 competitor implementations of the thing you're building, extract the patterns worth keeping, then adapt them to Paralegix's stack and conventions.

## When to Use

- Building a new page, module, or feature (billing, trust accounting, case timeline, intake, conflict check, etc.)
- Redesigning an existing page and unsure of the best layout or information hierarchy
- Deciding what fields, statuses, columns, filters, or actions a screen should have
- Naming things (labels, statuses, menu items) — competitors reveal industry-standard terminology
- Designing a workflow (invoicing lifecycle, e-signature flow, client intake, matter setup)
- The user says "look at how others do this," "make it like Clio," or asks for design ideas

**When NOT to use:** Pure bug fixes, refactors, backend-only plumbing with no UX surface, or when the user has already given an explicit spec/design to follow.

## Competitors to Research

The major legal case / practice management systems worth studying:

| Product | Known for |
|---------|-----------|
| **Clio** | Market leader; clean UI, strong billing/trust accounting, broad feature set. The default benchmark. |
| **Practice Panther** | Simple, approachable UX; good automation and intake flows. |
| **Filevine** | Litigation/case-heavy; powerful customization, document & deadline management. |
| **Smokeball** | Automatic time tracking, document automation, tight matter management. |
| **MyCase** | Client communication, portals, billing; SMB-focused. |
| **CARET Legal (Zola Suite)** | All-in-one with built-in email & accounting. |
| **Rocket Matter** | Billing & project management focus. |

Always include **Clio** as the baseline. Pick 2–3 others most relevant to the specific feature (e.g. Filevine/Smokeball for document & matter workflows, MyCase for client portal, Clio/CARET for trust accounting & billing).

## How to Research

1. **Frame the question narrowly.** Not "how does Clio work" but "how does Clio lay out the invoice detail page and what statuses does an invoice move through."
2. **Search the web** for the specific topic. Effective query shapes:
   - `Clio trust accounting workflow`
   - `Filevine matter timeline UI`
   - `Practice Panther client intake form fields`
   - `<product> <feature> screenshot / support article / help center`
   - Their **help/support docs** are gold — they describe exact fields, statuses, and steps with screenshots.
   - YouTube demos and review sites (Capterra, G2, Software Advice) show real screens.
3. **Look for, and write down:**
   - **Information architecture** — what's grouped together, tab structure, what's on the page vs in a drawer/modal
   - **Data model cues** — fields, statuses, relationships, required vs optional
   - **Workflow / state machine** — the lifecycle stages and transitions
   - **Terminology** — the exact words they use (often the industry standard clients expect)
   - **Actions** — primary buttons, bulk actions, what's in the overflow menu
   - **Empty states & defaults** — how they onboard a user into the feature
4. **Synthesize, don't copy.** Note 3–6 concrete ideas worth stealing, and explicitly call out what does NOT fit Paralegix (different stack, different scope, different user base).

For a thorough multi-source pass, dispatch subagents to search in parallel — one per product or per angle — then synthesize. See the `delegating-to-subagents` skill; each agent's findings are claims to verify, not results.

## Applying Findings to Paralegix

- **Adapt to our conventions, never paste.** Match Paralegix's design tokens (`bg-surface`, `text-on-surface`, etc. — see AGENTS.md theming), component primitives in `components/ui/`, and the existing `[domain]Comp/` structure.
- **Respect our data model.** Map competitor fields onto our Postgres schema (`backend/db/schema.sql`); don't invent columns to mirror a competitor 1:1.
- **Keep what's proven, drop what's bloat.** Competitors carry legacy and enterprise complexity Paralegix may not need. Borrow the clarity, skip the clutter.
- **Borrow terminology** when it's the legal-industry standard, so the app feels familiar to lawyers switching from another tool.

## Output

When presenting research, give the user:
1. **What N competitors do** — a short per-product note on the relevant screen/flow.
2. **Patterns worth adopting** — a concise list of concrete ideas.
3. **A recommendation** for Paralegix — not a survey, an actual proposal adapted to our stack.

## Common Mistakes

- **Researching too broadly** ("how does Clio work") instead of the specific screen/flow → you get marketing fluff, not design detail.
- **Copying a competitor's full feature set** including complexity Paralegix doesn't need.
- **Ignoring our design tokens / components** and reproducing a competitor's visual style verbatim.
- **Skipping Clio** — it's the benchmark; always check it.
- **Stopping at one source** — cross-check 2–4 products so you adopt patterns, not one company's quirks.
