---
name: paralegix-frontend
user-invocable: false
description: Use when building or changing anything visible in frontend/ — a page, panel, modal, form, list, table, card, button, badge, pill, dropdown, menu, tab, toggle, empty state, spinner, or toast — and when reviewing frontend code for visual or structural consistency.
paths:
  - "frontend/src/**/*.tsx"
  - "frontend/src/**/*.css"
---

# Paralegix Frontend

Paralegix has one settled visual language. Your job is to **reproduce it**, never to design.
Every value you might reach for — radius, padding, font size, colour, gap, duration — is already
decided somewhere in `frontend/src`. Picking a reasonable-looking value instead of the settled
one is a defect, even when the result looks good.

**The test:** someone scrolling the app must not be able to tell which screen was built most
recently. If your UI is identifiable as new, it is wrong.

## The procedure

1. **Name the surface.** List page · detail page · settings panel · modal · marketing ·
   client portal. Each has a different skeleton and a different set of rules.
2. **Open the exemplar for that surface** (table below) and copy its skeleton before writing
   anything. This is the first step, not optional research.
3. **Check `references/components.md`** for a primitive that already does the job. There are
   about 100 files in `src/components/ui/`. Rebuilding one is a defect even when the copy looks right,
   because the next fix to the real one never reaches your copy.
4. **Take every value from `references/primitives.md`.** Do not derive them from the exemplar
   alone — a third of the codebase is drift, and the exemplar may be part of it.
5. **Check `references/known-drift.md`** before copying from any file not listed as an exemplar.
6. **Run `bash .claude/skills/paralegix-frontend/scripts/check-ui.sh`** on your changed files
   before saying you are done. Use the full path: the repo root has its own `scripts/`
   directory, so a bare `scripts/check-ui.sh` fails there.

## Exemplars — copy these

| Surface | Copy from |
|---|---|
| List page | `components/contactsComp/ContactsGrid.tsx` (current) |
| List page, complex | `components/matterComp/MattersGrid.tsx` (filters, bulk actions, export) |
| Detail page | `app/lawfirm/[lawFirmId]/contacts/[contactId]/page.tsx`; a tabbed detail page (matter, task, client) puts `PageHeader` with `bordered={false}` above its `TabBar` (`components/clientComp/ClientDetail.tsx`) |
| Modal | `components/billingComp/AddExpenseModal.tsx` (the complete shape) |
| Confirm/delete | `<ConfirmModal>` — never hand-roll one |
| Settings panel | `app/lawfirm/[lawFirmId]/settings/roles/page.tsx` |
| Empty state | `<ListEmptyState>` — never hand-roll one |
| Marketing page | `components/marketingComp/sections.tsx` (separate token family) |

## Non-negotiables

These are the rules where the codebase is genuinely settled and a deviation is always wrong.

- **Navigation inside the app**: `navigate()` from `useNavigation()`. Never `router.push()` or
  `<Link>` for feature navigation. (Auth redirects, marketing, and admin are the documented
  exceptions — see `references/data-and-state.md`.)
- **Every modal** is a `ui/Modal`, which owns the animation and the `useDialog` focus trap,
  `role="dialog"`, `aria-modal` and `aria-labelledby`. Hand-rolling them fails
  `check:dialog-shell`: the animation alone makes a modal *look* finished, which is how a quarter
  of them once shipped without a focus trap.
- **A close handler hides the modal and does nothing else.** Clearing state on close makes the
  user watch the dialog blank out and *then* disappear. Use `useResetAfterClose` /
  `useLastOpenValue`.
- **Status, priority, and type colours** come from `@/constants/statusMeta`, never a local
  `Record<status, colour>` map.
- **Badges** are `<StatusBadge>` or a per-domain badge. Never a hand-rolled `rounded-full` span.
- **Waiting** is `<Spinner>` or `<LoadingSpinner>`. Never a hand-written `animate-spin`.
- **Empty lists** are `<ListEmptyState>`. Never a hand-rolled "No X yet" block.
- **Colours** are semantic tokens. Never `gray-`/`slate-`/`neutral-` scales, `bg-white`, or
  `text-black` — they break dark mode.
- **Enum values are never rendered raw.** `status`, `type`, `priority` are stored lowercase or
  `snake_case`; render through a label map or `capitalize`.
- **Tooltips** are `<Tooltip title="…" enterDelay={300}>` from `@/components/ui/Tooltip`, never
  native `title=` and never a UI library — MUI is not installed.
- **Icons** are `lucide-react`. Never Heroicons, never emoji.
- **Firebase client imports** in SSR-reachable code use dynamic `import()`.
- **The three `[id]` detail pages** (`matters/[matterId]`, `clients/[clientId]`, and
  `tasks/[taskId]`) share tabs and components (e.g. Time Tracking and Events on the matter and client
  pages are one shared component each, `billingComp/EntityTimeEntriesTab` and
  `eventComp/EntityEventsTab`, behind a thin per-parent wrapper). When you
  change one of these pages, check whether the other two have the same tab/section and whether
  the change belongs there too, instead of leaving them to drift apart.
  Their headers are all `PageHeader`, and there is no separate detail-header component.

## Reference files

| File | Read when |
|---|---|
| `references/surfaces.md` | Building a page — skeletons for all six surfaces |
| `references/primitives.md` | Any button, pill, card, input, tab, menu, spacing or type decision |
| `references/components.md` | Before building anything — full inventory of `ui/` |
| `references/tokens.md` | Choosing a colour, or working on marketing/messaging surfaces |
| `references/data-and-state.md` | Fetching, paging, hooks, services, permissions, navigation |
| `references/known-drift.md` | Before copying from any file not listed as an exemplar |

## When there is no precedent

Say so and ask. Do not invent a pattern — a one-off becomes what the next person copies, and
drift is far cheaper to prevent than to undo. If a pattern already exists inline in 2+ places,
extract it into `src/components/ui/` and switch the call sites over.
