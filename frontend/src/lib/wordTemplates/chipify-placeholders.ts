// Reconstitute `{placeholder}` merge fields as editable chips after a PDF/DOCX
// import.
//
// Why this exists: the positional PDF→HTML importer (convertPdfToHtml) emits
// ONE <span> per glyph for layout fidelity, so a `{client_name}` token in the
// source becomes 13 separate single-character spans. That breaks everything
// downstream:
//   - extractPlaceholders() matches `data-placeholder-chip="…"` attributes, not
//     raw text → it finds nothing → "0 placeholders detected".
//   - buildFilledTemplateHtml() replaces chips → with no chip, fill leaves the
//     literal `{client_name}` in the output.
//
// This util walks each text line, finds `{identifier}` / `{a.b}` tokens across
// the fragmented spans, and replaces the covered spans with a single chip span
//, identical markup to the editor's "Insert Field" (handleInsert), so the
// editor treats them as real chips and fill substitutes them.
//
// Scope: simple value placeholders only. Loop markers (`{#name}` / `{/name}`)
// are intentionally left as text, repeater reconstruction in an absolutely
// positioned layout is a separate concern. Browser-only (uses DOMParser); the
// editor calls it client-side after convertPdfToHtml.

// {name} or {dotted.name}, must start with a letter/underscore; excludes
// `{#…}`, `{/…}`, `{.}` (loop markers / current-item refs) by construction.
const TOKEN_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)*)\}/g

// Mirrors handleInsert() in TemplateEditor.tsx so imported chips are
// indistinguishable from hand-inserted ones (selection, ×-remove via
// delegation, fill).
function buildChip(doc: Document, name: string, styleSource: HTMLElement | null): HTMLElement {
  const chip = doc.createElement('span')
  chip.setAttribute('data-placeholder-chip', name)
  chip.setAttribute('contenteditable', 'false')
  chip.style.cssText =
    'display:inline-flex;align-items:center;gap:3px;text-decoration:underline dotted;text-underline-offset:3px;font-style:inherit;font-weight:inherit;color:inherit;vertical-align:baseline;'
  // Carry the source run's font so the chip blends into the line.
  if (styleSource) {
    if (styleSource.style.fontFamily) chip.style.fontFamily = styleSource.style.fontFamily
    if (styleSource.style.fontSize) chip.style.fontSize = styleSource.style.fontSize
  }

  const label = doc.createElement('span')
  label.textContent = `{${name}}`
  label.style.cssText = 'cursor:default;color:inherit;'

  const removeBtn = doc.createElement('span')
  removeBtn.setAttribute('data-chip-remove', 'true')
  removeBtn.textContent = '×'
  removeBtn.style.cssText =
    'cursor:pointer;font-size:0.9em;opacity:0.5;line-height:1;padding:0 1px;transition:opacity 0.15s;color:inherit;'

  chip.appendChild(label)
  chip.appendChild(removeBtn)
  return chip
}

// Ordered "leaf" inline units within a line: text nodes and elements with no
// element children (the per-glyph spans). Each leaf is independently
// removable/replaceable.
function collectLeaves(root: Element): Array<Text | Element> {
  const leaves: Array<Text | Element> = []
  const walk = (node: Node) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        if ((child.textContent ?? '').length > 0) leaves.push(child as Text)
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element
        // Never descend into an existing chip, leave it intact.
        if (el.hasAttribute('data-placeholder-chip')) return
        if (el.childElementCount === 0) leaves.push(el)
        else walk(el)
      }
    })
  }
  walk(root)
  return leaves
}

function chipifyLine(block: Element, doc: Document): void {
  const leaves = collectLeaves(block)
  if (leaves.length === 0) return

  // Concatenate leaf text and map each character back to its leaf.
  let text = ''
  const charToLeaf: number[] = []
  leaves.forEach((leaf, i) => {
    const t = leaf.textContent ?? ''
    for (let k = 0; k < t.length; k += 1) charToLeaf.push(i)
    text += t
  })
  if (!text.includes('{')) return

  const matches = [...text.matchAll(TOKEN_RE)]
  if (matches.length === 0) return

  // Apply right-to-left so earlier matches' leaf references stay valid.
  for (let mi = matches.length - 1; mi >= 0; mi -= 1) {
    const m = matches[mi]
    const start = m.index ?? 0
    const end = start + m[0].length // exclusive
    const name = m[1]

    const firstLeafIdx = charToLeaf[start]
    const lastLeafIdx = charToLeaf[end - 1]
    const firstLeaf = leaves[firstLeafIdx]
    const lastLeaf = leaves[lastLeafIdx]
    if (!firstLeaf || !lastLeaf) continue

    // Only chipify when the token aligns to whole leaves under one parent, 
    // the common single-glyph-span case. Anything else is left as text rather
    // than risk corrupting the markup.
    const parent = firstLeaf.parentNode
    if (!parent || lastLeaf.parentNode !== parent) continue
    const firstStartsHere =
      start === 0 || charToLeaf[start - 1] !== firstLeafIdx
    const lastEndsHere =
      end === text.length || charToLeaf[end] !== lastLeafIdx
    if (!firstStartsHere || !lastEndsHere) continue

    const styleSource =
      firstLeaf.nodeType === Node.ELEMENT_NODE ? (firstLeaf as HTMLElement) : null
    const chip = buildChip(doc, name, styleSource)
    parent.insertBefore(chip, firstLeaf)
    for (let li = firstLeafIdx; li <= lastLeafIdx; li += 1) {
      const node = leaves[li]
      node.parentNode?.removeChild(node)
    }
  }
}

/**
 * Wrap `{placeholder}` tokens in imported HTML as editable chips. Returns the
 * transformed HTML. No-op (returns input) outside the browser, when there's no
 * `{`, or on parse failure.
 */
export function chipifyPlaceholdersInHtml(html: string): string {
  if (typeof window === 'undefined' || typeof DOMParser === 'undefined') return html
  if (!html.includes('{')) return html

  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    // Each positioned line is a <p>; fall back to any block holding text.
    const blocks = doc.querySelectorAll<HTMLElement>('.pdf-page p, .pdf-page div, p')
    blocks.forEach((block) => {
      // Skip blocks that only contain other blocks (process leaf lines).
      if (block.querySelector('p')) return
      chipifyLine(block, doc)
    })
    return doc.body.innerHTML
  } catch {
    return html
  }
}
