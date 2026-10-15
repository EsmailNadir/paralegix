import { uniqueCopyName } from '../../../src/modules/wordTemplates/lib/duplicates'

// The template list is flat, so an upload whose name is taken is a duplicate:
// staff get Replace / Save as a copy rather than a second "Representation
// Agreement". Whether a name is taken is the repository's firm-scoped,
// case-insensitive, per-type question (covered through the real routes in
// wordTemplates.routes.test.ts); this pins how a copy name is chosen.

function takenOf(names: string[]) {
  const set = new Set(names)
  const asked: string[] = []
  const isTaken = async (candidate: string) => {
    asked.push(candidate)
    return set.has(candidate)
  }
  return { isTaken, asked }
}

describe('uniqueCopyName', () => {
  it('uses "Name (copy)" when nothing holds it', async () => {
    const { isTaken } = takenOf(['Notice of Appearance'])
    expect(await uniqueCopyName('Notice of Appearance', isTaken)).toBe('Notice of Appearance (copy)')
  })

  it('skips copy names already taken', async () => {
    const { isTaken, asked } = takenOf(['Notice of Appearance', 'Notice of Appearance (copy)'])
    expect(await uniqueCopyName('Notice of Appearance', isTaken)).toBe('Notice of Appearance (copy 2)')
    expect(asked).toEqual(['Notice of Appearance (copy)', 'Notice of Appearance (copy 2)'])
  })

  it('falls back to a random suffix after 99 taken copies', async () => {
    const result = await uniqueCopyName('Motion', async () => true)
    expect(result).toMatch(/^Motion \([0-9a-f]{8}\)$/)
  })

  it('keeps the copy name within the 200-character name limit', async () => {
    const base = 'x'.repeat(200)
    const result = await uniqueCopyName(base, async () => false)
    expect(result).toHaveLength(200)
  })
})
