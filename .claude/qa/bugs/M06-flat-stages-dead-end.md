# M06 — Stages created with "New stage" form no chain, so the stage bar has no way to advance

- **Area / row:** Matters / M06 Stage bar
- **Found:** 2026-07-25
- **Severity:** medium (usability / configuration trap, not data loss)

## Repro

> **Updated 2026-07-27.** There are two empty-state entry points and they no longer
> behave the same. Use the settings one below to reproduce the original trap. The
> matter-side empty state has since gained a branching starter (the component named
> `SetUpStagesModal` at the time is gone; stage setup is `ManageStagesModal` and
> `StagePipelineEditor` now: "Use this starter" builds Intake → Discovery → Negotiation
> forking to Won/Lost/Settled, plus "Start from scratch"), so a firm that sets stages
> up from a matter gets a properly chained tree and never hits this.

1. In a firm with no stages, go to Settings → Matter Config → Stages.
2. Use the **New stage** button three times to create `Intake`, `Discovery`, `Resolved`.
   This is still the obvious path — "New stage" remains the only button on the
   settings-side empty state, and it always creates a root.
3. Set a matter to `Intake` (via the kanban board, or the edit modal).
4. Open the matter and look at the STAGE bar on the Overview tab.

## Expected
Some way to move the matter on to `Discovery` / `Resolved` from the stage bar.

## Actual
The bar shows only the current chip, `Intake`, and nothing clickable. The matter cannot
be advanced from the stage bar at all. The only ways to change it are dragging on the
kanban board or the edit modal.

## Root cause
Not a code defect — a data-model trap. `MatterStageBar.tsx:91` computes:

```
const nextOptions = useMemo(() => {
  if (!current) return stages.filter((s) => !s.parentStageId);
  return stages.filter((s) => s.parentStageId === current.id);
}, [stages, current]);
```

Stages are a branching **tree**; you advance to *children of the current stage*. "New
stage" creates a **root** (`parentStageId = null`). Three roots are three separate
starting points with no edges between them, so once a matter enters one root its
`nextOptions` is empty forever. Building a chain requires "Add step after", which is
only discoverable once at least one stage already exists.

The board view is unaffected because it renders every stage as a column regardless of
parentage, which is why the kanban drag in M03 worked fine.

## Fix
Applied in `MatterStageBar.tsx`. `nextOptions` now falls back to the current stage's
**siblings** (stages sharing its `parentStageId`, which for a flat pipeline means its
co-roots) when the stage has no children and is not an ending stage. Stages already on the
path are excluded so the fallback never offers a step backwards; the path chips already
cover that. Ending stages still return an empty list, so a matter that reaches Won/Lost/
Settled keeps showing the "Completed" chip instead of being offered its sibling outcomes.

A true end-of-chain stage that is a non-ending leaf with no siblings still has no advance
target, which is correct: there is nowhere defined to go.

Still open (separate, cosmetic): several roots read as a sequence even though the stages
are unconnected. The settings editor is now the `StagePipelineEditor` flowchart, which
draws no connector between co-roots, so the disconnection is at least visible there — but
"New stage" still silently creates another root, and there is no "add a second root" or
"connect these" affordance. Making the settings empty state offer the same branching
starter the matter side offers would close the trap at its source. Design call.

**Verification:** type-checked and linted. Not re-exercised in the browser, so the M06 row
stays `todo` rather than `fixed`.
