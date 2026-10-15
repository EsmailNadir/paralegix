// HTML-template placeholder + repeater extraction and filling.
//
// Paralegix paradigm: HTML templates store placeholders + repeaters as
// DOM nodes with `data-*` attributes (NOT raw `{{name}}` strings). This
// lets the Tiptap editor render them as styled chips instead of literal
// text, and survives copy/paste + cursor placement naturally.
//
// Markup:
//   <span data-placeholder-chip="client_name">{client_name}</span>
//   <p data-repeater="line_items"> ... </p>
//
// Within a repeater paragraph, chips may use the full "loop.field"
// notation or the bare field name; both resolve correctly at fill time.

// Depth-aware extractor, pure server-side. A repeater is marked by
// `data-repeater="name"` on a `<p>` (what the positional editor emits) or
// a `<div>`; chips are `<span data-placeholder-chip>`. A `<p>` cannot nest,
// so its block ends at its own `</p>`. For a `<div>` we track open/close
// nesting so the block extends from its opening tag to the MATCHING
// closing `</div>` (not the first one the regex hits).

const PLACEHOLDER_RE = /data-placeholder-chip=["']([^"']+)["']/g
const REPEATER_TAG_RE =
  /<(div|p)\b([^>]*)\bdata-repeater=["']([^"']+)["']([^>]*)>/g
const DIV_TAG_RE = /<(\/?)div\b[^>]*>/g

export type Repeater = { name: string; fields: string[] }

type RepeaterBlock = { name: string; start: number; end: number; inner: string }

function findRepeaterBlocks(html: string): RepeaterBlock[] {
  const out: RepeaterBlock[] = []
  for (const m of html.matchAll(REPEATER_TAG_RE)) {
    const openTagStart = m.index ?? 0
    const openTagEnd = openTagStart + m[0].length
    const name = m[3]
    if (!name) continue

    if (m[1] === 'p') {
      const closeTagStart = html.indexOf('</p>', openTagEnd)
      if (closeTagStart < 0) continue // malformed: skip silently
      out.push({
        name,
        start: openTagStart,
        end: closeTagStart + '</p>'.length,
        inner: html.slice(openTagEnd, closeTagStart),
      })
      continue
    }

    // Walk forward through every <div> / </div> from openTagEnd,
    // incrementing on open and decrementing on close. When depth
    // reaches zero, we've hit our matching close.
    DIV_TAG_RE.lastIndex = openTagEnd
    let depth = 1
    let closeTagEnd = -1
    let closeTagStart = -1
    let nextTag: RegExpExecArray | null
    while ((nextTag = DIV_TAG_RE.exec(html)) !== null) {
      if (nextTag[1] === '/') {
        depth -= 1
        if (depth === 0) {
          closeTagStart = nextTag.index
          closeTagEnd = nextTag.index + nextTag[0].length
          break
        }
      } else {
        depth += 1
      }
    }
    if (closeTagEnd < 0) continue // malformed: skip silently

    out.push({
      name,
      start: openTagStart,
      end: closeTagEnd,
      inner: html.slice(openTagEnd, closeTagStart),
    })
  }
  return out
}

export function extractPlaceholders(html: string): string[] {
  const blocks = findRepeaterBlocks(html)
  let masked = html
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const b = blocks[i]
    masked = masked.slice(0, b.start) + masked.slice(b.end)
  }
  const out = new Set<string>()
  for (const m of masked.matchAll(PLACEHOLDER_RE)) {
    const name = m[1]
    if (name) out.add(name)
  }
  return [...out].sort()
}

export function extractRepeaters(html: string): Repeater[] {
  const blocks = findRepeaterBlocks(html)
  if (blocks.length === 0) return []

  const byName = new Map<string, Set<string>>()
  for (const b of blocks) {
    let set = byName.get(b.name)
    if (!set) {
      set = new Set<string>()
      byName.set(b.name, set)
    }
    for (const m of b.inner.matchAll(PLACEHOLDER_RE)) {
      const full = m[1]
      if (!full) continue
      const sub = full.startsWith(b.name + '.')
        ? full.slice(b.name.length + 1)
        : full
      set.add(sub)
    }
  }
  return [...byName.entries()].map(([name, set]) => ({
    name,
    fields: [...set].sort(),
  }))
}

export function buildFlatFieldList({
  fields,
  repeaters,
}: {
  fields: string[]
  repeaters: Repeater[]
}): string[] {
  const out = [...fields]
  for (const r of repeaters) {
    for (const f of r.fields) out.push(`${r.name}.${f}`)
  }
  return out
}

