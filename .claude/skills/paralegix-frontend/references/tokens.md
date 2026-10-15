# Colour tokens

Defined in `src/styles/global.css` — `:root` for light, `.dark` for dark. Tailwind's
`@theme inline` block maps each to a utility class. Dark mode is class-based (`.dark` on
`<html>`), managed by `PreferencesContext` (`usePreferences()`).

**Prefer tokens over hardcoded colours.** A `gray-`/`slate-`/`neutral-` scale, `bg-white`, or
`text-black` breaks dark mode — 29 files still contain them and they are drift, not precedent.

---

## App surface tokens

These are the vocabulary for everything under `/lawfirm/*`, `/client/*`, `/dashboard`, and
`/admin`.

| Class | Light | Dark | Use for |
|---|---|---|---|
| `bg-page` | `#E4E7EF` | `#0A0D13` | The page behind everything |
| `bg-surface` | `#F8F9FC` | `#131822` | Cards, panels, modal cards, rows |
| `bg-surface-alt` | `#EEF1F7` | `#181E2A` | Modal footers, toolbars, inset areas, count pills |
| `bg-surface-hover` | `#E3E8F2` | `#1E2534` | **The** hover background — 580 uses |
| `text-on-surface` | `#0D1016` | `#E4E7EF` | Primary text, headings, labels |
| `text-on-surface-secondary` | `#4E5667` | `#A9B1C2` | Body copy, descriptions |
| `text-on-surface-muted` | `#5C6479` | `#858EA2` | Helper text, timestamps, placeholders, muted icons |
| `border-outline` | `#B7C0D2` | `#2C3A52` | The stronger line — list containers, modal header rules |
| `border-outline-subtle` | `#D5DBE7` | `#202A3C` | The softer line — card borders, row separators |
| `bg-input-bg` | `#FFFFFF` | `#131822` | Form control background |
| `border-input-border` | `#747E92` | `#6B7583` | Form control border. Darker than `border-outline` on purpose: a field's edge is the only thing marking where it begins, so it owes 3:1 (WCAG 1.4.11), while a divider is decoration and does not. `--control-border` holds the same pair for the secondary button's edge |

## Messaging surface

| Class | Light | Dark |
|---|---|---|
| `bg-messages-area` | `#E4E7EF` | `#0A0D13` |
| `bg-message-bubble-received` | `#EEF1F7` | `#181E2A` |

Sent bubbles use the semantic app accent.

## Scrollbars

`--scrollbar-thumb` / `--scrollbar-thumb-hover` / `--scrollbar-track` drive the
`.styled-scrollbar` and `.scrollbar-hide` utilities in `global.css`. Apply `styled-scrollbar` to
any modal body or panel that scrolls (90 files do).

---

## App accent tokens

Brand/action colour is semantic so a palette change does not require a feature-file sweep.
It follows the Cobalt Ink palette: saturated cobalt actions in both modes, cool light surfaces,
and deep blue-black dark surfaces.

| Purpose | Class |
|---|---|
| Primary action | `bg-accent-solid text-accent-foreground hover:bg-accent-solid-hover` |
| Active text/link | `text-accent-emphasis hover:text-accent-emphasis-hover` |
| Selected navigation wash | `bg-accent-soft` |
| Focus ring | Nothing to add. `global.css` draws a 2px `--focus-ring` outline on `:focus-visible` for every element except a non-control `tabindex="-1"` focus target (a `<main>` or an error summary), and suppresses ring box-shadows. The one exception is a fused cluster (`fused-field-group`), see `primitives.md` |
| Control edge | `border-control-border` for a control (secondary button); `border-input-border` for a field or trigger; `border-outline` / `border-outline-subtle` for decoration. The first two clear 3:1 and are checked by `tests/styles/tokenContrast.test.ts` |
| Danger | `red-600` text/border; `hover:bg-red-50` / `dark:hover:bg-red-950/20` |
| Success | `green-600` / `emerald-600` |

**Raw action-oriented `blue-*`, `indigo-*`, and `violet-*` classes are drift.** Status, user-selected
palette, editor, chart, and integration colours remain literal or come from their domain
vocabulary; do not convert those to the app accent merely because they are blue or indigo.

Everything else with semantic meaning — status, priority, type, category — comes from
`STATUS_VARIANTS` in `@/constants/statusMeta`, never a literal and never a local map. A variant
carries `dot`, `text`, `tint`, `edge`, and `hex` (for recharts and other libraries that can't
take a class).

---

## Marketing tokens — a separate language

Used **only** by `/`, `/pricing`, `/features`, `/workflow`, `/login`, `/register` and
`components/marketingComp/`. Warm paper-and-ink, serif headings, deep soft shadows — nothing
like the app.

| Class | Value |
|---|---|
| `bg-mkt-paper` | `#f7f4ed` |
| `bg-mkt-card` | `#ffffff` |
| `text-mkt-ink` | `#16222f` |
| `border-mkt-line` | `rgb(22 34 47 / 0.10)` |
| `text-mkt-accent` | `oklch(0.60 0.085 72)` |
| `text-mkt-accent-deep` | `oklch(0.50 0.085 70)` |
| `bg-mkt-accent-soft` | `oklch(0.93 0.03 78)` |
| `text-mkt-ok` / `text-mkt-warn` | `oklch(0.60 0.10 155)` / `oklch(0.66 0.13 55)` |
| `font-mkt-serif` | Newsreader → Georgia |
| `font-mkt-sans` | Plus Jakarta → system-ui |
| `shadow-mkt-sm` / `-md` / `-lg` | soft, long, ink-tinted |

**The boundary is strict in both directions.** Never use `bg-surface`/`text-on-surface` on a
marketing page, and never pull `mkt-*` into the app. Marketing has no dark mode.

---

## Dead tokens

None. `--ag-row-border-width` and every other AG Grid / Ant Design leftover has been removed from
`global.css`; every token in the file is live.
