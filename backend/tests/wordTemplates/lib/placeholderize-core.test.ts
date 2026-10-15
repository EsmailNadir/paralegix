import {
  applyLoop,
  applyOps,
  applyReplace,
  documentText,
  paragraphText,
  stripHighlights,
} from '../../../src/modules/wordTemplates/lib/placeholderize-core'

// Tests for the placeholder-izer's OOXML surgery (document automation).
//
// WHY these tests exist (Rule 9: tests verify intent, not just behavior):
//
//   Word splits literal text across consecutive <w:r> runs unpredictably, so
//   the naive "string-replace the XML" approach silently misses literals and
//   ships templates with sample client data (names, case numbers) still
//   embedded: a confidentiality problem, not just a bug. These tests pin the
//   two-pass behavior: format-preserving in-run replacement when possible,
//   paragraph collapse when the literal spans runs, and loud misses (hits=0)
//   when a literal isn't found at all.

function run(text: string, props = ''): string {
  return `<w:r>${props}<w:t xml:space="preserve">${text}</w:t></w:r>`
}

function p(inner: string): string {
  return `<w:p>${inner}</w:p>`
}

describe('paragraph/document text extraction', () => {
  it('concatenates runs and decodes entities', () => {
    const para = p(run('Smith ') + run('&amp; Jones'))
    expect(paragraphText(para)).toBe('Smith & Jones')
  })

  it('documentText joins paragraphs with newlines', () => {
    const xml = p(run('one')) + p(run('two'))
    expect(documentText(xml)).toBe('one\ntwo')
  })
})

describe('applyReplace', () => {
  it('replaces a literal intact within one run, leaving other runs untouched', () => {
    const bold = '<w:rPr><w:b/></w:rPr>'
    const xml = p(run('Defendant ', bold) + run('Corwin Thistlewood') + run(' appears'))
    const { xml: out, hits } = applyReplace(xml, {
      find: 'Corwin Thistlewood',
      tag: '{defendant_name}',
    })
    expect(hits).toBe(1)
    // The bold run survives verbatim: pass 1 is format-preserving.
    expect(out).toContain(bold)
    expect(documentText(out)).toBe('Defendant {defendant_name} appears')
  })

  it('collapses the paragraph when the literal is split across runs', () => {
    // "TRC00" + "00551": Word's arbitrary run split.
    const xml = p(run('Case No. ') + run('TRC00') + run('00551') + run(' filed'))
    const { xml: out, hits } = applyReplace(xml, { find: 'TRC0000551', tag: '{case_number}' })
    expect(hits).toBe(1)
    expect(documentText(out)).toBe('Case No. {case_number} filed')
  })

  it('reports zero hits when the literal is absent (caller fails loud)', () => {
    const xml = p(run('nothing to see'))
    const { hits } = applyReplace(xml, { find: 'Thistlewood', tag: '{defendant_name}' })
    expect(hits).toBe(0)
  })

  it('handles literals containing XML-special characters', () => {
    const xml = p(run('Smith &amp; Jones LLC'))
    const { xml: out, hits } = applyReplace(xml, { find: 'Smith & Jones LLC', tag: '{firm_name}' })
    expect(hits).toBe(1)
    expect(documentText(out)).toBe('{firm_name}')
  })

  it('replaces the same literal in multiple paragraphs', () => {
    const xml = p(run('Corwin Thistlewood, Defendant')) + p(run('serve Corwin Thistlewood by mail'))
    const { xml: out, hits } = applyReplace(xml, {
      find: 'Corwin Thistlewood',
      tag: '{defendant_name}',
    })
    expect(hits).toBe(2)
    expect(documentText(out)).toBe('{defendant_name}, Defendant\nserve {defendant_name} by mail')
  })

  it('catches a run-split occurrence even when another occurrence sat intact in one run', () => {
    // Real case from the Hale filings: "Hale Hale" is intact in the
    // signature block but split across runs in the body sentence. A pass-1
    // hit must not short-circuit pass 2, or the split occurrence ships with
    // sample data still embedded.
    const xml =
      p(run('NOW COMES the undersigned, ') + run('Hale ') + run('Hale') + run(', counsel')) +
      p(run('Hale Hale'))
    const { xml: out, hits } = applyReplace(xml, {
      find: 'Hale Hale',
      tag: '{attorney_name}',
    })
    expect(hits).toBe(2)
    expect(documentText(out)).toBe(
      'NOW COMES the undersigned, {attorney_name}, counsel\n{attorney_name}',
    )
  })

  // WHY (Rule 9): letterhead lines interleave text with inline icon drawings
  // (phone/email/location). A whole-paragraph collapse moved all text into the
  // first run, shoving the icons past the text and reflowing the block so the
  // address/city line drifted onto the letterhead's fixed rule (rendered like a
  // strikethrough). The rewrite must touch ONLY the runs the literal spans and
  // leave the drawing exactly where it was.
  const drawing = '<w:r><w:rPr><w:noProof/></w:rPr><w:drawing><wp:inline/></w:drawing></w:r>'

  it('keeps a split literal after an inline drawing (does not reorder text past the icon)', () => {
    // "SEC"+"RET" is split across runs (forces the run-spanning path), and sits
    // AFTER a drawing. The tag must stay after the drawing.
    const xml = p(run('a ') + drawing + run('SEC') + run('RET'))
    const { xml: out, hits } = applyReplace(xml, { find: 'SECRET', tag: '{tag}' })
    expect(hits).toBe(1)
    expect(documentText(out)).toBe('a {tag}')
    expect(out).toContain('<w:drawing>')
    expect(out.indexOf('<w:drawing>')).toBeLessThan(out.indexOf('{tag}'))
  })

  it('keeps an inline icon between two replaced literals in place (letterhead pattern)', () => {
    // email  [icon]  address(split)  → both become tags, icon stays between them.
    const xml = p(
      run('Email: ') + run('a@b.com') + drawing + run('100 ') + run('Main St'),
    )
    let out = applyReplace(xml, { find: 'a@b.com', tag: '{firm_email}' }).xml
    out = applyReplace(out, { find: '100 Main St', tag: '{firm_address}' }).xml
    expect(documentText(out)).toBe('Email: {firm_email}{firm_address}')
    expect(out.indexOf('{firm_email}')).toBeLessThan(out.indexOf('<w:drawing>'))
    expect(out.indexOf('<w:drawing>')).toBeLessThan(out.indexOf('{firm_address}'))
  })
})

// wholeToken mode: the auto-bracket path (regex-detected literals) opts in so a
// short accepted literal can't corrupt a longer value that shares its prefix.
// WHY (Rule 9): the detector's matches are \b-bounded; without this the rewrite
// would silently mangle boilerplate the user never selected (e.g. bracket "$500"
// and turn a nearby "$500.00" into "{amount}.00"), shipping a corrupt template.
describe('applyReplace: wholeToken (auto-bracket) mode', () => {
  it('does not corrupt a longer value that shares the accepted literal as a prefix', () => {
    const xml = p(run('The filing fee is $500.')) + p(run('Retainer paid: $500.00 total'))
    const { xml: out, hits } = applyReplace(
      xml,
      { find: '$500', tag: '{amount_1}' },
      { wholeToken: true },
    )
    expect(hits).toBe(1) // only the standalone "$500." occurrence
    expect(documentText(out)).toBe(
      'The filing fee is {amount_1}.\nRetainer paid: $500.00 total',
    )
  })

  it('still brackets a standalone value that is split across runs', () => {
    const xml = p(run('Total: $2,') + run('500.00 due'))
    const { xml: out, hits } = applyReplace(
      xml,
      { find: '$2,500.00', tag: '{amount_1}' },
      { wholeToken: true },
    )
    expect(hits).toBe(1)
    expect(documentText(out)).toBe('Total: {amount_1} due')
  })

  it('reports a miss (hits=0) when the literal only appears inside a longer value', () => {
    const xml = p(run('Retainer paid: $500.00 total'))
    const { missed } = applyOps(xml, [{ find: '$500', tag: '{amount_1}' }], { wholeToken: true })
    expect(missed).toHaveLength(1)
  })

  it('default (substring) mode WOULD corrupt it: the hazard wholeToken fixes', () => {
    const xml = p(run('Retainer paid: $500.00 total'))
    const { xml: out } = applyReplace(xml, { find: '$500', tag: '{x}' }) // no wholeToken
    expect(documentText(out)).toBe('Retainer paid: {x}.00 total')
  })

  it('does not mis-bracket a RUN boundary that is not a value boundary', () => {
    // Para A (not accepted by the user): Word split "$500.00" across two runs, so
    // run1 ends in "$500". A per-run standalone-check would wrongly bracket it;
    // only the paragraph's concatenated text ("...$500.00...") is the correct
    // boundary, where "$500" is NOT standalone. Para B has a real standalone "$500".
    const paraA = p(run('The deposit was $500') + run('.00 last month.'))
    const paraB = p(run('Please pay $500 today.'))
    const { xml: out, hits } = applyReplace(
      paraA + paraB,
      { find: '$500', tag: '{amount_1}' },
      { wholeToken: true },
    )
    expect(hits).toBe(1) // only paragraph B
    expect(documentText(out)).toBe(
      'The deposit was $500.00 last month.\nPlease pay {amount_1} today.',
    )
  })
})

// Self-closing empty runs (<w:t/>) appear around inline images / spacing. Text
// extraction must skip them, not treat them as an opening tag and swallow the
// following runs + drawing markup as text.
// WHY (Rule 9): a filled Word doc with a letterhead image produced a context
// snippet full of raw OOXML in the auto-bracket review UI: the e2e caught it.
describe('paragraphText / documentText: self-closing <w:t/>', () => {
  it('skips <w:t/> without swallowing the following markup as text', () => {
    const xml = p(
      run('Email: ') +
        `<w:r><w:rPr><w:spacing w:val="-11"/></w:rPr><w:t/></w:r>` +
        `<w:r><w:rPr><w:noProof/></w:rPr><w:drawing><wp:inline distT="0"/></w:drawing></w:r>` +
        run('office@firm.com'),
    )
    expect(paragraphText(xml)).toBe('Email: office@firm.com')
    expect(documentText(xml)).not.toContain('<w:')
  })
})

describe('stripHighlights', () => {
  it('removes highlight run-properties without touching text or other props', () => {
    // The source docs mark fill-me spots with yellow highlight; generated
    // documents must not ship with highlighter smears.
    const xml = p(
      `<w:r><w:rPr><w:b/><w:highlight w:val="yellow"/></w:rPr><w:t>flat rate of {flat_fee_amount}</w:t></w:r>`,
    )
    const out = stripHighlights(xml)
    expect(out).not.toContain('w:highlight')
    expect(out).toContain('<w:b/>')
    expect(documentText(out)).toBe('flat rate of {flat_fee_amount}')
  })
})

describe('applyLoop', () => {
  const schedule =
    p(run('Payments as follows:')) +
    p(run('April 1, 2026- $500.00 payment')) +
    p(run('May 1, 2026- $500.00 payment')) +
    p(run('Signed,'))

  it('turns the first sample row into a {#loop} block and deletes the rest', () => {
    const { xml: out, hits } = applyLoop(schedule, {
      loop: {
        name: 'payments',
        firstRowMatch: 'April 1, 2026- $500.00 payment',
        rowTemplate: '{payment_date}- {payment_amount} payment',
        deleteRowMatches: ['May 1, 2026- $500.00 payment'],
      },
    })
    expect(hits).toBe(1)
    expect(documentText(out).split('\n').filter(Boolean)).toEqual([
      'Payments as follows:',
      '{#payments}',
      '{payment_date}- {payment_amount} payment',
      '{/payments}',
      'Signed,',
    ])
  })

  it('reports zero hits when the first row is absent', () => {
    const { hits } = applyLoop(schedule, {
      loop: {
        name: 'payments',
        firstRowMatch: 'not in the document',
        rowTemplate: '{payment_date}',
        deleteRowMatches: [],
      },
    })
    expect(hits).toBe(0)
  })
})

describe('applyOps', () => {
  it('applies all ops and reports the missed ones', () => {
    const xml = p(run('Corwin Thistlewood')) + p(run('TRC0000551'))
    const { xml: out, missed } = applyOps(xml, [
      { find: 'Corwin Thistlewood', tag: '{defendant_name}' },
      { find: 'TRC0000551', tag: '{case_number}' },
      { find: 'Judge Nobody', tag: '{judge_name}' },
    ])
    expect(documentText(out)).toBe('{defendant_name}\n{case_number}')
    expect(missed).toEqual([{ find: 'Judge Nobody', tag: '{judge_name}' }])
  })
})
