import {
  buildFlatFieldList,
  extractPlaceholders,
  extractRepeaters,
} from '@/lib/wordTemplates/placeholders'

// WHY these tests exist:
//
//   The template editor marks a repeating row by putting `data-repeater` on the
//   row's <p>, and the save path throws away the editor's own repeater list and
//   re-extracts from the HTML. The extractor only recognised <div data-repeater>,
//   so every HTML template saved with `repeaters: []`. At fill time the form had
//   no repeater to offer rows for, and the fill deletes a repeater paragraph that
//   has no rows: a payment schedule the user typed printed nothing.

// What the editor saves for a row marked as the `payments` repeater: the chips
// inside are prefixed `payments.<field>`.
const chip = (name: string) =>
  `<span data-placeholder-chip="${name}" contenteditable="false"><span>{${name}}</span></span>`

const PAYMENT_ROW =
  `<p data-repeater="payments" style="top: 120px">` +
  `${chip('payments.date')} - ${chip('payments.amount')}` +
  `</p>`

const LETTER =
  `<div class="pdf-page">` +
  `<p style="top: 72px">Dear ${chip('client_name')},</p>` +
  PAYMENT_ROW +
  `<p style="top: 160px">Signed ${chip('attorney_name')}</p>` +
  `</div>`

// The partition FillTemplateModal applies to the saved columns: a flat field
// that belongs to a saved repeater gets a row input, everything else a single
// input.
function regularFieldsOf(fields: string[], repeaters: { name: string; fields: string[] }[]) {
  const repeaterFieldSet = new Set(repeaters.flatMap((r) => r.fields.map((f) => `${r.name}.${f}`)))
  return fields.filter((f) => !repeaterFieldSet.has(f))
}

describe('HTML template repeaters marked on a <p>', () => {
  it('extracts the paragraph as a repeater with its unprefixed fields', () => {
    // Guards: a saved payment schedule gets rows in the fill form at all.
    expect(extractRepeaters(LETTER)).toEqual([{ name: 'payments', fields: ['amount', 'date'] }])
  })

  it('keeps the repeater fields out of the single-value fields', () => {
    // Guards: `payments.date` is not offered as one plain input that never prints.
    expect(extractPlaceholders(LETTER)).toEqual(['attorney_name', 'client_name'])
  })

  it('merges several paragraphs carrying the same repeater name into one repeater', () => {
    // Guards: a two-line row (date line + amount line) fills as one row per payment, not two schedules.
    const html =
      `<p data-repeater="payments">${chip('payments.date')}</p>` +
      `<p>Between rows ${chip('client_name')}</p>` +
      `<p data-repeater="payments">${chip('payments.amount')} ${chip('payments.method')}</p>`

    expect(extractRepeaters(html)).toEqual([
      { name: 'payments', fields: ['amount', 'date', 'method'] },
    ])
    expect(extractPlaceholders(html)).toEqual(['client_name'])
  })

  it('ends a <p> repeater at its own closing tag', () => {
    // Guards: a chip in the paragraph after the row stays a single-value field.
    const html = `${PAYMENT_ROW}<p>${chip('court_name')}</p>`

    expect(extractRepeaters(html)).toEqual([{ name: 'payments', fields: ['amount', 'date'] }])
    expect(extractPlaceholders(html)).toEqual(['court_name'])
  })

  it('stores `name.field` entries the fill form treats as repeater fields', () => {
    // Guards: the saved columns reach FillTemplateModal in the same shape as a Word repeater's.
    const repeaters = extractRepeaters(LETTER)
    const fields = buildFlatFieldList({ fields: extractPlaceholders(LETTER), repeaters })

    expect(fields).toEqual(['attorney_name', 'client_name', 'payments.amount', 'payments.date'])
    expect(regularFieldsOf(fields, repeaters)).toEqual(['attorney_name', 'client_name'])
  })
})

describe('HTML template repeaters marked on a <div>', () => {
  it('still extracts a div repeater to its matching close, past nested divs', () => {
    // Guards: the depth-aware <div> handling is unchanged by the <p> support.
    const html =
      `<div data-repeater="line_items"><div>${chip('line_items.description')}</div>` +
      `<div>${chip('amount')}</div></div>` +
      `<div>${chip('client_name')}</div>`

    expect(extractRepeaters(html)).toEqual([
      { name: 'line_items', fields: ['amount', 'description'] },
    ])
    expect(extractPlaceholders(html)).toEqual(['client_name'])
  })
})
