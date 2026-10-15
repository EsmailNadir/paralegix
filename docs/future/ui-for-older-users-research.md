# UI for Older Users: Modal Sizing, Buttons, Color and Type (Research)

::: warning INTERNAL RESEARCH
This document collects external best practices and compares them with the current
frontend. It is a reference for design decisions, not an implementation plan. Every
finding about the codebase names the file and line it came from. Counts were taken
on 2026-09-06 and drift as the code changes.
:::

## Fixed since this research

Two findings are closed. The rest of the document still describes the code as it
stands.

- **Muted text contrast.** `--on-surface-muted` moved from `#6B7488` to `#5C6479`,
  which clears 4.5:1 on every light background. `tests/styles/tokenContrast.test.ts`
  computes the ratio for every text token against every surface token, in both
  themes, and fails if one drops below 4.5:1.
- **The focus indicator.** The app suppressed `outline` and `box-shadow` on every
  focused element, so none of the 219 `focus-visible:ring-2` utilities declared
  across 97 files rendered anything. That is replaced by one rule: a 2px
  `--focus-ring` outline at a 1px offset on `:focus-visible`, marked `!important`
  because `focus:outline-none` on every button and input resolves to the same
  specificity and would otherwise win on emission order. Ring box-shadows stay
  suppressed so only one edge is ever drawn, which is what made the previous
  attempt read as a doubled outline. Mouse clicks still show nothing.
- **A doubled focus ring.** The global outline landed 1px outside a border that
  also recoloured to the accent on focus, so a focused search bar showed two
  concentric blue rings. The recolour came from three places: a global
  `.border-input-border:focus` rule and 63 `focus:border-*` classes across 26
  files. All are gone, and the outline is now the whole indicator, drawn on the
  element that actually has focus. `tests/styles/focusIndicator.test.ts` scans the
  source for a competing focus style and fails if one returns.
- **Overlay exit timing.** `useMountTransition` defaulted to 200ms and three
  dialogs passed it explicitly, while the card and backdrop exit animations run
  for 100ms. Every closed dialog held its scroll lock and focus trap for an extra
  100ms. All four now use 100, and `tests/styles/overlayTiming.test.ts` reads both
  the stylesheet and the call sites so they cannot drift apart again.
- **Control boundary contrast.** `--input-border` moved from `#B7C0D2` to
  `#747E92` in light and `#2C3A52` to `#6B7583` in dark, clearing 3:1 against
  every surface it touches. It was 1.48:1 and 1.34:1.
- **Wizard geometry.** All five multi-step dialogs take `height="steps"`, a fixed
  `min(720px, 90vh)`, so the panel no longer grows and shrinks on Continue. `Modal`
  gained a `footerAlign` prop, so the four wizards that hand-rolled a
  `justify-between` footer now use the shared one. Cancel and Back carry the same
  `min-w-[88px]`, so the left slot keeps its width across the step change.
  `tests/components/tasks/CreateTaskModal.test.tsx` asserts the panel class is
  byte-identical on all three steps.
- **Mobile dialogs.** `Modal` had no responsive classes, so a dialog on a 375px
  screen was a fixed-width card floating in the middle. Below `sm` the panel is now
  a full-width bottom sheet with a square bottom edge, capped at `85svh` so its
  actions are not left under the browser chrome.
- **The dead `outline` button variant.** `outline` and `secondary` rendered
  byte-identical class strings. A test proved the two identical, then the 114 call
  sites across 38 files moved to `secondary` and the variant was deleted.
- **The modal sizing escape hatch.** `Modal` gained a `height` prop
  (`auto`, `fill`, `none`) and a `screen` width. It now strips any width or height
  utility from `className` and always renders its own, so the result no longer
  depends on Tailwind's emission order. All 37 call sites that sized a dialog by
  hand were migrated, the 14 height treatments became 3, and
  `npm run check:modal-sizing` fails the build on a new one. The default cap moved
  from 85vh to 90vh, which is the value 12 files had already overridden to.

## Summary

Paralegix is used daily by attorneys, and a large share of attorneys are over 55.
The evidence base for that audience is consistent: bigger text, higher contrast,
bigger click targets, visible labels, no hover-only controls, and a layout that
does not move. Every mature design system centralizes dialog sizing in one closed
size enum with a bounded height. Paralegix already has the enum, but three things
undercut it:

1. **Height was content-driven.** No modal had a minimum height, so every wizard grew
   and shrank on Continue. The panel is vertically centered, so both edges moved.
   This is now fixed.
2. **The escape hatch was used more than the rule.** Callers could pass any
   `max-w-*` or `max-h-*` through `className`, and 14 distinct height treatments
   existed. This is now fixed.
3. **Two accessibility rules that the skill prescribes are cancelled in code.**
   Focus rings are suppressed globally, and the most-used muted text color fails
   the WCAG contrast minimum in light mode.

## Key takeaways

- **Fix the wizard geometry first.** Give multi-step modals a fixed height (for example
  `min(640px, 90dvh)`) and make the footer sticky. Nothing else about the modal work
  is felt as directly by users.
- **Close the sizing escape hatch.** Add `height` and `footerAlign` props to `Modal`,
  then remove the `className` width and height overrides. Enforce it with the
  existing `check-ui.sh` guard.
- **Restore focus rings.** Delete the global `outline: none !important` rule. This
  is one CSS change and it is a WCAG Level A failure today.
- **Darken the muted token.** Done. `--on-surface-muted` moved to `#5C6479`.
- **Raise the floor on text and targets.** Retire `text-[9px]`, `text-[10px]` and
  `text-[11px]`. Give `Button` a minimum height of 44px for `medium` and 32px for
  `small`.
- **Consider a full page for matter creation.** Clio, PracticePanther, CosmoLex and
  Smokeball web all create a matter on a page, not in a dialog. The wizard-in-a-modal
  pattern is what design systems warn against.

## Who the users are

| Fact | Value | Source |
| --- | --- | --- |
| Median age of a US lawyer (2024) | 46, versus 42 for all workers | ABA Profile of the Legal Profession |
| Lawyers aged 65 or older | About 13%, versus 7% of the workforce | ABA, secondary reporting |
| Adults over 60 with a color vision abnormality | About 40% | Medical News Today, 2014 study |
| Older adults who keep written step-by-step notes | 50% of NN/g participants | NN/g, 2019 |
| Task success, older adults versus ages 21 to 55 | 55% versus 75% | NN/g, 2013 |
| Errors per task, older adults versus younger | 2.4 versus 1.1 | NN/g, 2013 |

Two of these numbers matter most for this document. Half of older users keep written
instructions, so any change that moves a control invalidates their notes. Consistency
beats novelty. And 40% have some color confusion, most often blue against purple and
green against yellow, so status must never rest on hue alone.

## Modals

### How design systems size a dialog

Every mature system uses a closed enum of named widths. None scales width to content.
Values below are from the shipped CSS or the published spec.

| System | Named widths | Height rule | Below the mobile breakpoint |
| --- | --- | --- | --- |
| Atlassian | small 400, medium 600, large 800, x-large 968 | `max-height: calc(100vh - 119px)`, body scrolls | Full screen under 480px |
| Shopify Polaris | small 380, default 620, large 980 | `max-height: calc(100vh - spacing)`, optional 600px cap | Bottom sheet, full width |
| IBM Carbon | xs 24%, sm 36%, md 48%, lg 72% of viewport | Max height 48% to 96% by size, header and footer fixed | 100% width, cap removed |
| Material 3 | min 280, max 560 | Title and actions pinned, body scrolls | Full-screen dialog |
| GitLab Pajamas | sm 512, md 768, lg 990 | Content-driven, scrollable variant caps at viewport | New page recommended |
| USWDS | default 480, large 880 | Content-driven | Full width |
| Bootstrap 5 | sm 300, default 500, lg 800, xl 1140 | `.modal-dialog-scrollable` for body scroll | `.modal-fullscreen-*-down` |
| Chakra v3 | xs 384, sm 448, md 512, lg 672, xl 896 | `scrollBehavior="inside"` caps at `calc(100% - 7.5rem)` | `size` set to `full` below `md` |
| ServiceNow Horizon | small, medium 600, large | Publishes a min and max height per size | Not verified |
| shadcn/ui | one default, 512 | Content-driven | `calc(100% - 2rem)` |

Three patterns hold across all of them:

- **Width lives in tokens, not in call sites.** USWDS uses `$theme-modal-*-max-width`,
  GitLab uses `$gl-modal-*-width`, Polaris uses `--pc-modal-frame-*-width`. Atlassian
  accepts a raw pixel value but documents the named size as the recommended way.
- **Header and footer are pinned. Only the body scrolls.** Carbon states this directly.
  Material 3 pins the title at the top and the buttons at the bottom.
- **Fewer sizes is normal.** USWDS has two. Carbon and Atlassian have four. Paralegix
  has eight, which is more than any system surveyed.

### Keeping height stable across wizard steps

This is the specific complaint: click Continue and the dialog shrinks or grows. The
guidance that speaks to it directly:

- Appian's wizard layout doc: avoid auto height in dialogs, because the height changes
  from step to step.
- ServiceNow publishes a minimum and a maximum height for each dialog size, for the
  same reason.
- PatternFly keeps the dialog content-driven but requires steps small enough that no
  step scrolls, and uses a dedicated footer with Back, Next and Cancel in fixed slots.
- NN/g's older-adult studies found that content which moves or resizes under the
  cursor caused errors, and participants preferred static widgets.

The consensus mechanism for a wizard:

1. Pick one enum size for the whole flow. The widest step wins.
2. Fix the panel height, or set a minimum height equal to the tallest step, so short
   steps do not collapse.
3. Cap the height in viewport units and scroll the body inside. Prefer `dvh` over `vh`
   so a sticky footer is not hidden behind mobile browser chrome.
4. Keep the footer sticky, with Back on the left and the primary action on the right,
   in the same slots on every step. Give both slots a fixed minimum width so a label
   change from Cancel to Back does not move the button edge.
5. Keep the step indicator at a fixed height. Do not let a banner inside a step
   change the indicator's position.

### How Paralegix does it today

The shared component is `frontend/src/components/ui/Modal.tsx`. It
does the right things for focus (trap, restore, Escape), for animation (respects
`prefers-reduced-motion`), and for the footer (`shrink-0`, so it never scrolls). The
problems are in sizing.

**Width.** The `size` prop maps to eight Tailwind widths from `max-w-sm` (384px) to
`max-w-5xl` (1024px). Call-site distribution: `md` 39, `lg` 27, `xl` 12, `2xl` 10,
`sm` 6, `3xl` 4, `4xl` 4, `5xl` 1. Six files ignore `size` and set `max-w-*` in
`className` instead. One more width, `max-w-[80vw]`, exists outside the enum.

**Height.** There is no `height` or `minHeight` prop. The panel is `flex flex-col`
with `max-h-[85vh]` and nothing else, so height follows content. Fourteen distinct
height treatments exist across the app: the default `85vh`, overrides at `50vh`,
`70vh`, `75vh`, `80vh`, `88vh`, `90vh`, `95vh`, `max-h-none`, fixed `h-[85vh]`,
`h-[90vh]`, `h-[95vh]`, `h-[600px]` and `h-full`. The `90vh` override alone appears
in about ten files, which is the clearest signal that the `85vh` default is wrong for
the app's real content.

**The wizards.** Five multi-step modals exist, all three steps, all using
`FormStepIndicator`:

| Wizard | Steps | Width | Height cap |
| --- | --- | --- | --- |
| `frontend/src/components/matterComp/CreateMatterModal.tsx:434` | Clients, Matter Details, Team | `2xl` | `90vh` |
| `frontend/src/components/matterComp/EditMatterModal.tsx:525` | same | `2xl` | `90vh` |
| `frontend/src/components/taskComp/CreateTaskModal.tsx:219` | Task Details, People and Matter, Workflow | `xl` | `85vh` |
| `frontend/src/components/taskComp/EditTaskModal.tsx:188` | same | `xl` | `85vh` |
| `frontend/src/components/eventComp/EventFormWizard.tsx:75` | Event Details, People and Matter, Location and Options | `xl` | `85vh` |

None set a minimum height. In the matter wizard, step 1 with no client added is a
short card, step 2 holds about eight fields, and step 3 holds one member picker. The
dialog grew on Continue from step 1 to 2 and shrank from 2 to 3. Because the panel
is vertically centered, the top and bottom edges both moved, so the step indicator and
the footer buttons moved too. Step 1 also resized mid-step when the conflict-check
banner appeared after a client was added.

All five now take `height="steps"`, a fixed `min(720px, 90vh)`. The body scrolls when
a step needs more room. Widths still differ (`2xl` for the matter pair, `xl` for the
other three), which is deliberate: the matter steps hold wider content.

**The footer.** The `Modal` footer used to force `justify-end`, so every wizard
bypassed it to get Back on the left. It now takes `footerAlign`, and all five pass
`between` and their two slots directly. Cancel and Back both carry `min-w-[88px]`, so
the left slot no longer changes width when the label changes.

**Mobile.** Fixed. Below `sm` the panel is a full-width bottom sheet, capped at
`85svh`, with a square bottom edge on both the panel and the footer bar. The
hand-rolled overlays listed below do not get this, since they never used `Modal`.

**Hand-rolled overlays.** About 18 remain. Most are listed as deliberate stacking
exceptions in the frontend skill's `known-drift.md`, because `Modal` hardcodes
`z-50`. Two sit inside `ui/` itself: `ConfirmModal.tsx` and `NameInputModal.tsx`.
Three of the hand-rolled ones have no `max-h` at all and can exceed the viewport:
`RecordPaymentModal.tsx`, `ConvertLeadModal.tsx` and the dialog in
`MatterEventsTab.tsx`.

### What the frontend skill already says

The `paralegix-frontend` skill prescribes a `max-h-[85vh]` card base, a default of
`max-w-md`, `max-w-lg` for a two-column form and `max-w-2xl` or wider for editors.
It does not state what determines height, whether height should be stable across
steps, or when to use `xl`, `3xl`, `4xl` or `5xl`. `FormStepIndicator` is not
mentioned anywhere in the skill. There is no documented wizard shape, no footer rule
for a Back and Continue pair, and no mobile rule. So the wizard drift is not a
violation of a rule. There is no rule.

### Recommendation: centralize sizing in `Modal`

All seven items below are now done. They are kept for the reasoning, not as work.

1. **Collapse the width enum.** Not done, and deliberately so: the eight steps were
   left alone and a ninth, `screen` (80vw), was added for viewers. Collapsing them
   would move every dialog's width, which is a visual change with no defect behind it.
2. ~~Add a `height` prop~~. Done: `auto`, `fill`, `steps`, `none`.
3. ~~Add a `footerAlign` prop~~. Done, and the five wizards stopped copying the
   footer markup.
4. ~~Remove the `className` escape hatch~~. Done. The panel strips width and height
   utilities, and `check:modal-sizing` fails the build rather than leaving it silent.
5. ~~Raise the default cap~~. Done, to `90vh` rather than `90dvh`: `dvh` changes as
   the browser chrome hides, which resizes a dialog while the reader is in it.
6. ~~Add a mobile rule~~. Done: below `sm` the panel is a full-width bottom sheet
   with a square bottom edge, capped at `85svh`.
7. ~~Document the wizard shape in the skill~~. Done, in `primitives.md`.

### When not to use a modal at all

The strongest external guidance is not about sizing. It is about surface:

- NN/g: a multi-step modal prolongs time away from the main task. Use modals to
  prevent loss or errors, not to hold a workflow.
- Atlassian: do not use a modal for complex interactions, large tables, or multiple
  steps that require navigation within the dialog.
- USWDS: a multi-step process is better suited to an individual page.
- Carbon: for complex flows with complex choices, use a full page.
- Smashing Magazine (2026 decision tree): avoid modals for lengthy multi-step tasks;
  prefer pages for wizards and non-blocking drawers for repeated tasks.

The competitor survey matches. Clio creates a matter on a long page with a section
index on the left. PracticePanther, CosmoLex and Smokeball web use a page. Only MyCase
and Smokeball desktop use a multi-step dialog. Task and time entry are modals
everywhere they are documented, because they are short.

For Paralegix that suggests: keep task, event and time-entry creation in modals, but
move matter creation to a route. A page has no height problem, works at 200% zoom,
supports the browser back button, and can autosave a draft. If a modal stays, the
fixed-height treatment above is the minimum.

## Buttons

### External guidance

| Rule | Value | Source |
| --- | --- | --- |
| Minimum target size (WCAG 2.5.8, AA) | 24 by 24 CSS px | W3C |
| Enhanced target size (WCAG 2.5.5, AAA) | 44 by 44 CSS px, recommended for primary controls | W3C |
| Icon comprehension, labelled versus unlabelled | 88% versus 60% (34% for unique unlabelled icons) | NN/g |
| Focus indicator (WCAG 2.4.13) | 2px perimeter, 3:1 against the unfocused state | W3C |
| Hover feedback latency | Within 100ms | NN/g |

Beyond the numbers: label buttons with a verb and a noun (Save matter, Delete task).
Keep the primary action in the same corner on every dialog. Keep destructive and
confirming actions apart, with redundant visual differences. Do not disable a button
silently; keep it focusable and say why it is unavailable. Do not hide any control
behind hover.

### Paralegix today

`frontend/src/components/ui/Button.tsx` has four variants and three sizes. It had
five: `outline` rendered a class string byte-identical to `secondary` and has been
merged into it. Sizes are padding and font size only, with no minimum height:

| Size | Classes | Computed height |
| --- | --- | --- |
| `small` | `px-3 py-1.5 text-xs` | about 30px |
| `medium` | `px-4 py-2 text-sm` | about 38px |
| `large` | `px-6 py-3 text-base` | about 50px |

Only `large` clears 44px. `min-h-[44px]` and `min-h-11` appear zero times in `src`.

Disabled is `opacity-50 cursor-not-allowed`. On the filled primary variant that yields
a half-transparent accent with white text, well below any contrast minimum, and it
gives no reason for the disabled state.

**Focus rings are dead code.** `Button` sets `focus-visible:ring-2` per variant, and
the skill prescribes it, but
`frontend/src/styles/global.css:49` applies
`outline: none !important; box-shadow: none !important` to every focused element
except `.skip-link`. Tailwind rings are box shadows, so no keyboard focus indicator
renders anywhere in the app. This fails WCAG 2.4.7 (Level AA) and undercuts the
keyboard path that older users with reduced dexterity rely on.

**Drift.** 1,065 raw `<button>` elements exist outside `ui/`. The compact header
call-to-action string `px-3.5 py-2 bg-accent-solid ... rounded-xl` is copied 44 times
across 38 files. Sampled hand-rolled buttons use four paddings (`p-1`, `px-2 py-1`,
`px-3 py-1.5`, `px-3.5 py-2`), four radii (`rounded`, `rounded-md`, `rounded-lg`,
`rounded-xl`) and heights from 24px to 38px. Icon-only buttons at `p-1` are about
24px square, the WCAG floor, with no spacing guarantee.

### Recommendation

1. Delete the global focus suppression. Keep `focus-visible:` on components so the
   ring appears for keyboard use only, which is what the code already intends.
2. Add `min-h-11` (44px) to `medium`, `min-h-8` (32px) to `small`, and
   `min-h-12` to `large`. Add `min-w-11` to icon-only buttons.
3. Add an `iconOnly` mode to `Button` that requires `aria-label` and renders a
   `Tooltip`, then migrate the `p-1` icon buttons to it.
4. Replace `opacity-50` on disabled with a token pair (`bg-surface-alt` and
   `text-on-surface-muted`) that keeps the label readable, and pass a `disabledReason`
   through `Tooltip`.
5. Done. `outline` is gone.
6. Add a `compact` header variant to `Button` for the 44 copied strings, then treat
   a raw `<button>` with `bg-accent-solid` as a lint failure.

## Color and contrast

### External guidance

| Rule | Value | Source |
| --- | --- | --- |
| Text contrast (WCAG 1.4.3, AA) | 4.5:1 normal, 3:1 large (24px, or 18.67px bold) | W3C |
| Text contrast (WCAG 1.4.6, AAA) | 7:1 normal, 4.5:1 large | W3C |
| Non-text contrast (WCAG 1.4.11, AA) | 3:1 for borders, icons and focus indicators | W3C |
| Use of color (WCAG 1.4.1, A) | Never the only carrier of meaning | W3C |
| Hues older eyes confuse | Blue and purple, green and yellow, blue and green, dark blue and black | 2014 study, 40% of adults over 60 |

Lens yellowing and smaller pupils reduce both light and contrast sensitivity after
50. The practical rule is to separate states by luminance, not by hue, and to pair
every color with a label, icon or shape.

### Paralegix today

Tokens live in `frontend/src/styles/global.css`. Raw greys are gone
(two occurrences of `text-gray-400` and `text-slate-400` in the whole app), which is
a real achievement. Status badges (`StatusBadge`, `MatterStatusBadge`,
`TaskPriorityBadge`) always render a text label with the color dot, so color is never
the sole carrier there.

The muted token fails in light mode. `--on-surface-muted` is `#6B7488`, used at
1,745 sites for helper text, timestamps and placeholders:

| Background | Token | Old `#6B7488` | New `#5C6479` |
| --- | --- | --- | --- |
| `--surface` | `#F8F9FC` | 4.45:1, fails | 5.61:1, passes |
| `--surface-alt` | `#EEF1F7` | 4.14:1, fails | 5.22:1, passes |
| `--surface-hover` | `#E3E8F2` | 3.82:1, fails | 4.81:1, passes |
| `--page` | `#E4E7EF` | 3.79:1, fails | 4.78:1, passes |

Dark mode (`#858EA2` on `#131822`) is 5.38:1 and passes. `--on-surface-secondary`
(`#4E5667`) is 7.0:1 on surface and passes. The failure compounds because muted text
is the color most often paired with `text-xs`, `text-[11px]` and `text-[10px]`.

The status palette uses `blue-600`, `emerald-600`, `amber-600` and `red-700`. Blue
and purple are not both in use, which avoids the most common confusion. Emerald
against amber is a luminance difference as well as a hue difference, which is the
right way to separate them.

### Recommendation

1. Done. `--on-surface-muted` is `#5C6479`.
2. Done. `tests/styles/tokenContrast.test.ts` checks every `--on-surface*` token
   against every surface token, in both themes, at 4.5:1.
3. Done. `--input-border` covers fields and triggers; a new `--control-border`
   covers the secondary button's edge. `--outline` keeps its lighter value for
   card edges, dividers and modal borders, which are decoration and exempt.
4. Keep the status palette as is, but document the rule: separate by luminance and
   always show the label.

## Text size

### External guidance

| Rule | Value | Source |
| --- | --- | --- |
| Body text floor | 16px; 18 to 19px preferred for older readers | Health Literacy Online, NN/g |
| Line height | 1.5 | WCAG 1.4.12 reference |
| Line length | 50 to 75 characters, 80 maximum | Baymard, WCAG 1.4.8 |
| Weight | Medium or regular; avoid 100 to 300 | Multiple |
| Resize (WCAG 1.4.4, AA) | 200% zoom without loss | W3C |
| Reflow (WCAG 1.4.10, AA) | No two-dimensional scroll at 320px, except data tables | W3C |

A 2022 systematic review found reading speed drops sharply below a critical print
size, and older adults preferred larger sizes up to a point. Higher contrast and more
line spacing improved performance.

### Paralegix today

The base font size is the browser default of 16px, and inputs are forced to 16px on
coarse pointers. But the working scale sits below that:

| Class | Size | Occurrences in `src` |
| --- | --- | --- |
| `text-sm` | 14px | 1,694 |
| `text-xs` | 12px | 1,585 |
| `text-[11px]` | 11px | 256 |
| `text-[10px]` | 10px | 225 |
| `text-[9px]` | 9px | 16 |
| `text-base` | 16px | 90 |

About 500 sites use an arbitrary size below 12px, and the skill's type scale never
mentions them. Badge text is 12px inside a 20px pill. Wizard step labels are 14px,
and the step number circles use `text-xs` at 28px diameter.

### Recommendation

1. Retire `text-[9px]`, `text-[10px]` and `text-[11px]`. Map them to `text-xs`.
   Add a guard that fails on a bracketed font size.
2. Make `text-sm` the floor for body copy and `text-xs` the floor for badges and
   metadata. Do not go below.
3. Set `line-height: 1.5` on body text (Tailwind's `text-sm` uses 1.43).
4. Add an in-app text size setting (`Default`, `Large`) that sets `html` font size to
   16px or 18px. Every size in the app is in `rem`, so this is one CSS variable. This
   is the one place where the zoom topic belongs: browser zoom is mandatory and must
   work to 200%, and the setting is a convenience on top.

## Forms and errors

### External guidance

NN/g's form guidelines produced 78% one-try submissions versus 42% without them.

- Single column, label above the field, always visible. Placeholder-only labels hurt
  older users most.
- Validate when the user leaves the field, not on every keystroke. Put the message
  next to the field in text, with an icon or outline as well as color.
- Never clear the user's input on error. No Reset buttons.
- Accept multiple formats for phone numbers, dates and times.
- Mark optional fields rather than required ones, and keep optional fields few.
- Do not ask for the same information twice in one process (WCAG 3.3.7).
- For legal or financial submissions, make the action reversible, checked, or
  confirmable (WCAG 3.3.4).
- Prefer undo to confirmation. When undo is impossible, name the action in the
  confirmation and the button.

### Paralegix today

Labels are visible (`FieldLabel`) and inline errors exist (`FieldError`). Two things
are worth a look:

- The matter wizard validates on Continue and shows the error in a banner above the
  form (`ErrorNotification`), not next to the field. On step 2 the banner pushes the
  fields down, which is the same layout shift as the height problem.
- The `Continue` button in the matter wizard is disabled until the title is filled.
  With the disabled style at 50% opacity and no explanation, an older user reads a
  broken button.

## Motion and layout stability

The app respects `prefers-reduced-motion` for every overlay and list animation, and
`motion-reduce:active:scale-100` appears 549 times. This is in good shape. Two small
items:

- `transitionClasses.ts` says the enter and exit take 200ms, and `useMountTransition`
  holds the panel for 200ms, but the keyframes run 120ms in and 100ms out. Align the
  comment and the hook to the CSS so the exit does not sit still for 100ms.
- Google's layout shift threshold is 0.1. Reserve space for async content (banners,
  avatars, loaded lists) so nothing under the cursor moves after load.

## What competitors do

| Product | New matter | Multi-step | Quick add | Accessibility claim | Text size setting |
| --- | --- | --- | --- | --- | --- |
| Clio Manage | Full page, section index on the left | No | Modal (task, time) | WCAG 2.0 AA target | None; docs say use browser zoom |
| MyCase | Modal | Yes, four steps with "Continue to ..." buttons | Window from dashboard | None found | None |
| PracticePanther | Page | No | Menu from a "New" button | None found | None |
| Smokeball | Desktop: dialog wizard; web: page | Desktop yes | Not documented | None; keyboard-only use unsupported per community | None |
| CosmoLex | Full screen, then settings tabs | Two phases | Screen with Save and New | None found | None |
| Lawmatics | Small dialog | No | Modal | None found | None |
| Filevine | Short form | No | Inline in activity feed | None found | Theme only |
| Actionstep | Dialog | No | Window from a global Create | WCAG 2.1 AA target, React Aria | None |

Help centers do not publish widths, button order or colors, so those could not be
verified. Delete confirmations are plain "Are you sure" prompts, and most vendors
add a recovery bin (Clio six months, PracticePanther 30 days) rather than a harder
warning. Clio adds a mandatory checkbox before "Delete matter". No competitor offers
a font size or density setting, which is a gap Paralegix can fill cheaply.

## Prioritized action list

Ordered by user impact per hour of work.

1. ~~Delete the global focus suppression~~. Done, and replaced with one outline
   rather than simply removed, so the browser default never draws.
2. ~~Darken `--on-surface-muted`~~. Done.
3. ~~Fix the five wizards~~. Done. Widths still differ by content (`2xl` for the
   matter pair, `xl` for the other three); only the height is shared.
4. ~~Add `height` and `footerAlign` to `Modal` and close the `className` escape
   hatch~~. Done.
5. **Add minimum heights to `Button`** and an `iconOnly` mode with a required label.
6. **Retire sub-12px text** and add a guard.
7. ~~Add a mobile treatment to `Modal`~~. Done, using `svh` rather than `dvh`:
   `dvh` changes as the browser chrome hides, which resizes the sheet mid-scroll.
8. **Add a text size setting** in Appearance, next to the theme selector.
9. **Document the wizard shape and the sizing rules** in the frontend skill so the
   next dialog copies the fixed version.
10. **Evaluate moving matter creation to a page**, following Clio. This is a product
    decision, not a fix.

## Sources

Design systems and dialog sizing:

- [Atlassian Design, Modal dialog usage](https://atlassian.design/components/modal-dialog/usage)
- [Shopify Polaris, Modal web component](https://shopify.dev/docs/api/app-home/polaris-web-components/overlays/modal)
- [IBM Carbon, Modal style](https://carbondesignsystem.com/components/modal/style/) and [usage](https://carbondesignsystem.com/components/modal/usage/)
- [Material Design 3, Dialog specs](https://m3.material.io/components/dialogs/specs) and [guidelines](https://m3.material.io/components/dialogs/guidelines)
- [GitLab Pajamas, Modal](https://design.gitlab.com/components/modal)
- [USWDS, Modal](https://designsystem.digital.gov/components/modal/)
- [Bootstrap 5, Modal](https://getbootstrap.com/docs/5.3/components/modal/)
- [Chakra UI, Dialog](https://chakra-ui.com/docs/components/dialog)
- [shadcn/ui, Dialog](https://ui.shadcn.com/docs/components/dialog)
- [Ant Design, Modal](https://ant.design/components/modal)
- [PatternFly, Wizard design guidelines](https://www.patternfly.org/components/wizard/design-guidelines/)
- [Appian, Wizard layout](http://docs.appian.com/suite/help/26.8/sail/ux-wizard-layout.html)
- [NN/g, Modal and Nonmodal Dialogs](https://www.nngroup.com/articles/modal-nonmodal-dialog/)
- [NN/g, Wizards](https://www.nngroup.com/articles/wizards/)
- [Smashing Magazine, Modal versus separate page decision tree](https://www.smashingmagazine.com/2026/03/modal-separate-page-ux-decision-tree/)

Older adults and accessibility:

- [NN/g, Usability for Older Adults: Challenges and Changes (2019)](https://www.nngroup.com/articles/usability-for-senior-citizens/)
- [NN/g, Usability for Senior Citizens: Improved, But Still Lacking (2013)](https://www.nngroup.com/articles/usability-seniors-improvements/)
- [W3C, WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- [W3C, Understanding Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
- [W3C, Understanding Text Spacing](https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html)
- [W3C, Understanding Focus Appearance](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html)
- [W3C, Understanding Focus Not Obscured (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html)
- [W3C, Technique C39 prefers-reduced-motion](https://www.w3.org/WAI/WCAG22/Techniques/css/C39.html)
- [PMC, Font size for older adults: systematic review (2022)](https://pmc.ncbi.nlm.nih.gov/articles/PMC9376262/)
- [Health Literacy Online, Use a font of at least 16 pixels](https://odphp.health.gov/healthliteracyonline/design-easy-scanning/use-readable-font-thats-least-16-pixels)
- [Baymard, The optimal line length](https://baymard.com/blog/line-length-readability)
- [Medical News Today, Color vision abnormalities in 40 percent of older adults](https://www.medicalnewstoday.com/releases/273021)
- [NN/g, Icon Usability](https://www.nngroup.com/articles/icon-usability/)
- [NN/g, Button States](https://www.nngroup.com/articles/button-states-communicate-interaction/)
- [NN/g, Why Disabled Buttons Hurt UX](https://www.nngroup.com/videos/why-disabled-buttons-hurt-ux-and-how-to-fix-them/)
- [NN/g, Timing Guidelines for Exposing Hidden Content](https://www.nngroup.com/articles/timing-exposing-content/)
- [web.dev, Cumulative Layout Shift](https://web.dev/articles/cls)
- [NN/g, Website Forms Usability: Top 10 Recommendations](https://www.nngroup.com/articles/web-form-design/)
- [NN/g, 10 Design Guidelines for Reporting Errors in Forms](https://www.nngroup.com/articles/errors-forms-design-guidelines/)
- [NN/g, Placeholders in Form Fields Are Harmful](https://www.nngroup.com/articles/form-design-placeholders/)
- [NN/g, Confirmation Dialogs Can Prevent User Errors](https://www.nngroup.com/articles/confirmation-dialog/)
- [NN/g, Dangerous UX: Consequential Options Close to Benign Options](https://www.nngroup.com/articles/proximity-consequential-options/)

The legal profession and competitors:

- [Lawyers Mutual NC, ABA Profile of the Legal Profession 2024](https://www.lawyersmutualnc.com/blog/aba-releases-its-profile-of-the-legal-profession-2024)
- [ABA, 2024 Legal Technology Survey Report](https://www.americanbar.org/groups/law_practice/resources/legal-technology-resource-center/tech-survey/)
- [Clio, 2025 Legal Trends Report](https://www.clio.com/about/press/the-science-behind-smarter-law-clios-2025-legal-trends-report-reveals-how-technology-is-rewiring-the-way-lawyers-work/)
- [Clio, Create Matters](https://help.clio.com/hc/en-us/articles/9285959663131-Create-Matters)
- [Clio, Delete and Recover Matters](https://help.clio.com/hc/en-us/articles/9286033184155-Delete-and-Recover-Matters)
- [Clio, Increase the display size and font](https://support.clio.com/hc/en-us/articles/115001966074-How-to-Increase-the-display-size-and-font-of-Clio-webpage)
- [Clio, Accessibility](https://www.clio.com/accessibility/)
- [MyCase, Adding a new case](https://supportcenter.mycase.com/en/articles/9369888-adding-a-new-case)
- [PracticePanther, Matters tutorial](https://support.practicepanther.com/en/articles/593472-matters-tutorial)
- [Smokeball, Create a New Matter](https://support.smokeball.com/hc/en-us/articles/6012964222359-Create-a-New-Matter)
- [Smokeball community, Mouseless work](https://community.smokeball.com/general-q-a-7/mouseless-work-3087)
- [CosmoLex, Manage matters](https://support.cosmolex.com/knowledge-base/manage-matters/)
- [Lawmatics, Creating matters](https://help.lawmatics.com/en/articles/10699812-creating-matters)
- [Filevine, Create a New Project](https://support.filevine.com/hc/en-us/articles/360007553912-Create-a-New-Project)
- [Actionstep, Creating a Matter](https://support.actionstep.com/hc/en-us/articles/50482474423443-Creating-a-Matter)
- [Actionstep, Accessibility](https://support.actionstep.com/hc/en-us/articles/51201926315539-Actionstep-Accessibility)
