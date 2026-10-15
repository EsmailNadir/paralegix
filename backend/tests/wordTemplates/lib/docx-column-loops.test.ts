import PizZip from 'pizzip'
import { fillDocxTemplate, parseDocxPlaceholders, COLUMN_LOOP_ROWS } from '../../../src/modules/wordTemplates/lib/docx'

// WHY these tests exist:
//
//   A payment schedule printed as one long list runs off the page. The firm's
//   representation agreement lays it out in two columns of at most eight rows,
//   which in Word means two loops, one per table cell. Nobody is going to type
//   the same schedule into two lists and keep the split right by hand, so a
//   `{#rows_col1}` / `{#rows_col2}` pair in the document is ONE loop, `rows`, to
//   everything above the engine: the fill form shows one list, and the engine
//   deals the rows into the columns.
//
//   What has to break for these to go red: rows past the first column silently
//   disappearing from the document (the schedule the client signs), or the fill
//   form growing a second list the user has to split themselves.

function makeDocx(bodyXml: string): Buffer {
  const zip = new PizZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
  )
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  )
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${bodyXml}</w:body></w:document>`,
  )
  return zip.generate({ type: 'nodebuffer' })
}

const para = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`

// Two cells, each looping its own column of the same schedule.
const TWO_COLUMN_SCHEDULE = makeDocx(
  para('Schedule:') +
    para('{#rows_col1}') +
    para('{schedule_date} - ${schedule_amount} payment') +
    para('{/rows_col1}') +
    para('{#rows_col2}') +
    para('{schedule_date} - ${schedule_amount} payment') +
    para('{/rows_col2}'),
)

function textOf(buffer: Buffer): string {
  const zip = new PizZip(buffer)
  return zip
    .file('word/document.xml')!
    .asText()
    .replace(/<[^>]+>/g, '')
}

function schedule(count: number): Record<string, string>[] {
  return Array.from({ length: count }, (_, i) => ({
    schedule_date: `DATE${i + 1}`,
    schedule_amount: `${i + 1}00.00`,
  }))
}

describe('parseDocxPlaceholders: a column pair is one loop', () => {
  it('reports the base loop once, not one loop per column', () => {
    const parsed = parseDocxPlaceholders(TWO_COLUMN_SCHEDULE)
    expect(parsed.repeaters).toEqual([
      { name: 'rows', fields: ['schedule_date', 'schedule_amount'] },
    ])
    expect(parsed.fields).toEqual([])
  })
})

describe('fillDocxTemplate: dealing one schedule into its columns', () => {
  it(`puts the first ${COLUMN_LOOP_ROWS} rows in the first column and the rest in the second`, () => {
    const rows = schedule(COLUMN_LOOP_ROWS + 3)
    const { buffer } = fillDocxTemplate(TWO_COLUMN_SCHEDULE, {}, { rows })
    const text = textOf(buffer)

    // Every row reaches the document, in order, and the split is where it says.
    for (const row of rows) expect(text).toContain(row.schedule_date)
    const firstOfSecondColumn = text.indexOf(`DATE${COLUMN_LOOP_ROWS + 1}`)
    const lastOfFirstColumn = text.indexOf(`DATE${COLUMN_LOOP_ROWS}`)
    expect(lastOfFirstColumn).toBeLessThan(firstOfSecondColumn)
  })

  it('keeps a short schedule in the first column and leaves the second empty', () => {
    const { buffer } = fillDocxTemplate(TWO_COLUMN_SCHEDULE, {}, { rows: schedule(3) })
    const text = textOf(buffer)
    expect(text.match(/DATE\d/g)).toEqual(['DATE1', 'DATE2', 'DATE3'])
  })

  it('never drops rows past the last column: the last one takes the remainder', () => {
    const rows = schedule(COLUMN_LOOP_ROWS * 2 + 5)
    const { buffer } = fillDocxTemplate(TWO_COLUMN_SCHEDULE, {}, { rows })
    const text = textOf(buffer)
    for (const row of rows) expect(text).toContain(row.schedule_date)
  })

  it('prints the amount against the template\'s own currency sign', () => {
    const { buffer } = fillDocxTemplate(TWO_COLUMN_SCHEDULE, {}, { rows: schedule(1) })
    expect(textOf(buffer)).toContain('DATE1 - $100.00 payment')
  })

  it('leaves an ordinary loop alone', () => {
    const plain = makeDocx(para('{#payments}') + para('{payment_date}') + para('{/payments}'))
    expect(parseDocxPlaceholders(plain).repeaters).toEqual([
      { name: 'payments', fields: ['payment_date'] },
    ])
    const { buffer } = fillDocxTemplate(plain, {}, { payments: [{ payment_date: 'X1' }] })
    expect(textOf(buffer)).toContain('X1')
  })
})
