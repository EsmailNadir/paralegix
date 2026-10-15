# Shared components — the full inventory

Everything in `src/components/ui/`, plus the three shared components that live one level up.
**Check this list before building anything.** Rebuilding a primitive that already exists is a
defect even when the copy looks right, because the next fix to the real one never reaches it.

Counts are files importing or referencing each component, and they go stale between audits;
treat them as rough magnitudes and re-run the command below if a number matters. A low count is
not permission to ignore it — `RoleBadge` had one call site while the firm dashboard hand-rolled its own
`roleColorMap` right next to it, which is exactly the failure this list prevents.

Regenerate the counts with:
```bash
cd frontend/src && for f in components/ui/*.tsx; do n=$(basename "$f" .tsx); \
  printf "%-26s %s\n" "$n" "$(grep -rl "\b$n\b" --include='*.tsx' . | grep -v "components/ui/$n.tsx" | wc -l)"; done | sort -k2 -rn
```

---

## Layout and page chrome

| Component | Uses | Notes |
|---|---|---|
| `PageHeader` | 25 | Compact page title row: title + description left, `actions` right, bottom border. `eyebrow`, `leading`, `children` optional. Replaced the old purple gradient hero; **never reintroduce the gradient banner.** The header of every detail page too (matter, task, client): `bordered={false}` because the `TabBar` below draws the one rule, `BackButton` as `leading`, the status badge beside the title inside the `title` node, the reference id as `description`, and header actions as `<Button size="compact">`. There is no separate detail-header component. |
| `BackButton` | 16 | Back link above a detail page header. `variant="link"` is the detail-page form. |
| `NavigationLink` | 6 | Native destination link that uses `useNavigation()` for ordinary activation and preserves modified clicks, targets and downloads. Supply the existing surface classes. |
| `SkipLink` | 3 | Focuses `main#main-content` to skip navigation. The target needs `tabIndex={-1}`. |
| `TabBar` | 15 | Underlined tab strip for a page's top-level views. Counts, `disabled`, `align="split"` for a right-hand group, `trailing` for a strip-level action, and built-in overflow scrolling with chevrons. |
| `SegmentedToggle` | 14 | Picks one of a few mutually exclusive options inside a panel: billing interval, report grouping, file source, a split method. **Not** a second way to draw the same list: every list has one view (see `primitives.md`, Lists). |
| `SectionLabel` | 43 | The small uppercase section eyebrow. `tone`, `gap` and `as` cover every spelling the 101 hand-written copies used; `sectionLabelClass()` gives the string to a site that cannot take the component. |
| `StepModalFooter` | 5 | Footer of a stepped modal: Cancel or Back on the left, Continue or submit on the right. Pass it to `Modal` as `footer` with `footerAlign="between"`. The partner of `FormStepIndicator`. |
| `CollapsibleSection` | 4 | Disclosure section inside a panel. |
| `ScrollArea` | 6 | Styled scroll container. |
| `FormStepIndicator` | 6 | Numbered step nav for a multi-step form/modal. A step is clickable once reached; steps ahead of `maxStepReached` stay locked. |
| `ThemeSelector` | 2 | Shared light/dark/system chooser. The caller owns persistence; pass `includeSystem={false}` for the client portal. |
| `StatTile` | 4 | One quick-stat card for a detail-page sidebar: big number, label, Lucide icon, on the standard `bg-surface rounded-2xl border border-outline-subtle p-4` card. Pass `onClick` to make it a button that jumps to the tab the stat counts. |

## Lists

| Component | Uses | Notes |
|---|---|---|
| `ListView` | 20 | The list/table primitive. Card rows via `renderRow`, plus selection, sort, and client- or server-side paging. There is no `DataGrid`; AG Grid is not a dependency. |
| `ListToolbar` | 18 | Bordered panel holding a list's search box + filter/action controls, above the list. |
| `ListPager` | 60 | Pagination control. The most-used list piece by far: most lists page without `ListView`. |
| `ListSkeleton` | 43 | Initial-load placeholder for a list. |
| `ListBusyIndicator` | 17 | The inline "Updating results…" line for a list whose rows stay on screen while a filter re-reads. `ListView` draws it itself; hand-rolled lists render it on a row that is already on screen (a count line, a chip row). |
| `ListEmptyState` | 42 | The "nothing here yet" dashed card. `compact` for lists inside a tab/panel/modal. Use it when a **list** has no rows; an inline one-liner inside a settings card is not a candidate, and a `border-dashed` drop zone is a different thing entirely. |
| `SortableTh` | 4 | Sortable table header cell. |
| `Th` | 2 | Plain table header cell. `thClass()` is shared with `SortableTh`, so a plain and a sortable column in one header row line up. |
| `SearchInput` | 11 | A list toolbar's search box: magnifier inside the left edge, clear button inside the right once there is text. `py-2` to match the filter dropdowns on the same row. |
| `EntityListTab` | 2 | One parent's matters or tasks as a tab: search box and status dropdown over a `ListView`, create button on the right. `EntityMattersTab` and `EntityTasksTab` wrap it; the row renderer and the match function are the props. Its search box is `SearchInput`, named by the placeholder text. |
| `TruncatedListNotice` | 14 | An `InlineWarning` saying a capped list is incomplete (no counts), worded per `mode`: `browse`, `search`, `list`, `firmList`, `selection`. |
| `ShowMoreButton` | 6 | Expand a truncated list. |
| `CollapsibleList` | 4 | Draws the first `previewLimit` rows and grows in place to reveal the rest. Pair it with `ShowMoreButton`, which owns the `expanded` state. `pinned` rows stay on screen while collapsed, so a draft the user is still filling in never hides behind "Show more". |
| `ListSection` | 5 | The `space-y-4` stack that keeps a list page's heading row, toolbar and list together (matters, tasks, clients, contacts, files). |
| `HighlightText` | 10 | Highlights the search term inside row text. |

## Buttons, menus, actions

| Component | Uses | Notes |
|---|---|---|
| `Button` | 160 | Page / panel header CTA at `size="compact"`; modal footers, form actions, destructive actions at the other sizes. Native `<button>` attributes pass through, so it works as a `<Tooltip>` child. `type`: `primary` (filled accent) `secondary` `danger` `success`. There is no `outline`: it rendered the same string as `secondary` and was merged into it. `loading` prop. `htmlType` for `submit`. |
| `AuthButton` | 12 | Full-width CTA for a standalone auth/onboarding screen (login, register, reset-password, verify-email, accept-invite, complete-registration, the client-portal entry page). `variant`: `primary` `secondary`. `loading` prop; `href` renders a `next/link` instead of a `<button>`. See `primitives.md` §3. |
| `ActionIconButton` | 30 | Icon-only action button with the settled hover/padding. Owns its tooltip. |
| `Tooltip` | 84 | The hover label. Portalled, flips placement, opens on hover and `:focus-visible` only. See `primitives.md`. |
| `RowActionMenu` | 13 | Overflow "⋯" menu for a list row. |
| `ItemActionMenu` | 13 | Overflow menu for a card/tile. |
| `ClearFiltersButton` | 8 | Resets a filter row. |
| `ZoomControls` | 7 | Zoom in/out/reset for document viewers. |

## Form controls

| Component | Uses | Notes |
|---|---|---|
| `Dropdown` | 110 | The select. Click-outside close and menu animation built in. The menu renders in a body portal by default, so a `Card` or `overflow-hidden` panel cannot clip it; `portal={false}` only where it must scroll with an inner container. **Never hand-roll a dropdown.** |
| `useAnchoredMenuPosition` (hook, `hooks/`) | 4 | Fixed-position and flip-above logic for a body-portalled menu hanging from a control. Shared by `Dropdown`, `CourtNameAutocomplete`, `ClientOrganizationAutocomplete`, `MatterMemberPicker`; use it for any new anchored menu. |
| `EntityPicker` | 28 | Matter/client/task select backed by the `/lookup` server typeahead. Use when the list can be large; it resolves an already-selected id's label itself. For `entity="clients"`, `clientType` scopes to person or company clients, and `excludeLinkedToClientId` drops person clients already linked to a given company. |
| `EntityMultiPicker` | 6 | The multi-select variant. |
| `CategoryTreeSelect` | 2 | Hierarchical category picker. Must animate with `menuAnim` (150ms). |
| `CategoryFilterDropdown` | 2 | Category filter for a list toolbar. |
| `Checkbox` | 50 | The checkbox. |
| `ToggleSwitch` | 18 | Accent (cobalt) pill switch: use for **every** boolean setting. |
| `OptionListEditor` | 2 | Edits a dropdown field's choices: one input per option, remove per row, "Add option", Enter adds the next row. Never a one-per-line textarea. |
| `ColorSwatchPicker` | 3 | Compact picker for editable stored hex colors such as pipeline stages. Status enums still use `StatusBadge`. |
| `HoursMinutesInput` | 4 | Duration entry for time entries. |
| `Textarea` | 5 | The multi-line counterpart to `TextInput`, same class string; set the height with `rows`. |
| `MentionTextarea` | 1 | Textarea with @-mention autocomplete. |
| `SelectablePersonList` | 5 | Multi-select people list (avatar · name/email · check). Use for all "pick people" UIs. |
| `DatePicker` | 36 | Single-date calendar popover replacing the native `<input type="date">` (unstylable in dark mode, unscriptable open state). `bare` drops its own border for a fused multi-field cluster. `openTo` sets the month an empty picker opens on. See `DateRangePicker`, `DateTimePicker`. |
| `DateRangePicker` | 14 | Calendar range picker for filter bars. Portalled like `Dropdown`, but keeps its own positioning at `z-[9999]`. Inclusive `from`/`to`, either may be set alone. |
| `DateTimePicker` | 6 | `DatePicker` plus a time segment. `onOpen` lets the caller seed a contextual default (e.g. the calendar's already-selected day) instead of a fixed "now". `timeOnly` drops the month grid for a time-of-day field beside a `DatePicker`. |
| `DateTimeRangeFields` (`eventComp/`) | 4 | The Start (or Due) and End rows of every event and task form: a date and a time each, dates only when all-day. Use it for any new start/end pair rather than placing pickers by hand. |
| `datePickerCore.ts` | 3 | Shared calendar-grid and date-math helpers behind the three pickers above. Not a component; import from it rather than re-deriving month grids. |
| `TextInput` | 30 | The text `<input>`. Renders `FULL_INPUT_CLS`; every native prop passes through, `ref` included. |
| `FieldLabel` | 80 | The form field `<label>`. `size`, `tone` and `gap` are the four combinations the app already used; native label attributes pass through. |
| `PasswordInput` | 4 | Password field with the show/hide toggle, for the auth pages only. It keeps the auth surface's own input metrics, not `TextInput`'s. |
| `CalendarMonthGrid` | 3 | The month grid inside `DatePicker`, `DateRangePicker` and `DateTimePicker`. Internal to the pickers; a page uses a picker, not this. |
| `inputClasses.ts` | n/a | `INPUT_CLS`, `FULL_INPUT_CLS`, `FIELD_LABEL_CLS`, `FIELD_LABEL_BLOCK_CLS`, `FIELD_CLS`: import these instead of retyping form-control strings. |

## Status, badges, identity

| Component | Uses | Notes |
|---|---|---|
| `StatusBadge` | 62 | The badge primitive: dot + outline pill. Takes a `variant`, **not** a colour. For anything with a stored enum behind it. |
| `CountPill` | 4 | A number riding on something else (unread, a section total). `tone="accent"` is the filled cobalt unread counter; neutral otherwise. **Not** `StatusBadge`: a count is not a state. |
| `MatterStatusBadge` | 10 | Pass the raw enum; resolves label + colour itself. |
| `TaskStatusBadge` | 7 | Same, plus an `overdue` prop that folds lateness in. |
| `TaskPriorityBadge` | 4 | Same for priority. |
| `ClientStatusBadge` | 3 | Same for clients. |
| `ContactCategoryBadge` | 7 | Same for contact categories. |
| `RoleBadge` | 3 | Member role badge. |
| `PaymentOngoingBadge` | 2 | Composes as a sibling next to a status badge. |
| `LockIndicator` | 2 | Locked-record marker. |
| `Avatar` | 18 | User/contact avatar with initials fallback. |
| `ParalegixLogo` | 25 | Theme-aware. **Never a raw `<Image>` for the logo.** |
| `TagChip` | 6 | Removable label chip (rounded pill, optional `×`). Not a `StatusBadge`, just a plain tag with no variant/enum colouring. |

## Feedback

| Component | Uses | Notes |
|---|---|---|
| `Spinner` | 73 | The inline in-flight indicator. Inherits `currentColor`. |
| `PanelLoadingSpinner` | 16 | The centered small spinner for an empty settings panel. |
| `LoadingSpinner` | — | Page/panel-level branded gradient mark. `sm` `md` `lg`, `fullPage`. Lives at `components/LoadingSpinner.tsx`. |
| `BusyToast` | 6 | For a trigger that unmounts on click (menu item, download). |
| `ErrorNotification` | — | Inline error banner; `null` if no error; accepts `string \| Error`; renders field-level `ApiError` validation; `compact` inside dialogs. At `components/ErrorNotification.tsx`. |
| `SuccessNotification` | — | The success counterpart. At `components/SuccessNotification.tsx`. |
| `Toast` | 7 | Fixed bottom-centre, auto-dismiss 5s, `tone` from `StatusVariant`. **Never use raw `alert()`.** |
| `ErrorToast` | 6 | `<Toast>` fixed to `danger` — the common case, kept under its own name. |
| `FieldError` | 15 | One field's validation message, under that control. |
| `ReasonField` | 2 | Controlled reason input for confirmation dialogs. The caller retains required/optional validation, saving and reset behavior. |
| `UploadProgressBar` | 5 | The bar every upload surface shows while it works: one label, one indeterminate track for the whole upload. A byte percentage would stall at 99 while the server still works. |
| `UploadStatusChip` | 2 | The busy state of a drop panel (signing and templates pages): label, cancel, indeterminate track. |
| `DuplicateNameWarning` | 10 | Advisory duplicate-name warning under matter, task, and client name controls; never blocks save. |
| `InlineWarning` | 4 | The amber advisory box for "what you see is not all of it" when the action still goes ahead; a refusal or failure is red `ErrorNotification` instead. Also exports `UploadLimitNotice`, said when a pick holds more files than one upload takes. |

## Modals

| Component | Uses | Notes |
|---|---|---|
| `ConfirmModal` | 68 | Delete/confirm dialogs, already animated and accessible. Don't build a new one. |
| `ConfirmAction` | 6 | Wraps `ConfirmModal` for a trigger that only needs a confirm step: a render prop gets `(requestConfirmation, busy)`, a failed `onConfirm` keeps the dialog open with an inline error, and a busy confirm cannot resubmit. |
| `StageFormModal` (`settingsComp/`) | 2 | Shared stage form state, fields, validation and save lifecycle. Lead and matter wrappers supply scope controls and payloads. |
| `CreditNoteFields` (`billingComp/`) | 1 | Type, amount and description inputs inside `CreditNoteModal`, the one credit-note dialog both invoice detail surfaces open. |
| `Modal` | 104 | The dialog shape: overlay, backdrop, centred panel, `useDialog` a11y, and the 100ms open/close animation, plus optional `title`/`subtitle`/`icon`/`footer`. **Use it for every new dialog.** It owns its own geometry: width comes from `size`, height from `height`, and a `max-w-*` or `max-h-*` passed in `className` is stripped at render and fails `check:modal-sizing`. Every modal dialog uses it, enforced by `check:dialog-shell`. Pass `stacked` for a dialog opened over another one, and `dismissible={!saving}` while a save is in flight (it blocks the backdrop, Escape and the close button). Callers that own their whole internal layout pass `bodyClassName={null}` and `labelledBy`. |
| `AttachClientModal` | 2 | The whole search / create / edit flow for attaching a firm client to a parent record, at `clientComp/`. Matter and task both use it through an `AttachClientTarget` adapter (`label`, `attachedClientIds`, `attach`, optional `detach`, `invalidateKeys`); `matterComp/AddClientModal` and `taskComp/AddTaskClientModal` are ~50-line wrappers over it. A third parent supplies another adapter, never another copy. |
| `AdminTransferModal` | 1 | Firm ownership transfer. |
| `CatalogPickerModal` | 2 | Generic "add from catalog" picker: search box + checkbox rows, already-added rows rendered inert. |
| `NameInputModal` | 4 | Small themed modal for a single name/rename prompt. Built on `Modal`, which owns the overlay, focus trap and animation; the caller passes `open`/`onClose`. Pair it with the `useNamePrompt` hook, which keeps the typed name and the error after a rejected save. |

## Gates and status pages

| Component | Uses | Notes |
|---|---|---|
| `RequirePermission` | 25 | `<RequirePermission permission="domain.action">` |
| `RequireFeature` | 9 | Plan/feature flag gate. |
| `StatusPage` | 12 | The base full-page status screen the rest build on. |
| `AccessDeniedPage` | 5 | |
| `AdminAccessRequired` | 8 | At `adminComp/`. What an `/admin` page renders for a non-admin. Not `AccessDeniedPage`: `/admin` is a separate surface with its own full-page chrome. |
| `AuthRequiredPage` | 3 | |
| `ResourceNotFoundPage` | 5 | |
| `UnexpectedErrorPage` | 8 | |
| `DocumentTooLargePage` | 1 | A document over a size limit. A limit, not an error: never reuse `UnexpectedErrorPage` for it. |
| `InvalidLinkPage` | 8 | |
| `FeatureDisabledPage` | 1 | |
| `MaintenancePage` | 2 | |
| `ConnectionUnavailable` | 2 | |

## Detail and document

| Component | Uses | Notes |
|---|---|---|
| `Card` | 32 | The panel surface: `rounded-2xl`, `border-outline-subtle`, the one-pixel shadow and `overflow-hidden`. `CARD_CLS` is the string. Never retype it. |
| `DetailField` | 3 | Label + value row on a detail card. |
| `LinkifiedText` | 6 | Free text with http(s), mailto, tel and markdown `[label](url)` links rendered as links, built from text nodes so nothing is parsed as HTML. Use it for event descriptions and message bodies; the caller sets `whitespace-pre-wrap`. |
| `PdfCanvasPage` | 2 | Rendered PDF page canvas. |
| `StripeFeeNote` | 3 | Stripe fee disclosure line. |

## Marketing and legal

Legal pages, consent and the cookie banner. They sit outside the app shell; each row says which palette it uses.

| Component | Uses |
|---|---|
| `LegalPageHeader` / `LegalPageFooter` | 3 each |
| `CookieNotice` | 1 (root layout; picks the marketing, sign-in or app palette from the path) |
| `SignupConsent` | 3 (the terms line under every sign-up form; app tokens) |
| `CookieSettingsLink` | 3 (reopens the banner as accept/decline; caller styles it) |

## Class-string modules

| File | Exports |
|---|---|
| `ui/inputClasses.ts` | `INPUT_CLS`, `FULL_INPUT_CLS`, `FIELD_LABEL_CLS`, `FIELD_LABEL_BLOCK_CLS`, `FIELD_CLS` |
| `ui/transitionClasses.ts` | `backdropAnim`, `cardAnim`, `menuAnim`, `selectMenuAnim`, `bannerAnim`, `listOverflowAnim` |

---

## Shared modal fields and viewers

| Component | Use |
|---|---|
| `clientComp/ClientFields` | Controlled name, email, phone, organization, address and preferred contact; callers own invites and links. |
| `taskComp/taskForm/TaskFormBody` | Create/edit task steps with court-sync callbacks and an optional original-task summary. |
| `matterComp/MatterBillingFields` | Full matter and focused billing fields; callers own validation and persistence. |
| `billingComp/TimeEntryCore` | Duration/date controls and duration policy; note entries retain their 24-hour limit. |
| `billingComp/InvoiceMoneySummary` / `InvoiceDetailRow` | Invoice context rows and amounts in existing row, tile and client-summary presentations. |
| `billingComp/CreditNoteModal` | Credit-note form and footer; existing detail/client dismissal policies remain explicit. |
| `contactsComp/ContactIdentityField` / `ContactDuplicateWarning` | Directory and client-contact controls plus advisory duplicate selection. |
| `filesComp/FolderBrowserBody` / `FolderBrowserRows` | Loading and folder rows; `useFolderBrowser` owns trail and current-request state. |
| `ui/DocumentViewerModal` / `DocumentViewerHeader` | Template, note, signing and intake viewer shells with their established geometry. |

## Adding a primitive

If a pattern exists inline in 2+ places, extract it into `src/components/ui/` and switch the
call sites over. Add a row here. Give it a doc comment that says what job it does *and* what
neighbouring component does the adjacent job — `TabBar` and `ListEmptyState` are the models.

## The matter / task / client parallel

Matters, tasks and clients repeatedly grow the *same* feature: notes, events, time tracking,
attached clients, messages. The copies always start identical and always drift, in ways nobody
notices because no single screen looks wrong. `AddClientModal` and `AddTaskClientModal` sat at
91% identical, and the 9% that differed was accidental: one had a guard the other lacked, and
they looked companies up two different ways.

So when you build one of these, **check whether the other two already have it**, and if the
answer is yes, extract one component taking a small adapter for the parts that genuinely differ
(the service call, the query keys, the noun in the copy). Put it in the folder for the concept,
not the parent — `AttachClientModal` lives in `clientComp/` because it is about clients. Do not
add a `matterId`/`taskId`/`clientId` union prop and branch inside; that is the same copy with
extra steps.
