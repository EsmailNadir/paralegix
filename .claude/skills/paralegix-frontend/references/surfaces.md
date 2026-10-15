# Surfaces — the six page skeletons

Identify which surface you are building before you write anything. They have different
skeletons, and two of them use a different colour vocabulary entirely.

---

## 1. List page

`/lawfirm/[lawFirmId]/[feature]/page.tsx` is a **thin wrapper**: resolve `lawFirmId` from
`useParams()`, gate with `<RequirePermission>`, render the feature component. That component
owns all data, state, and modals.

```tsx
"use client";
export default function FeaturePage() {
  const params = useParams();
  const lawFirmId = (Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : params?.lawFirmId) || "";
  if (!lawFirmId) return null;
  return (
    <RequirePermission permission="domain.view">
      <FeatureGrid lawFirmId={lawFirmId} />
    </RequirePermission>
  );
}
```

The feature component's outer shell, in this order:

```tsx
<div className="min-h-screen bg-page">
  <div className="p-4 pl-5 md:p-6 max-w-[1600px] mx-auto space-y-6 min-w-0">
    <ErrorNotification error={error} onClose={() => setError(null)} />
    <PageHeader title="…" description="…" actions={…} />
    <ListToolbar>  {/* search + filters */}  </ListToolbar>
    <ListView … />
    {/* modals, rendered unconditionally with an `open` prop */}
  </div>
</div>
```

**Naming.** Only seven components are actually named `*Grid.tsx` (`ContactsGrid`, `MattersGrid`,
`TasksGrid`, `ClientViewGrid`, `SigningTemplateGrid`, `LeadsGrid`, `FirmNotesGrid`). Most feature pages inline the shell in
`page.tsx` instead. Extract a named component when the page exceeds ~200 lines or the wrapper
needs more than the permission gate; otherwise inlining matches the majority.

**Copy from:** `components/contactsComp/ContactsGrid.tsx`: current, and the
cleanest example of `PageHeader` + `ErrorNotification` + `ListView` + server paging together.
`components/matterComp/MattersGrid.tsx` when you also need filters, bulk actions, or export.

---

## 2. Detail page

`/lawfirm/[lawFirmId]/[feature]/[id]/page.tsx`. The list page's outer shell plus extra top
padding (`pt-10 md:pt-14`) for the back link, then a sidebar/main split.

```tsx
<div className="min-h-screen bg-page">
  <div className="p-4 pl-5 pt-10 md:p-6 md:pt-14 max-w-[1600px] mx-auto space-y-6 min-w-0">
    <BackButton href={`/lawfirm/${lawFirmId}/contacts`} label="Back to Contacts" variant="link" />
    <PageHeader title={record.name} description={…} actions={…} />
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className={`${CARD_CLASS} lg:col-span-1 space-y-4`}>{/* identity / at-a-glance */}</div>
      <div className={`${CARD_CLASS} lg:col-span-2 space-y-4`}>{/* the main content */}</div>
    </div>
  </div>
</div>
```

with `const CARD_CLASS = "bg-surface rounded-2xl border border-outline-subtle p-6 shadow-sm";`
at the top of the file.

**Tabbed detail pages** (matter, task, client, invoice) put a `<TabBar>` below the header and swap the
body. Matter, task and client headers are `<PageHeader bordered={false}>` (the `TabBar`'s own border is
the one rule), with `<BackButton>` as `leading`, the status badge beside the title and `<Button
size="compact">` actions. They all use `<TabBar>` now; `border-b-2` no longer appears in any of them. The overflow
scroll controls and edge fades that used to justify a hand-rolled strip moved into `TabBar`
itself, so use it.

**Field rows** inside a detail card: `<DetailField>` where it fits, otherwise a
`text-xs text-on-surface-muted` label above a `text-sm text-on-surface` value.

**Copy from:** `app/lawfirm/[lawFirmId]/contacts/[contactId]/page.tsx`.

---

## 3. Settings panel

`/lawfirm/[lawFirmId]/settings/*` sits inside `settings/layout.tsx`, which already supplies the
page chrome and the one `PageHeader`: **do not add another `min-h-screen bg-page` wrapper or a
second `PageHeader`.** A settings page is a stack
of cards:

```tsx
<div className="space-y-6">
  <SectionLabel>…</SectionLabel>  {/* the page's own heading; the layout owns PageHeader */}
  <div className="bg-surface rounded-2xl border border-outline-subtle p-6 space-y-4">
    <h2 className="text-lg font-semibold text-on-surface">Section</h2>
    …
  </div>
</div>
```

Boolean settings are always `<ToggleSwitch>`. A section that divides internally uses
`pt-4 border-t border-outline-subtle space-y-4`.

**Copy from:** `app/lawfirm/[lawFirmId]/settings/roles/page.tsx`.

---

## 4. Modal

**Build every new dialog with `ui/Modal`.** It owns the overlay, the backdrop, the centred
panel, the `useDialog` accessibility plumbing, and the 100ms animation, and it renders the same
markup the hand-rolled copies do. No dialog inlines that scaffold any more: `check:dialog-shell` fails on a `role="dialog"`
outside `ui/Modal` and a short allowlist (`known-drift.md` §0).

```tsx
<Modal isOpen={open} onClose={onClose} size="lg" title="Add note" subtitle="…"
       footer={<><Button type="secondary" onClick={onClose}>Cancel</Button>
                 <Button type="primary" onClick={save} loading={saving}>Save</Button></>}>
  {/* body */}
</Modal>
```

Useful props: `size` (`sm`…`5xl`), `icon`, `closeIcon`, `showClose`, `dismissible` (false
while a save is in flight: blocks backdrop, Escape and the close button), `stacked` (opened
on top of another dialog), `portal`, `lockScroll`, `bodyClassName`. A dialog whose header or
footer departs from the standard shape keeps its own markup as children and passes
`bodyClassName={null}` plus `labelledBy="<its own heading id>"`, so it still gets the overlay,
focus trap and animation from one place.

The two requirements below are what `Modal` implements. They still bind any dialog that has not
been migrated yet:

- **The shared open/close animation** — `useMountTransition` + `backdropAnim`/`cardAnim` from
  `@/components/ui/transitionClasses`, duration `100` to match the `overlay-*` EXIT keyframes in
  `global.css`.
- **The shared accessibility plumbing** — `useDialog` from `@/hooks/useDialog`, which owns focus
  move-in, focus restore on close, the Tab focus trap, and Escape-to-close. Spread its
  `dialogRef` onto the **card** (not the backdrop) and its `titleId` onto the heading behind
  `aria-labelledby`. It deliberately does not lock body scroll; add `useBodyScrollLock(open)`
  when the page behind would otherwise scroll under the dialog.

A modal missing either one is incomplete. The animation alone makes a modal *look* finished,
which is how a quarter of them once shipped without a focus trap; `check-ui.sh` now enforces the
pairing.

The hand-rolled shape, for reading the dialogs that still use it:

```tsx
const { mounted, exiting } = useMountTransition(open, 100);
const { dialogRef, titleId } = useDialog({ isOpen: open, onClose });
if (!mounted) return null;              // NOT `if (!open)` — keep mounted while exit plays
return (
  <div className="fixed inset-0 z-50">
    <div className={`absolute inset-0 bg-black/40 ${backdropAnim(exiting)}`} onClick={onClose} />
    <div className="absolute inset-0 flex items-center justify-center p-4 pointer-events-none">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
           className={`w-full max-w-md rounded-lg bg-surface shadow-xl max-h-[85vh] flex flex-col relative pointer-events-auto ${cardAnim(exiting)}`}
           onClick={(e) => e.stopPropagation()}>
        {/* header: border-b border-outline, <h2 id={titleId}>
            body:   overflow-y-auto styled-scrollbar
            footer: bg-surface-alt border-t — ErrorNotification, then the button row */}
      </div>
    </div>
  </div>
);
```

### The mounting rule

**The exit animation only plays if the modal stays mounted while closing.** So the modal takes
an `open`/`isOpen` prop and the parent renders it **unconditionally** (`<Modal isOpen={x} onClose={close} />`),
never `{x && <Modal />}`. If closing clears the modal's data (e.g. `editing = null`), keep a
separate `open` boolean so content doesn't blank mid-exit. If the modal fetches at top level,
guard it (`enabled: open`, or `if (!open) return;`) so it doesn't fetch while closed.

### The close-handler rule

**A close handler hides the modal and does nothing else.** It must never empty the form, drop
the record being edited, or clear the error — the modal is on screen for the whole exit
animation, so the user watches it blank out and *then* disappear. This is the single most common
modal defect in this codebase; it has been fixed everywhere, so do not reintroduce it.

```tsx
// The modal owns the state it clears:
const handleClose = () => onClose();                  // hides, nothing else
useResetAfterClose(open, () => { setName(""); setError(null); /* … */ });

// The state lives in the parent and arrives as a prop:
const shownMessage = useLastOpenValue(isOpen, message);   // render this, not `message`
```

`useResetAfterClose(isOpen, reset)` runs `reset` once the exit animation has finished (`reset`
need not be memoized; reopening within the delay cancels it). `useLastOpenValue(isOpen, value)`
holds the last value the dialog had while open, for content a parent clears on close.
`Modal` retains its title, subtitle, icon, footer and children during exit. `ConfirmModal`
and `FilePreviewModal` also retain their content internally, so their callers may clear freely. Prefer restoring the component's *defaults* in the reset over blanking, so reopening
lands where it opened the first time.

The same rule covers anything derived from that state: an `{editing ? "Edit X" : "New X"}`
heading or submit label flips to its "add" wording mid-fade unless it reads a `useLastOpenValue`
copy.

### Inline overlays

For an overlay inside a larger component (`{showX && (...)}`) use a local transition:
`useMountTransition(showX, 100)`, render on `{xMounted && ...}`, apply
`backdropAnim(xExiting)`/`cardAnim(xExiting)`.

**Copy from:** `components/billingComp/AddExpenseModal.tsx` (complete). Deletes always
go through `<ConfirmModal>`.

---

## 5. Client portal - `/client/*`

14 pages plus `components/portalComp/`. Same token vocabulary and the same primitives as the
firm app, but a different navigation shell (`components/sidebar/ClientSidebar.tsx`) and a much
narrower permission model - the portal has no RBAC gates, only the client identity link.

Build these exactly like a firm list/detail page; the only differences are the sidebar and the
service layer (`client-portal.service.ts`).

**Accessibility (WCAG AA):** The client portal layout includes `<SkipLink />`, which always targets `#main-content`
and wraps primary views in `<main id="main-content">`. All interactive tables, document pickers, and
record tabs require keyboard navigability, explicit aria labels, and `useDialog` modals.
Verify all portal changes with `expect((await scanAccessibility(container)).violations).toEqual([])` (`tests/support/accessibility.ts`).

---

## 6. Marketing and Public - `/`, `/pricing`, `/features`, `/workflow`, `/login`, `/register`

`/verify-email`, `/reset-password`, `/intake/*` and `/share/*` are public too, but they are built
with the app tokens (`bg-page`, `bg-surface`) and `ui/` controls such as `AuthButton`, not this
family.

**A deliberately separate visual language.** These pages use the `mkt-*` token family
(`bg-mkt-paper`, `text-mkt-ink`, `text-mkt-accent`, `font-mkt-serif`, `shadow-mkt-lg`, ...), their
own primitives in `components/marketingComp/primitives.tsx`, and `router.push()` rather than
`navigate()`.

**Do not apply the app rules here.** `bg-surface`/`text-on-surface` is the wrong vocabulary on a
marketing page, and `<Button>` is the wrong control - use the local `Btn`. Conversely, never
pull `mkt-*` tokens into the app.

**Accessibility (WCAG AA):** Marketing pages (`MarketingNav`) and legal pages (`LegalPageHeader`)
render `<SkipLink>` to `<main id="main-content">`. The standalone auth and intake pages
(`/login`, `/register`, `/verify-email`, `/reset-password`, `/intake/*`) are single forms with no
repeated navigation, so they carry a `<main>` landmark and no skip link. Their submit errors go
through `useFormFeedback` (`setFieldError(name, msg)` focuses that field, `setErrorMessage(msg)`
focuses the summary at `feedbackRef`), as do the portal settings and billing forms. Fields use explicit
`<label>` connections with `aria-describedby` error associations, and dynamic feedback is a status
or alert region. Verify changes with `expect((await scanAccessibility(container)).violations).toEqual([])`.

**Copy from:** `components/marketingComp/sections.tsx`.
