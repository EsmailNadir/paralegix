import htmlToDocx from 'html-to-docx'
import PizZip from 'pizzip'
import { prepareHtmlForDocx } from '../../../src/modules/wordTemplates/lib/docx-html'

// WHY these tests exist (Rule 9: intent, not mechanics).
//
// A representation agreement exported to Word came out as
// "Thisletterconfirmsthatourofficewillrepresentyou…": every space in the
// document gone, and Word breaking the resulting mega-token mid-word at the
// right margin. It was not a bad template: html-to-docx discards any text node
// that is whitespace-only, and pdf-to-html.ts renders PDF text one <span> per
// character with bare spaces between items, so EVERY space qualified.
//
// The end-to-end test below is the one that matters. Asserting on the HTML
// alone would pass for any rewrite that merely looks reasonable; only running
// the real converter and reading the text back out of word/document.xml proves
// the spaces reached Word. If html-to-docx is ever upgraded or swapped, that
// test is what tells us whether this whole module is still needed.

const STYLE = 'font-family:Georgia,serif;font-size:12.0px;'

/** Mimics renderStyledCharacters: one <span> per character, one shared style. */
function perCharSpans(text: string, style = STYLE): string {
  return [...text].map((c) => `<span style="${style}">${c}</span>`).join('')
}

/** Pull the visible text out of a .docx, in run order. */
function docxText(buffer: Buffer): string {
  const xml = new PizZip(buffer).file('word/document.xml')!.asText()
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join('')
}

async function exportToDocxText(html: string): Promise<string> {
  const out = await htmlToDocx(html, undefined, { table: { row: { cantSplit: true } } })
  const buffer = Buffer.isBuffer(out) ? out : Buffer.from(await (out as Blob).arrayBuffer())
  return docxText(buffer)
}

describe('prepareHtmlForDocx', () => {
  it('rejoins per-character spans into one run', () => {
    expect(prepareHtmlForDocx(`<p>${perCharSpans('Dear')}</p>`)).toBe(
      `<p><span style="${STYLE}">Dear</span></p>`,
    )
  })

  it('keeps the space that lived in its own span', () => {
    // renderStyledCharacters gives the space character its own <span> exactly
    // like every other character: that is the space that was disappearing.
    expect(prepareHtmlForDocx(`<p>${perCharSpans('Dear Mr.')}</p>`)).toBe(
      `<p><span style="${STYLE}">Dear Mr.</span></p>`,
    )
  })

  it('folds a bare word gap into the run before it', () => {
    // renderHorizontalGap emits a normal word gap as a bare space between two
    // items. Attached to the preceding run it survives conversion AND stays a
    // legal wrap point, which an NBSP would not be.
    const other = 'font-family:Georgia,serif;font-size:9.0px;'
    expect(
      prepareHtmlForDocx(`<span style="${STYLE}">Suite</span> <span style="${other}">250</span>`),
    ).toBe(`<span style="${STYLE}">Suite </span><span style="${other}">250</span>`)
  })

  it('leaves markup it does not recognise byte-for-byte', () => {
    // Placeholder chips, images, and the data-pdf-gap spacers all carry extra
    // attributes. Rewriting those would be a much larger blast radius than the
    // bug justifies.
    const html =
      '<p><span data-pdf-gap="true" style="display:inline-block;width:18.0px;"> </span>' +
      '<span data-placeholder-chip="client_name">David Goddard</span></p>'
    expect(prepareHtmlForDocx(html)).toBe(html)
  })

  it('is idempotent', () => {
    const once = prepareHtmlForDocx(`<p>${perCharSpans('Dear Mr. Goddard,')}</p>`)
    expect(prepareHtmlForDocx(once)).toBe(once)
  })
})

describe('DOCX export end-to-end', () => {
  const sentence = 'This letter confirms that our office will represent you.'

  it('loses every space WITHOUT the repair: the bug, pinned', async () => {
    // Not a wish-list assertion: this is what shipped to the client. If a
    // future html-to-docx handles whitespace-only nodes properly this test
    // fails, and prepareHtmlForDocx can be deleted rather than carried.
    expect(await exportToDocxText(`<p>${perCharSpans(sentence)}</p>`)).toBe(
      sentence.replace(/ /g, ''),
    )
  })

  it('reads back word-for-word WITH the repair', async () => {
    const html = prepareHtmlForDocx(`<p>${perCharSpans(sentence)}</p>`)
    expect(await exportToDocxText(html)).toBe(sentence)
  })

  it('survives a mixed-style line with bare gaps between items', async () => {
    // The letterhead shape: differently-sized items on one line, separated by
    // renderHorizontalGap's bare spaces. These cannot merge into one run, so
    // this is the case that proves gap-folding works and not just merging.
    const head = 'font-family:Georgia,serif;font-size:14.0px;'
    const line =
      `<p>${perCharSpans('Hale Law LLC', head)} ` +
      `${perCharSpans('100 E. Harbor View Blvd', STYLE)} ` +
      `${perCharSpans('Suite 250', STYLE)}</p>`
    expect(await exportToDocxText(prepareHtmlForDocx(line))).toBe(
      'Hale Law LLC 100 E. Harbor View Blvd Suite 250',
    )
  })
})
