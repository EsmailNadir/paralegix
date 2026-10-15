# Primitives — the measured values

Every number here is the dominant value counted across `frontend/src`. Where two values compete,
both counts are given and the winner is named. Use the winner; do not average, and do not pick
the one you happened to see in the last file you opened.

---

## Buttons

There are **three different primary buttons**. Know which one you want before you type.

### 1. Page / panel header CTA: `<Button size="compact">`

Used by every `PageHeader actions=` block and every panel's "New …" action:

```tsx
<Button size="compact" onClick={openCreate} icon={<Plus size={14} strokeWidth={2.2} />}>
  New form
</Button>
```

It renders `shrink-0 gap-1.5 px-3.5 py-2 text-xs rounded-xl` on the filled accent, the metrics
the hand-copied class string used to carry (`px-3.5 py-2`, `rounded-xl`, `text-xs`). Never paste
that string into new code. Three buttons keep it on purpose (`known-drift.md` §11). Layout classes
(`mt-4`, `w-full sm:w-auto`, `md:hidden`) may still go in `className`; colour, border and
padding may not.

Its **secondary partner** in the same row is `<Button type="secondary" size="compact">`.

Never restyle a `<Button>` through `className` (no `border-accent-*` / `text-accent-emphasis`
"accent outline"). The action that commits is `type="primary"`; everything else is
`secondary`.

### 2. `<Button>` — modal footers, form actions, destructive actions

The radius comes with the size: `small`, `medium` and `large` are `rounded-md`, `compact` is
`rounded-xl` (§1). The primary variant is the filled semantic app accent.

| Prop | Values |
|---|---|
| `type` | `primary` (filled accent) · `secondary` (outline neutral) · `danger` · `success`. There is no `outline`: it rendered the same string as `secondary` and was merged into it |
| Edge | `secondary` uses `border-control-border`, not `border-outline`. A button's edge is the only thing marking where it begins, so it owes 3:1 (WCAG 1.4.11); a card edge or divider is decoration and keeps `--outline` |
| `size` | `compact` `shrink-0 gap-1.5 px-3.5 py-2 text-xs rounded-xl` (header CTA, §1) · `small` `px-3 py-1.5 text-xs` · `medium` `px-4 py-2 text-sm` (default) · `large` `px-6 py-3 text-base` |
| Native attributes | pass through to the `<button>`, so a `<Button>` works as a `<Tooltip>` child |
| `htmlType` | defaults to `button` — pass `submit` explicitly for the submitting button |
| `loading` | swaps in `<Spinner size={16}>` (14 at `size="compact"`) and disables |

**Never mix the compact header CTA metrics with modal-footer button metrics in one row.**

### 3. `<AuthButton>` — the standalone auth / onboarding screen CTA

Full width, larger than either of the above: `login`, `register` (+ `invite`/`member-invite`),
`reset-password`, `verify-email`, `accept-invite`, `accept-member-invite`,
`complete-registration`, `auth/action`, `auth/reconnect`, and the client portal's own
`client/lawfirm/[id]` entry screen. These render outside the app shell on a single centered
card, so neither the compact header CTA nor `<Button>` fits the scale.

```tsx
<AuthButton onClick={...} loading={submitting}>Sign In</AuthButton>
<AuthButton variant="secondary" onClick={...}>Cancel</AuthButton>
<AuthButton href="/login">Sign In Now</AuthButton>   {/* renders a next/link, same look */}
```

Base shape: `w-full py-2.5 px-4 rounded-xl text-sm`. `primary` (default) is
`bg-accent-solid text-accent-foreground font-semibold shadow-sm dark:shadow-none`; `secondary`
is `bg-surface border border-outline font-medium`. `loading` shows a leading `<Spinner>` and
disables — pass it only for the control whose own action is in flight, so one spinner never
covers two buttons. Extracted from 17 near-identical hand-rolled call sites (four of which used
a raw `text-white` instead of `text-accent-foreground`, and two of which were missing
`shadow-sm` — both now fixed by the shared component).

### 4. Icon-only buttons

Use `<ActionIconButton>` where it fits (30 files). Hand-rolled, the dominant shape is
`p-1.5 rounded-lg` (57) — then `p-2 rounded-lg` (26) and `p-2 rounded-xl` (22). Prefer
`p-1.5 rounded-lg` with `hover:bg-surface-hover`. Icon-only buttons need an `aria-label`.

### 5. Destructive

`<ConfirmModal>` (68 files) or `<Button type="danger">`. Raw `bg-red-600` buttons exist in single
digits — do not add another.

---

## Pills and badges

There are **two registers, and they are not interchangeable.**

- **A status badge** says what something *is* — bordered, on `bg-surface`, with a coloured dot.
  Its colour carries meaning and comes from `statusMeta`. This is `<StatusBadge>` and the
  per-domain badges (100 + 35 call sites).
- **A metadata pill** says something that has no state — a tag, a label, a count. Tinted or
  neutral, no dot. Legitimate, but it must never encode a stored enum.

If the thing you are rendering has a **stored enum behind it** (status, priority, type,
category), it is a status badge, full stop. Rendering it as a tinted pill is how the same matter
came to look green in the client portal and blue in the firm app.

### The canonical badge

```tsx
<MatterStatusBadge status={matter.status} />
<TaskStatusBadge status={task.status} overdue={overdue} />
<TaskPriorityBadge priority={task.priority} />
<StatusBadge variant="info">Draft</StatusBadge>
```

`StatusBadge`'s own shape, for reference — do not retype it:

```
inline-flex items-center gap-1.5 rounded-full border border-outline-subtle bg-surface px-2.5 py-0.5 text-xs font-medium
```
plus a `size-1.5 shrink-0 rounded-full` dot carrying the variant colour.

Note the register: **bordered, on `bg-surface`, with a colour dot** — not a tinted background.
A pill with `bg-emerald-50 text-emerald-700` is the old era.

### Variants

From `@/constants/statusMeta`: `success` `warning` `danger` `info` `neutral` `purple` `indigo`
`teal` `pink` `cyan`. A variant names a *meaning*, not a colour, and carries `dot`, `text`, `tint` (10% wash),
`edge` (left border), `solid` (filled background), `hex` (for recharts and anything that can't take a class).

### Add-ons compose as siblings

A state never trades away its own colour to say something extra:

```tsx
<MatterStatusBadge status={m.status} />
{m.paymentOngoing && <PaymentOngoingBadge />}
```

The one exception is task lateness, folded into `TaskStatusBadge`'s `overdue` prop as
"In Progress · Overdue", because a dense list row should spend one badge slot on a task's state.

### Count pills

A number riding on something else is `<CountPill>`, **not** `StatusBadge` — a count says how
*many*, and its colour should mean only "there are some" or nothing at all.

```tsx
<CountPill count={unread} tone="accent" />        {/* filled cobalt — unread only */}
<CountPill count={rows.length} showZero />        {/* neutral — an ordinary total */}
```

`tone="accent"` is reserved for something awaiting the reader. Using it for an ordinary total is
how every count on a screen ends up shouting. Zero draws nothing unless you pass `showZero`.

`TabBar` draws its own count pill from the tab's `count`, so a tab needs no `CountPill`.

### A shape the badge can't cover

A dashboard widget pill, a chart series, a compact calendar chip: each still takes its word and colour
from the same meta; only the shape is local:

```tsx
const style = styleOf(taskPriorityMeta(priority));   // { dot, text, tint, edge, hex }
<span className={`... ${style.tint} ${style.text}`}>{taskPriorityMeta(priority).label}</span>
```

Adding a new vocabulary means a new `*_META` record in `statusMeta.ts`, not a map in a component.

---

## Cards and panels

There are two eras. **Use the recent family**, through `<Card>` (`ui/Card.tsx`), or its
`CARD_CLS` string for a site that cannot take the component:

```
bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] overflow-hidden
```

91 uses bare, plus `p-5` (20), `p-6 shadow-sm` (15), `shadow-sm` (15), `p-8` (9). Pick padding
by context — `p-5`/`p-6` for a normal panel, `p-8`/`p-12` for a centred empty/hero panel — and
add `shadow-sm` only where the card floats over `bg-page`.

**Do not** copy the older `rounded-lg` + `border-outline` family (`billingComp/InvoiceDetailView.tsx`,
the client-invoice and generate-invoice pages, `settings/general`).

Never retype the string: use `<Card>`, which replaced 35 hand-typed copies of that shadow.
Older files that still carry a local `CARD_CLASS` constant are not precedent.

### Radius, overall

| Radius | Where | Count |
|---|---|---|
| `rounded-md` | inputs, `<Button>` | 575 |
| `rounded-lg` | icon buttons, menu rows, modal cards, inner chrome | 878 |
| `rounded-xl` | the filled header CTA, `ListView`'s container, toolbars | 438 |
| `rounded-2xl` | cards and panels | 269 |
| `rounded-full` | badges, pills, avatars, dots | — |

### Outlines

`border-outline` (876) is the stronger line — table containers, dividers inside dense chrome,
the older card family. `border-outline-subtle` (738) is the softer one — the current card
family and row separators inside a list. Secondary buttons use `border-control-border`.
Cards use **subtle**; the
`ListView` container and its toolbar use **outline**.

Shadows: `shadow-sm` (214) on cards, `shadow-xl` (143) on modal cards, `shadow-lg` (45) on
floating menus. `shadow-md`/`shadow-2xl` are rare — don't reach for them.

---

## Modals

Full skeleton and the state rules are in `surfaces.md`. The measured values:

| Part | Value |
|---|---|
| Backdrop | `absolute inset-0 bg-black/40` (118 vs `/50` 23) |
| Card radius | `rounded-lg` (96 vs `rounded-xl` 51, `rounded-2xl` 16) |
| Card shadow | `shadow-xl` |
| Card base | `w-full max-w-md rounded-lg bg-surface shadow-xl pointer-events-auto max-h-[90vh] flex flex-col` |
| Width | The `size` prop only: `sm` `md` (default) `lg` `xl` `2xl` `3xl` `4xl` `5xl` `screen`. `md` for a one-column form, `lg` for two columns, `2xl`+ for an editor, `screen` (80vw) for a viewer |
| Height | The `height` prop only: `auto` (default, content-sized, capped at 90vh) · `fill` (a fixed 90vh, for a viewer or a long list) · `steps` (a fixed `min(720px,90vh)`, for a wizard) · `none` (no cap, for a cropper that sizes its own canvas) |
| Sizing from the call site | Never. A `max-w-*`, `max-h-*`, `w-*` or `h-*` in `className` is stripped by the panel and fails `check:modal-sizing` |
| Below `sm` | The panel is a bottom sheet: `max-sm:max-w-none` (full width whatever `size` says), `max-sm:rounded-b-none` on the panel and the footer bar, `max-sm:max-h-[85svh]`, and the positioner is `items-end p-0 sm:items-center sm:p-4`. `svh` not `vh`, so the actions are not left under the browser chrome, and not `dvh`, which resizes the sheet as the chrome hides |
| Duration | `useMountTransition(open, 100)`, the card and backdrop EXIT duration. They enter over 120ms and leave over 100ms, and the hook delays the unmount, so it is the exit that has to match. Menus pass 150. `tests/styles/overlayTiming.test.ts` fails when the two drift |
| Z-index | `z-50` |
| Header | `border-b border-outline`, `<h2 id={titleId}>` |
| Body | `overflow-y-auto styled-scrollbar` |
| Footer | `bg-surface-alt border-t`, error banner above a `flex justify-end gap-2` row. `footerAlign="between"` for a Back and Continue pair; never hand-roll the bar |
| Multi-step | `height="steps"`, with `<StepModalFooter>` passed as `footer` plus `footerAlign="between"`. It owns the Cancel/Back and Continue/submit pair and their widths; never hand-roll it. A content-sized wizard moves its own buttons on Continue |

---

## Inputs and forms

Use `<TextInput>`, `<Textarea>` and `<FieldLabel>`. They render the shared strings in
`ui/inputClasses.ts` (`FULL_INPUT_CLS`, `FIELD_LABEL_BLOCK_CLS`), and they replaced about 60
hand-typed copies. The strings, for reference only:

```
w-full rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring
```

Label: `block text-sm font-medium text-on-surface mb-1`.
Required fields: append ` *` to the label text — same colour, no `text-red-500`, no `<span>`.

**In a filter row** — where a plain `<input>` sits beside a `Dropdown`/`EntityPicker` — import
the shared strings from `@/components/ui/inputClasses` (`INPUT_CLS`, `FULL_INPUT_CLS`,
`FIELD_LABEL_CLS`, `FIELD_LABEL_BLOCK_CLS`, `FIELD_CLS`) instead of retyping, so the controls resolve to the same box. **Never give a filter
control a fixed height** (`h-10`, `h-11`): the `Dropdown` trigger is `px-3 py-2 text-sm`, so a
fixed height makes the input visibly taller than the dropdowns beside it.

**Do not add a focus style to a new control, and never a `focus:border-*`.** A border
that recolours on focus draws a second edge one pixel inside the outline, which is how the
search bar ended up with two rings; 63 such classes were removed and
`tests/styles/focusIndicator.test.ts` fails if one returns. `global.css` draws one for every focusable
element in the app: a 2px `--focus-ring` outline at a 1px offset on `:focus-visible`, so it
appears for keyboard users and not on a mouse click. It is `!important`, and the ring
box-shadow is suppressed app-wide, so a `focus-visible:ring-*` you add renders nothing and a
`focus:outline-none` you add is overridden. The 219 ring utilities already in the tree are
inert and are left alone rather than swept. Nothing else changes on focus: the border recolour
that used to sit alongside the outline is gone, along with its `--control-focus-border` token,
because the two drew a second edge one pixel inside the first.

**The one exception is a fused cluster**: several controls behind one shared border, split by
`divide-x`, that read as one field (the flat fee row, `HoursMinutesInput`, the tag box). Give
the container `fused-field-group` plus `focus-within:ring-2 focus-within:ring-focus-ring`.
`global.css` then removes the outline from the focused cell, and the ring on the container is the
indicator. A non-field cell opts in with `fused-field-cell` (the `bare` `DatePicker` trigger does);
a button inside the cluster keeps its own outline.

**Number inputs have no spinner.** `global.css` removes it from every `input[type="number"]`.
Never add `[appearance:textfield]` or the spin-button classes at a call site;
`tests/styles/numberSpinner.test.ts` fails if one returns.

Other form primitives: `<Checkbox>` (50 files), `<ToggleSwitch>` for every boolean setting,
`<HoursMinutesInput>`, `<MentionTextarea>`, `<SelectablePersonList>` for any "pick people" UI.

---

## Dropdowns and menus

Always `@/components/ui/Dropdown`. Never a hand-rolled `useState` open/close + absolute div —
16 files still do this and they are drift, not precedent.

```tsx
<Dropdown label="Status" value={status} onChange={setStatus}
  options={[{ label: "Open", value: "open" }, { label: "Closed", value: "closed" }]}
  placeholder="Select status" />
```

For matters/clients/tasks use `<EntityPicker>` — it wraps `Dropdown` in controlled search so
options come from the `/lookup` typeahead rather than a fully loaded list, and it resolves the
label of an already-selected id itself. `<EntityMultiPicker>` for the multi variant.

`Dropdown` bakes in `menuAnim` + `useMountTransition`, satisfying the "every menu animates"
rule. Any specialised menu (e.g. `CategoryTreeSelect`) must animate with `menuAnim` at **150ms**.

Row/overflow menus: `<RowActionMenu>` (list rows) and `<ItemActionMenu>` (cards/tiles).

`Dropdown` `options` carry human labels, never the raw enum value.

---

## Lists and tables

See `surfaces.md` for the page skeleton and `data-and-state.md` for paging. The pieces:

| Piece | Component |
|---|---|
| The list itself | `<ListView>` — card rows via `renderRow`, plus selection, sort, paging |
| Search + filter chrome above it | `<ListToolbar>` |
| Loading | `<ListSkeleton>` (43 files) |
| Nothing to show | `<ListEmptyState>` (42 uses; 70 files still hand-roll one; don't) |
| Pagination | `<ListPager>` (57 files) |
| Sortable header cell | `<SortableTh>` |
| Search box | `<SearchInput>` |
| Search-term highlighting | `<HighlightText>` |
| "this list is incomplete" notice | `<TruncatedListNotice>` |

`ListView` row shape, for anything that must match it by hand:
`flex items-start gap-3 border-b border-outline-subtle px-4 py-3 transition-colors last:border-b-0 sm:items-center`,
inside `overflow-hidden rounded-xl border border-outline bg-surface`.

There is no `DataGrid` and AG Grid is not a dependency.

**A list has one view.** No list offers a second way to draw the same rows: no board or
kanban, no card grid, no List/Grid toggle. The leads board, the tasks kanban, the matters
kanban and the templates card grid were all removed on purpose. Do not add one back; a
different grouping belongs in a filter or a sort, not a second view.

---

## Tabs

`<TabBar>` — an underlined strip for a page's own top-level views, each with its own search,
filters and paging. Active tab is a cobalt underline continuing the bar's border. Every tab
strip in the app is one; there is no second tab design.

`<SegmentedToggle>` is the other control and a different job: it picks one of a few mutually
exclusive options inside a panel (billing interval, report grouping, file source). It never
switches a list between two ways of drawing it; a list has one view.

```tsx
<TabBar
  value={activeTab}
  onChange={setActiveTab}
  tabs={[
    { value: "overview", label: "Overview" },
    { value: "notes", label: "Notes", count: notes.length },
  ]}
/>
```

| Prop | Use |
|---|---|
| `count` | Draws the tab's count pill. `0`/`undefined` draws nothing. |
| `disabled` | A view that cannot be entered *right now* (a save in flight). For permissions, filter the tab out of `tabs` instead — don't advertise a view that will never open. |
| `icon` | A `LucideIcon`, rendered at 16. |
| `secondary` + `align="split"` | Pins that tab to the right-hand end, separating daily views from configuration (billing's "Rates & setup"). |
| `trailing` | An action belonging to the strip rather than a tab ("Edit line items"). Sits outside the tab list. |

The strip scrolls when tabs outrun their container and shows a fade plus a chevron at whichever
end still has tabs behind it — the scrollbar is hidden and a mouse wheel only scrolls
vertically, so without the chevrons a mouse user on a narrow window cannot reach the overflow
or even know it exists. This is built in; do not rebuild it at a call site.

---

## Spacing

| Context | Value |
|---|---|
| Page wrapper | `p-4 pl-5 md:p-6 max-w-[1600px] mx-auto space-y-6 min-w-0` |
| Between top-level page sections | `space-y-6` |
| Stack inside a card | `space-y-4` (173) then `space-y-3` (128) |
| Tight stack (label + value) | `space-y-1` / `space-y-1.5` |
| Button rows | `gap-2` (720) |
| Icon + label inside a button | `gap-1.5` (313) |
| List-row columns | `gap-3` (505) |
| Card grids | `gap-4` (202) |

### Grids

| Layout | String |
|---|---|
| Two-column form / card pair | `grid grid-cols-1 md:grid-cols-2 gap-4` (22) |
| Dense two-up inside a panel | `grid grid-cols-2 gap-3` (19) |
| Three-column dashboard | `grid grid-cols-1 lg:grid-cols-3 gap-6` (5) |
| Detail page: sidebar + main | `grid grid-cols-1 lg:grid-cols-3 gap-6` with `lg:col-span-1` / `lg:col-span-2` |

Mobile-first always: start at `grid-cols-1` (114) and add `md:`/`lg:` breakpoints.

---

## Typography

| Role | Class | Count |
|---|---|---|
| Section heading | `text-lg font-semibold text-on-surface` | 190 |
| Card title | `text-sm font-semibold text-on-surface` | 163 |
| Field label / row title | `text-sm font-medium text-on-surface` | 563 |
| Body | `text-sm text-on-surface-secondary` | — |
| Helper / muted | `text-xs text-on-surface-muted` | — |
| Small emphasis | `text-xs font-medium text-on-surface` | 240 |

Page titles come from `PageHeader` — never write one by hand. `text-2xl font-bold` (37) is
marketing and admin only. Overall the scale is `text-sm` (2206) and `text-xs` (1585); anything
larger than `text-lg` inside the app is unusual and should be justified.

---

## Icons

`lucide-react` only.

Sizes are **not** standardised inside buttons — `14` (248), `15` (202), `16` (175), `13` (163)
are all in heavy use. **Match the file you are editing** rather than introducing a fifth value.
`strokeWidth={2}` is the default (149); `2.2` (31) belongs to the filled header CTA.

Where the convention *is* settled: empty-state icons at `32`–`40`. `size={48}` appears zero
times — don't start.

`size={16}` and `className="w-4 h-4"` (237) are the same thing; prefer `size=` on lucide icons
and reserve `w-N h-N` for avatars and image boxes.

---

## Motion

`transition-colors` (883) is the default and needs no explicit duration — Tailwind's 150ms is
correct. Reach for `transition-all` (144) only when more than colour changes.

Explicit durations: `duration-200` for overlays and cards, `duration-150` for menus. Anything
above 300ms is drift.

Never use a scale transform on hover — it shifts layout. Colour, background, and border are the
hover vocabulary; `hover:bg-surface-hover` (580) is settled. Not `hover:bg-indigo-50`, not
`hover:bg-surface-alt`.

---

## Layering

| Layer | z |
|---|---|
| In-card overlays, click-catchers | `z-10` |
| Sticky headers inside a scroll container | `z-20` |
| In-place (non-portal) menus, popovers | `z-30` / `z-40` |
| Body-portalled menus (`Dropdown`, `useAnchoredMenuPosition` users) | `z-[60]` |
| Modals and their backdrops | `z-50` (172) |
| A modal opened *from* a modal | `z-[60]` |

`z-[9999]` sits on a fixed exemption list of seven older portalled popovers (`known-drift.md`
§9); `z-[70]` and `z-[100]` are escalation hacks. If you need to go above `z-[60]`, the nesting is
probably wrong.

A menu or suggestion list hanging from a control inside a `Card`, a modal body or any
`overflow-hidden` panel gets clipped if it is `absolute`. Render it in a `document.body` portal
at `z-[60]` and position it with `useAnchoredMenuPosition` (`@/hooks/useAnchoredMenuPosition`),
which `Dropdown`, `CourtNameAutocomplete`, `ClientOrganizationAutocomplete` and
`MatterMemberPicker` share. It flips above the control when there is no room below.

---

## In-flight feedback

One spinner shape. Never hand-write `<svg className="animate-spin">`, a
`rounded-full border-t-transparent animate-spin` div, or a bare `<Loader2 className="animate-spin">`
— they draw different arcs at different speeds, so two on one screen read as two kinds of wait.
Six hand-rolled instances remain, all `RefreshCw ... animate-spin` on `/admin` pages; they are
drift. `Loader2` is imported only by `ui/Spinner.tsx` itself.

```tsx
<Spinner />                                  // 14px, inherits currentColor
<Spinner size={16} className="text-on-surface-muted" />
<Spinner size={32} label="Loading files" />  // label only when no visible text says it
```

Which affordance:

| Situation | Use |
|---|---|
| Trigger stays on screen | `<Button loading>` or `<Spinner>` swapped in for the row's icon |
| Trigger unmounts on click (menu item, download) | `<BusyToast message="…" />` |
| Server page change in a list | the paged-table `fetching` flag, which `ListView` renders |
| Filter/search change in a list | `<ListBusyIndicator busy={fetching && !pagerPending}>` on a row already on screen |
| Whole page or empty panel | `<LoadingSpinner />` — the larger branded mark |
| A list's initial load | `<ListSkeleton>` |

Keep `loading` for the initial-load skeleton so a page change doesn't collapse the list.

A filter change is NOT a page change. The rows, the count and the totals all keep their old
values until the response lands, so without `<ListBusyIndicator>` the click reads as ignored.
Pass `onPendingChange` from `ListPager` and suppress the line while a page click is pending —
the clicked button already carries that wait, and two acknowledgements read as two waits.

---

## Errors

Never a bare red `<p>`. Two shapes, picked by what the error is about:

- **Whole-form** (validation before submit, failed save):
  `<ErrorNotification error={error} onClose={() => setError(null)} compact className="mb-3" />`
  placed **in the modal footer, directly above the button row** — not at the top of the
  scrollable body, where it sits off-screen once the user has scrolled to the submit button.
  Restructure the footer into a column (banner, then the `flex justify-end` row).
- **One field** (name taken, malformed amount): `<FieldError message={err} />` directly under
  that control.

Both render `null` when empty — drop them in unconditionally. For a transient success/failure
after the trigger is gone, `<ErrorToast>` (fixed bottom-centre, auto-dismiss 5s). Never
`alert()`.

---

## Tooltips

`<Tooltip title="…" enterDelay={300}>` from `@/components/ui/Tooltip`. Native `title=` is
inconsistent and slow. MUI is **not** installed — this is a local primitive, not a re-export.

It clones its child to attach the handlers, so the child has to be a single element that puts
props on a DOM node (a host element, or a component that spreads them). For a **disabled**
button — which fires no events — wrap it in a `<span>` so the span does the listening.

- `placement` is `"bottom"` (default) or `"top"`, and flips on its own when the preferred side
  has no room. The label is portalled to `<body>`, so an `overflow-hidden` row can't clip it.
- An empty `title` renders no tooltip, so `title={canEdit ? "" : "Why not"}` needs no branch.
- `arrow` is for callouts that explain a state. Don't put one on an action button.
- Opens on hover and on `:focus-visible`, never on touch (a tap has no matching "leave").
- A string `title` becomes the child's `aria-label` when it has no accessible name of its own.

---

## Enum labels

Enum-ish values (status, priority, type, jurisdiction, court type, role) are stored lowercase or
`snake_case`. Never render them directly.

- **Single word** (`active`, `open`, `high`): add the Tailwind `capitalize` class.
- **snake_case / multi-word** (`court_date`, `in_progress`): `capitalize` yields "Court\_date",
  so use a label map (`STATUS_LABELS[x] ?? x`) or
  `(s||"").replace(/_/g," ").replace(/\b\w/g, c => c.toUpperCase())`.

Applies to badges, `renderRow` content, and inline text. There is no global CSS fix — a wrapper
`capitalize` would also mangle names and prose.
