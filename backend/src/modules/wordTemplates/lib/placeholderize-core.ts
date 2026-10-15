// Pure OOXML surgery for the template placeholder-izer (document automation).
//
// Word splits literal text across consecutive <w:r> runs unpredictably
// (spell-check state, edit history), so a naive string replace misses
// literals that span runs. The engine works paragraph-by-paragraph:
//
//   1. If a literal sits intact inside one <w:t>, replace it in place:
//      formatting untouched.
//   2. Otherwise, if the PARAGRAPH's concatenated text contains the literal,
//      collapse the paragraph's text into its first run and replace there.
//      Intra-paragraph run formatting is lost for that paragraph only: the
//      self-verify in the CLI catches anything that still doesn't match.
//
// Loops (`{#payments}` blocks) are paragraph surgery: the paragraph matching
// the first sample row becomes three paragraphs: `{#name}`, the row
// template, `{/name}`: cloned from the original so styling survives, and
// the remaining sample-row paragraphs are deleted.
//
// No DOM library: paragraphs/runs/texts are well-formed, non-nested spans in
// document.xml, so bounded regexes are reliable here and keep the script
// dependency-free (matches the repo's pizzip-only toolchain).

export type ReplaceOp = { find: string; tag: string }
export type LoopOp = {
  loop: {
    name: string
    // Paragraph whose text contains this literal becomes the repeating row.
    firstRowMatch: string
    // Row text with per-iteration tags, e.g. '{payment_date}- {payment_amount} payment'.
    rowTemplate: string
    // Paragraphs matching any of these literals are removed (sample rows 2..n).
    deleteRowMatches: string[]
  }
}
export type TagOp = ReplaceOp | LoopOp

export function isLoopOp(op: TagOp): op is LoopOp {
  return 'loop' in op
}

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

const PARAGRAPH_RE = /<w:p\b[^>]*(?:\/>|>[\s\S]*?<\/w:p>)/g
// The negative lookahead skips a self-closing empty run `<w:t/>` (Word emits
// these around inline images/spacing). Without it, `<w:t/>` matches as an
// opening tag and the non-greedy body runs to the NEXT real `</w:t>`, swallowing
// every run + drawing in between as "text": corrupting extraction for any
// paragraph that contains an image.
const TEXT_RE = /(<w:t\b(?![^>]*\/>)[^>]*>)([\s\S]*?)(<\/w:t>)/g

// Concatenated visible text of one paragraph's XML (entities decoded).
export function paragraphText(paragraphXml: string): string {
  let out = ''
  for (const m of paragraphXml.matchAll(TEXT_RE)) out += xmlUnescape(m[2])
  return out
}

// Extract the full document text (paragraph per line): used by self-verify.
export function documentText(documentXml: string): string {
  const paras = documentXml.match(PARAGRAPH_RE) ?? []
  return paras.map(paragraphText).join('\n')
}

export type ParagraphSpan = { start: number; end: number; xml: string }

// Paragraphs with their absolute offsets. Exported (rather than re-deriving
// PARAGRAPH_RE elsewhere) so callers that need to locate something BY OFFSET:
// e.g. which paragraph a Word form field sits in: share this module's
// paragraph definition, including the <w:t/> lookahead rationale above.
export function paragraphSpans(documentXml: string): ParagraphSpan[] {
  const out: ParagraphSpan[] = []
  for (const m of documentXml.matchAll(PARAGRAPH_RE)) {
    out.push({ start: m.index, end: m.index + m[0].length, xml: m[0] })
  }
  return out
}

// Collapse a paragraph's text into its FIRST <w:t> (set to `newText`), empty
// out the others. Preserves the first run's formatting for the whole line.
function setParagraphText(paragraphXml: string, newText: string): string {
  let first = true
  return paragraphXml.replace(TEXT_RE, (_m, open: string, _text: string, close: string) => {
    if (first) {
      first = false
      // xml:space="preserve" keeps leading/trailing spaces in the merged text.
      const openPreserve = open.includes('xml:space')
        ? open
        : open.replace('<w:t', '<w:t xml:space="preserve"')
      return `${openPreserve}${xmlEscape(newText)}${close}`
    }
    return `${open}${close}`
  })
}

// Replace every occurrence of `find` with `tag` inside ONE paragraph while
// keeping each run's non-text content: inline drawings/icons, breaks, tabs, run
// properties: exactly where it was. Only the <w:t> nodes the literal actually
// spans are rewritten: the first covered node receives the tag, the remaining
// covered nodes are cleared, and everything outside the literal's character span
// (text, drawings, formatting, and any drawing that sits between covered nodes)
// is left verbatim. This is the run-spanning replacement path; unlike a
// whole-paragraph collapse it never reorders text ahead of an inline icon, so
// letterheads and any paragraph that interleaves text with images survive.
function replaceAcrossRuns(
  para: string,
  find: string,
  tag: string,
  wholeToken: boolean,
): { xml: string; hits: number } {
  // 1) Index the paragraph's <w:t> nodes and their offsets in the concatenated text.
  const nodes: Array<{ text: string; start: number; end: number }> = []
  let full = ''
  for (const m of para.matchAll(TEXT_RE)) {
    const text = xmlUnescape(m[2])
    nodes.push({ text, start: full.length, end: full.length + text.length })
    full += text
  }
  if (nodes.length === 0) return { xml: para, hits: 0 }

  // 2) Locate occurrences in the concatenated text (wholeToken → standalone only).
  const occ: Array<[number, number]> = []
  for (let i = 0; ; ) {
    const idx = full.indexOf(find, i)
    if (idx === -1) break
    const end = idx + find.length
    if (!wholeToken || isStandaloneOccurrence(full, idx, end)) {
      occ.push([idx, end])
      i = end
    } else {
      i = idx + 1
    }
  }
  if (occ.length === 0) return { xml: para, hits: 0 }

  // 3) Turn each occurrence into per-node text edits (node-local coordinates).
  const edits: Array<Array<{ s: number; e: number; ins: string }>> = nodes.map(() => [])
  const firstNode = (off: number) => nodes.findIndex((n) => n.start <= off && off < n.end)
  const lastNode = (off: number) => {
    for (let k = nodes.length - 1; k >= 0; k--) if (nodes[k].start < off && off <= nodes[k].end) return k
    return -1
  }
  let applied = 0
  for (const [oS, oE] of occ) {
    const fi = firstNode(oS)
    const li = lastNode(oE)
    // fi/li are always valid for an occurrence found in `full` (the <w:t> nodes
    // partition the whole concatenated text). Guard defensively, but count a hit
    // only when an edit actually lands: never claim a replacement that didn't
    // happen (fail loud: a miss must surface as hits=0, not a phantom success).
    if (fi === -1 || li === -1) continue
    if (fi === li) {
      edits[fi].push({ s: oS - nodes[fi].start, e: oE - nodes[fi].start, ins: tag })
    } else {
      edits[fi].push({ s: oS - nodes[fi].start, e: nodes[fi].text.length, ins: tag })
      for (let m = fi + 1; m < li; m++) edits[m].push({ s: 0, e: nodes[m].text.length, ins: '' })
      edits[li].push({ s: 0, e: oE - nodes[li].start, ins: '' })
    }
    applied += 1
  }

  // 4) Apply edits (right-to-left within each node) to compute new node text.
  const newText = nodes.map((n, k) => {
    let t = n.text
    for (const { s, e, ins } of edits[k].sort((a, b) => b.s - a.s)) t = t.slice(0, s) + ins + t.slice(e)
    return t
  })

  // 5) Rewrite only the changed <w:t> nodes; leave everything else verbatim.
  let k = 0
  const xml = para.replace(TEXT_RE, (m, open: string, _text: string, close: string) => {
    const idx = k++
    if (newText[idx] === nodes[idx].text) return m
    const openPreserve = open.includes('xml:space')
      ? open
      : open.replace('<w:t', '<w:t xml:space="preserve"')
    return `${openPreserve}${xmlEscape(newText[idx])}${close}`
  })
  return { xml, hits: applied }
}

export type ReplaceOptions = {
  // Whole-token mode: only replace an occurrence of `find` that is NOT part of a
  // longer same-class value. The seed placeholder-izer replaces hand-picked
  // distinctive literals and leaves this OFF (exact substring semantics). The
  // auto-bracket path turns it ON so an accepted short literal ("$500") can't
  // corrupt a longer value that shares its prefix ("$500.00") elsewhere in the
  // document: the detector's matches are \b-bounded, so the rewrite must be too.
  wholeToken?: boolean
}

const ALNUM_RE = /[A-Za-z0-9]/

// Is the occurrence of a literal at [start, end) in `text` a standalone value,
// i.e. not the prefix/suffix/interior of a longer same-class token?
function isStandaloneOccurrence(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] : ''
  const after = end < text.length ? text[end] : ''
  if (before && ALNUM_RE.test(before)) return false
  if (after && ALNUM_RE.test(after)) return false
  // Numeric continuation: "$500" inside "$500.00", "1,500", etc.
  if ((after === '.' || after === ',') && end + 1 < text.length && /[0-9]/.test(text[end + 1])) {
    return false
  }
  return true
}

// Replace every occurrence of `find` with `tag` inside a single <w:t> node's
// text: Pass 1 of applyReplace, the format-preserving intact-in-one-run case.
// (Boundary-checked, run-spanning replacement lives in replaceAcrossRuns.)
function replaceOccurrences(text: string, find: string, tag: string): { out: string; hits: number } {
  const parts = text.split(find)
  return { out: parts.join(tag), hits: parts.length - 1 }
}

// Apply one literal→tag replacement to the whole document. Returns the new
// XML and how many occurrences were replaced (0 = literal not found).
export function applyReplace(
  documentXml: string,
  op: ReplaceOp,
  opts: ReplaceOptions = {},
): { xml: string; hits: number } {
  const wholeToken = opts.wholeToken ?? false
  let hits = 0
  let xml = documentXml

  // Pass 1: literal intact within a single <w:t> node (cheap, format-preserving).
  // ONLY safe when NOT boundary-checking. A <w:t> run boundary is NOT a value
  // boundary: Word splits a value like "$500.00" across runs unpredictably, so
  // a wholeToken standalone-check on a run in isolation can see run1 end in
  // "$500" and wrongly bracket it, corrupting a value the user never selected
  // (its "missed" fail-loud can't catch this: the same literal matched
  // legitimately elsewhere). wholeToken therefore uses paragraph-scoped
  // boundaries only (Pass 2), never per-run.
  if (!wholeToken) {
    const escaped = xmlEscape(op.find)
    const escapedTag = xmlEscape(op.tag)
    xml = xml.replace(TEXT_RE, (m, open: string, text: string, close: string) => {
      const r = replaceOccurrences(text, escaped, escapedTag)
      if (r.hits === 0) return m
      hits += r.hits
      return `${open}${r.out}${close}`
    })
  }

  // Pass 2: paragraph-scoped: concatenate the paragraph's runs to find the
  // literal against the correct value boundaries, then rewrite only the runs it
  // spans (drawings/breaks/other text kept in place). This is the ONLY pass for
  // wholeToken, and the split-run fallback for the seed path (a literal that sat
  // intact in one run was already handled by Pass 1, so those paragraphs no
  // longer contain it and are skipped here).
  xml = xml.replace(PARAGRAPH_RE, (para) => {
    const r = replaceAcrossRuns(para, op.find, op.tag, wholeToken)
    hits += r.hits
    return r.xml
  })
  return { xml, hits }
}

// Apply a loop op: first-row paragraph → {#name} + rowTemplate + {/name}
// (three paragraphs cloned from the original), remaining sample rows deleted.
export function applyLoop(documentXml: string, op: LoopOp): { xml: string; hits: number } {
  const { name, firstRowMatch, rowTemplate, deleteRowMatches } = op.loop
  let hits = 0

  let xml = documentXml.replace(PARAGRAPH_RE, (para) => {
    const text = paragraphText(para)
    if (hits === 0 && text.includes(firstRowMatch)) {
      hits += 1
      const open = setParagraphText(para, `{#${name}}`)
      const row = setParagraphText(para, rowTemplate)
      const close = setParagraphText(para, `{/${name}}`)
      return `${open}${row}${close}`
    }
    return para
  })
  if (hits === 0) return { xml: documentXml, hits }

  for (const del of deleteRowMatches) {
    let deleted = false
    xml = xml.replace(PARAGRAPH_RE, (para) => {
      if (deleted) return para
      // Never delete the loop block itself.
      const text = paragraphText(para)
      if (text.includes('{#') || text.includes('{/') || text.includes(rowTemplate)) return para
      if (!text.includes(del)) return para
      deleted = true
      return ''
    })
  }
  return { xml, hits }
}

// Remove all run highlighting. The source docs use yellow highlight as a
// manual "replace me" marker: the placeholders take over that job, and a
// generated document must not ship with highlighter smears.
export function stripHighlights(documentXml: string): string {
  return documentXml.replace(/<w:highlight w:val="[^"]*"\s*\/>/g, '')
}

export type ApplyResult = {
  xml: string
  // Ops whose literal was never found: the caller fails loudly on these.
  missed: TagOp[]
}

export function applyOps(documentXml: string, ops: TagOp[], opts: ReplaceOptions = {}): ApplyResult {
  let xml = documentXml
  const missed: TagOp[] = []
  for (const op of ops) {
    // Loops are a seed-only construct; wholeToken applies to scalar replaces.
    const r = isLoopOp(op) ? applyLoop(xml, op) : applyReplace(xml, op, opts)
    xml = r.xml
    if (r.hits === 0) missed.push(op)
  }
  return { xml, missed }
}
