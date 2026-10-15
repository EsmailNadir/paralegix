import {
  detectRepeaters,
  isConsumedByRepeaters,
} from '../../../src/modules/wordTemplates/lib/auto-bracket/detect-repeaters'

// Tests for repeating-row detection (layer 7).
//
// WHY (Rule 9): this layer exists because a payment schedule cannot be
// expressed as scalar fields at all. Four installments of the same amount
// deduplicate to one literal, and the next case has six of them: so what
// matters is not "finds the rows" but "produces a LOOP whose body is the row",
// and that the rows it claims are exactly the schedule and nothing adjacent.
// Claiming one row too many deletes a paragraph from the filing.

const SCHEDULE = [
  'and pay the remaining balance in the schedule below:',
  'March 4, 2026- $250 payment',
  'March 18, 2026- $250 payment',
  'April 1, 2026- $250 payment',
  'April 15, 2026- $250 payment',
  '',
  'You and I are both free to terminate the engagement at any time.',
].join('\n')

describe('detectRepeaters', () => {
  it('turns a payment schedule into one loop over its rows', () => {
    const [r] = detectRepeaters(SCHEDULE)
    expect(r).toMatchObject({
      suggestedTag: 'payments',
      fields: ['payment_date', 'payment_amount'],
      rowTemplate: '{payment_date}- {payment_amount} payment',
      canonical: true,
    })
    expect(r.rowTexts).toHaveLength(4)
  })

  it('claims the schedule rows and nothing around them', () => {
    // One row too many deletes a real paragraph from every future filing.
    const [r] = detectRepeaters(SCHEDULE)
    expect(r.rowTexts[0]).toBe('March 4, 2026- $250 payment')
    expect(r.rowTexts[3]).toBe('April 15, 2026- $250 payment')
    expect(r.rowTexts.some((t) => t.includes('terminate'))).toBe(false)
  })

  it('groups rows whose values differ but whose shape does not', () => {
    // The whole point: the amounts here are all different, the dates are all
    // different, and it is still one schedule.
    const varied = [
      '1/1/2026- $100 payment',
      '2/1/2026- $250.50 payment',
      '3/1/2026- $1,000 payment',
    ].join('\n')
    expect(detectRepeaters(varied)).toHaveLength(1)
  })

  it('needs three rows: two of a shape is a coincidence', () => {
    expect(detectRepeaters('1/1/2026- $100 payment\n2/1/2026- $250 payment')).toEqual([])
  })

  it('does not join two schedules across a blank line', () => {
    // A gap usually means a new section; joining across it would delete
    // paragraphs the author wanted kept.
    const two = [
      '1/1/2026- $100 payment',
      '2/1/2026- $100 payment',
      '3/1/2026- $100 payment',
      '',
      '4/1/2026- $100 payment',
      '5/1/2026- $100 payment',
      '6/1/2026- $100 payment',
    ].join('\n')
    const blocks = detectRepeaters(two)
    expect(blocks).toHaveLength(2)
    expect(blocks[0].rowTexts).toHaveLength(3)
    expect(blocks[1].rowTexts).toHaveLength(3)
  })

  it('does not group rows that differ outside their values', () => {
    const mixed = [
      '1/1/2026- $100 payment',
      '2/1/2026- $100 deposit',
      '3/1/2026- $100 payment',
    ].join('\n')
    expect(detectRepeaters(mixed)).toEqual([])
  })

  it('leaves a hand-numbered list alone rather than repeating row one’s number', () => {
    // v1 limitation, deliberate: grouping these would make the loop body print
    // "1." on every iteration, which is worse than not detecting the block.
    const numbered = ['1. 1/1/2026- $100', '2. 2/1/2026- $100', '3. 3/1/2026- $100'].join('\n')
    expect(detectRepeaters(numbered)).toEqual([])
  })

  it('gives a shape it cannot name a generic loop for the reviewer', () => {
    const emails = ['a@x.com sent', 'b@x.com sent', 'c@x.com sent'].join('\n')
    const [r] = detectRepeaters(emails)
    expect(r).toMatchObject({ suggestedTag: 'rows', fields: ['col_1'], canonical: false })
  })

  it('ignores a run of lines with no values in them', () => {
    expect(detectRepeaters('one\ntwo\nthree\nfour')).toEqual([])
  })

  it('ignores repeating prose that is too long to be a row', () => {
    const long = `${'x'.repeat(170)} $100`
    expect(detectRepeaters([long, long, long].join('\n'))).toEqual([])
  })
})

describe('isConsumedByRepeaters', () => {
  const [block] = detectRepeaters(SCHEDULE)

  it('reports a value that exists only inside the rows', () => {
    // The loop consumes the rows, so this literal has nothing left to find by
    // the time its own op runs: and an op that finds nothing fails the upload.
    expect(isConsumedByRepeaters('March 4, 2026', SCHEDULE, [block])).toBe(true)
  })

  it('spares a value that also appears in the prose', () => {
    // The firm's own agreement: "$250" is the initial payment AND every row.
    const withProse = `You have agreed to make an initial payment of $250.\n${SCHEDULE}`
    expect(isConsumedByRepeaters('$250', withProse, [block])).toBe(false)
  })

  it('is false when the document has no blocks at all', () => {
    expect(isConsumedByRepeaters('$250', SCHEDULE, [])).toBe(false)
  })
})
