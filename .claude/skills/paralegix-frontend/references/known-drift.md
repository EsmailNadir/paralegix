# Known drift — do not copy from these

The core instruction of this skill is "open the nearest existing equivalent and copy it." That
is only safe if you know which neighbours are wrong. Everything below is real, shipped code that
is **not** precedent.

Counts measured across `frontend/src`. Regenerate with
`bash .claude/skills/paralegix-frontend/scripts/check-ui.sh --all` from the repo root.

---

## 0. The hand-rolled dialog scaffold: FIXED, and guarded

Every modal dialog now renders through `ui/Modal`. The last fifteen copies existed mostly because
`Modal` was hardcoded `z-50` and could not paint above another open dialog; `Modal` now takes
`stacked` (overlay `z-[60]`, always portaled out of the parent panel, whose transform would
otherwise trap both `fixed` and z-index), and every nested dialog uses it.

`npm run check:dialog-shell` (part of `ci:checks`) fails on any `role="dialog"` outside
`ui/Modal`. Its allowlist is the only non-modal uses: the three date-picker popovers,
`sidebar/ClientSidebar.tsx` and `calendarComp/Calendar.tsx` (mobile drawers), and
`filesComp/DocumentPreviewOverlay.tsx` (full-screen viewer). Other `fixed inset-0` layers that are
not dialogs (route-transition veils, submission veils, menu click-catchers) carry no dialog role
and are not affected.

The copies were never uniform, which is why the migration was manual: they disagreed on header
padding (`px-6 py-4` vs `px-5 py-4`), the close glyph (`&times;`, `&#x2715;`, `<X size={18}/>`),
panel radius and shadow, and whether the backdrop closed during a save. Each migrated file
reproduced what it already did rather than normalising silently, via `closeIcon`,
`dismissible` (then named `closeOnBackdrop`), `className`, or `bodyClassName={null}` + `labelledBy` for a custom header.

Two accepted, intentional deltas from the migration: every converted dialog's open/close
animation is now `Modal`'s fixed 100ms, which is what the hand-rolled ones used, and a dialog that
disabled its own close "×" during a save now uses `dismissible={!saving}`, which blocks the
backdrop, Escape and the "×" together.

---

## 1. Modals missing the accessibility plumbing — FIXED

Every real dialog in the app now has `useDialog` alongside its animation, almost all of them
through `ui/Modal`, so only a handful of files still carry `role="dialog"` or the hook directly.
The ones without a focus trap are the calendar popovers
(`ui/DatePicker.tsx`, `ui/DateRangePicker.tsx`, `ui/DateTimePicker.tsx`), which are portalled
and deliberately exempt. `check-ui.sh` enforces the parity for overlay dialogs only: its rule
requires `fixed inset-0 z-`, which a popover does not have, so it will not catch a fourth
exception on its own.

The rule that produced the gap still applies to new code, and it is easy to reintroduce, because
`useMountTransition` alone makes a modal *look* finished. A modal needs **both**: the animation
and the `useDialog` plumbing (`role="dialog"`, `aria-modal`, `aria-labelledby={titleId}`, the
ref on the card).

`BillingActionsMenu` uses `useMountTransition` without `useDialog` and is correct: it is a
`menuAnim` popover, not a dialog. `check-ui.sh` skips files that use `menuAnim` for this reason —
so if you add a real dialog to a file that also has a popover, the check won't catch a missing
`useDialog`. Get it right by hand there.

`ui/Modal` supplies both halves, so a dialog built with it cannot have this gap.
`components/billingComp/AddExpenseModal.tsx` is the exemplar to copy, and it now builds on
`ui/Modal` itself rather than showing the hand-rolled shape.

---

## 2. Hand-rolled badges and pills — status ones FIXED

Every pill with a **stored enum** behind it now goes through `statusMeta`: matter status, task
status and priority, event type, invoice status, document-request status, billing plan status,
firm billing status, portal status, user type, trust remittance. `<StatusBadge>` is at 100 call
sites, the per-domain badges at 35.

What that sweep found, and what it protects against:

- The client portal rendered matter `active` **green** in three places while the firm app
  rendered it **blue**, because the portal had its own `getStatusStyles`.
- Invoice status existed in **three** copies with different words — the same invoice read
  "Unpaid" on one page and "Outstanding" on another, "Written Off" vs "Adjusted".
- `SubscriptionStatus`'s local `STATUS_CONFIG` had no entry for `trialing`, `incomplete` or
  `canceled` — the values the database actually stores — so a **cancelled subscription
  displayed as "Free"**.
- Portal event-type pills rendered the raw enum, so `court_date` showed as "Court_date".

The pills that remain are metadata and counts, which is the other legitimate register — see
`primitives.md`. The rule is the boundary: **if a stored enum is behind it, it is a status
badge.**

## 3. Local colour maps — FIXED

`STATUS_STYLES`, `roleColorMap`, `TYPE_BADGE`, `PORTAL_BADGE_CLS`, `TYPE_BADGE_CLS`,
`REQUEST_STATUS_CLASSES`, `ITEM_STATUS_CLASSES`, `priorityClasses`, `getMatterStatusClasses`,
`getStatusStyles`, `STATUS_CONFIG`, `BILLING_STATUS_CONFIG` and two duplicate
`getInvoiceStatus` copies are all gone, as is `config/noteTypes.ts` (a light-only palette with
emoji icons). `check-ui.sh` rule 4 still reports hits, but they are records that already
resolve to a `StatusVariant` (`FOLDER_COLORS`, `TRUST_TRANSACTION_TYPES`), not colour maps. The
trust transaction types live once, in `trustComp/trustTransactionTypes.ts`, shared by the
transaction list and both ledger dialogs.

`statusMeta.ts` gained: `BILLING_STATUS_META`, `NOTE_TYPE_META`, `BILLING_PLAN_STATUS_META`,
`DOCUMENT_REQUEST_STATUS_META`, `DOCUMENT_REQUEST_ITEM_STATUS_META`,
`CLIENT_PORTAL_STATUS_META`, `USER_TYPE_META`, `TRUST_REMITTANCE_STATUS_META`,
`TIME_ENTRY_BILLING_STATUS_META`, `TRUST_ACCOUNT_STATUS_META`.

The rule stands: a `Record<value, colour>` in a component is exactly what `@/constants/statusMeta`
exists to prevent. It is how matter `active` ended up blue on three screens and green on two
others, and task priority `low` blue in one list and green in another. Adding a new vocabulary
means a new `*_META` record, not a map at the call site.

---

## 4. Hand-rolled empty states

The genuine `ListEmptyState` duplicates — a dashed card standing in for an absent list — have
been converted. What remains is **not** all convertible, so don't sweep on a grep alone:

- **Inline one-liners** (`<p className="text-sm text-on-surface-secondary">No courts yet.</p>`)
  sit inside a settings card or a table body. `ListEmptyState` is a `py-10`/`py-16` dashed card
  with a `text-lg` headline — dropping one in place of a single line is a layout change, not a
  refactor. Leave them unless the surface genuinely wants a card.
- **Drop zones** (`UploadZone`, `FileUpload`, `TaskAttachments`, `NoteAttachments`,
  `MatterFileQuickAdd`, `TemplateCreatePanel`) also use `border-dashed`. They are not empty
  states. Never convert one.

Use `<ListEmptyState>` when a **list** has no rows and the surface has room for a card.

---

## 5. Hand-rolled spinners — FIXED

Every `<Loader2 className="animate-spin">` and hand-rolled
`rounded-full border-t-transparent animate-spin` div is now `<Spinner>`. 64 occurrences → 6.
`Loader2` is now imported only by `ui/Spinner.tsx` itself.

The 6 that remain are all `<RefreshCw className={loading ? "animate-spin" : ""}>` on `/admin`
pages — a refresh
button rotating its **own** icon in place. That is a different affordance from a spinner and is
deliberate; `check-ui.sh` still flags them, so read the hit before acting.

---

## 6. The old card era

`bg-surface rounded-lg border border-outline` — the pre-`rounded-2xl` family. Concentrated in
`components/billingComp/InvoiceDetailView.tsx`, the client-invoice and generate-invoice pages,
and `settings/general/page.tsx`. New cards use
`bg-surface rounded-2xl border border-outline-subtle`.

---

## 7. Hardcoded colours

Dead Ant Design / AG Grid CSS (105 lines) and the genuine dark-mode breaks are gone. The
app-wide accent-token pass converted every raw `indigo-*`/`violet-*` accent usage to the
semantic `accent-*` tokens (`bg-accent-solid`, `text-accent-emphasis`, …), which resolve to the
current brand blue (`#3B66E0`). `focus:ring-violet-500` is at 0 occurrences, and the one `bg-indigo-600` left is the `indigo`
status colour in `constants/statusMeta.ts`, not an accent. What is left is mostly *working* but off-token, plus a set of deliberate
exceptions:

- `bg-blue-600` (raw Tailwind, not the `accent-*` tokens) remains only in
  `components/ui/LegalPageHeader.tsx` (legal pages intentionally don't use the app accent).
  `statusMeta.ts`'s `info` variant also uses `bg-blue-500`/`bg-blue-600` deliberately — that's a
  status colour, not the app accent, and stays outside the token system by design.
- `gray-`/`slate-` scales that **do** carry a `dark:` counterpart. They work; they are just not
  tokens.

**Legitimate uses of `bg-white` / `text-black`, which `check-ui.sh` cannot tell apart:**
alpha overlays on a coloured fill (`bg-white/15`), toggle-switch knobs and radio dots sitting on
an `accent-solid` fill, and anything representing **paper** — `SignatureModal`, `SignatureVisual`, and
the template preview in `FillTemplateModal` deliberately render a white page in both themes.

---

## 8. Hand-rolled dropdowns and tabs — tabs FIXED

**Tabs:** every strip is now `<TabBar>`. `BillingTabBar` is deleted — it was a near-duplicate
with a **blue** active underline where every other bar was indigo, so billing's tabs looked like
a different product. The matter detail page's bespoke overflow machinery (wheel-to-scroll,
gradient fades, chevrons) moved into `TabBar`, so every strip now has it instead of one.

**Dropdowns:** roughly **15 files** still build an absolute-positioned menu by hand instead of
using `Dropdown` / `RowActionMenu` / `ItemActionMenu` (`trustComp/TrustAccountList.tsx`'s
hand-rolled "⋯" menu was converted to `ItemActionMenu`; a full re-audit of the rest is
outstanding). Two native `<select>` filters (`taskComp/EntityTasksTab.tsx`,
`matterComp/EntityMattersTab.tsx`) were also converted to `Dropdown`, matching `TasksGrid.tsx`'s
equivalent filter. If you are editing one of the remaining hand-rolled menus, match what's
there. If you are building new, use the component.

---

## 9. Z-index escalation

`z-[9999]` (7) sits above the `z-50` / `z-[60]` ladder. All seven are body-portalled menus and
popovers that must clear an open modal, so this is a deliberate exemption list, not drift:
`ui/Tooltip.tsx`, `ui/DatePicker.tsx`, `ui/DateRangePicker.tsx`,
`ui/DateTimePicker.tsx`, `ui/CategoryFilterDropdown.tsx`, `ui/CategoryTreeSelect.tsx`,
`notesComp/TiptapEditor.tsx`. `Dropdown` and the menus that share `useAnchoredMenuPosition`
portal at `z-[60]`. Anything else reaching for `z-[9999]` has the nesting wrong.

---

## 10. Scratch and dead code

`app/design/invoice-redesign/` used to be listed here: a scratch page with static fake data
that shipped in the production bundle and was linked from nothing. It is deleted.

The Ant Design and AG Grid CSS that outlived both libraries (`.custom-pagination .ant-*`,
`.mobile-scroll-table .ag-*`, `--ag-row-border-width`, `.file-table .ant-table-measure-row`) has
been removed. Neither library is in `package.json`.

---

## 11. Buttons left hand-rolled on purpose

Every header CTA, toolbar action and empty-state action is on `<Button>`. Three buttons still
hand-roll the header metrics (`px-3.5 py-2`) because `<Button>` has no variant for what they show.
They are exemptions, not precedent:

- `clientComp/ClientDetail.tsx` "Revoke Portal Access": an amber warning edge. `danger` is red.
- `app/lawfirm/[lawFirmId]/messages/page.tsx` Archived / Inbox: a toggle with a pressed state.
- `templatesComp/TemplateItems.tsx` `FILL_CLS` "Fill": a row action sized to match the
  `rounded-lg` kebab beside it.

`grep -rn "px-3.5 py-2" frontend/src | grep -v ui/Button.tsx` lists them, plus
`ui/PasswordInput.tsx`, `ui/SegmentedToggle.tsx`, `ui/AuthButton.tsx` and the `px-3.5 py-2.5` inputs
on the auth screens (login, register, invites, reset-password), none of them header CTAs. Anything
else it prints is new drift.

## What to do when you find drift

Fix it **only** in the file you were already changing, and only when the fix is local. Do not
open a drift-cleanup campaign as a side effect of a feature — that turns a reviewable diff into
an unreviewable one. If the drift is worth a sweep, say so and let the owner decide.
