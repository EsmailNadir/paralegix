import { assembleFirmKnownValues } from '../../../src/modules/wordTemplates/lib/firm-known-values'
import { buildKnownValueIndex, resolveKnownValue } from '../../../src/modules/wordTemplates/lib/auto-bracket/known-values'

const empty = { firm: null, caseNumbers: [], courtNames: [], judgeNames: [], serviceRecipients: [], clients: [] }

describe('assembleFirmKnownValues', () => {
  it('lists the firm\'s letterhead before any client value', () => {
    const values = assembleFirmKnownValues({
      ...empty,
      firm: { name: 'Wayfield Defense Group', email: 'office@wayfield.test', phone: '(614) 555-0182' },
      clients: [{ name: 'Jordan Avery', email: 'office@wayfield.test' }],
    })
    expect(values.map((v) => v.canonicalId)).toEqual([
      'firm_name', 'firm_phone', 'firm_email', 'client_name', 'client_email', 'client_last_name',
    ])
    // The shared mailbox resolves to the firm, never to the client who also used it.
    expect(resolveKnownValue('office@wayfield.test', buildKnownValueIndex(values))).toBe('firm_email')
  })

  it('maps each record to its vocabulary id', () => {
    const values = assembleFirmKnownValues({
      ...empty,
      caseNumbers: ['2026 CRB 004821', null],
      courtNames: ['Franklin County Municipal Court'],
      judgeNames: ['Amelia Grant'],
      serviceRecipients: ['Dana Prosecutor'],
      clients: [{ name: 'Corwin Thistlewood', phone: '(614) 555-0100', organization: 'Thistlewood LLC' }],
    })
    expect(values).toEqual([
      { value: '2026 CRB 004821', canonicalId: 'case_number', nameOnly: undefined },
      { value: 'Franklin County Municipal Court', canonicalId: 'court_name', nameOnly: undefined },
      { value: 'Amelia Grant', canonicalId: 'judge_name', nameOnly: undefined },
      { value: 'Dana Prosecutor', canonicalId: 'service_recipient', nameOnly: undefined },
      { value: 'Corwin Thistlewood', canonicalId: 'client_name', nameOnly: undefined },
      { value: '(614) 555-0100', canonicalId: 'client_phone', nameOnly: undefined },
      { value: 'Thistlewood LLC', canonicalId: 'client_organization', nameOnly: undefined },
      { value: 'Thistlewood', canonicalId: 'client_last_name', nameOnly: true, ofName: 'Corwin Thistlewood' },
    ])
  })

  it('derives no surname from a single name or a short one', () => {
    const values = assembleFirmKnownValues({ ...empty, clients: [{ name: 'Cher' }, { name: 'Li Wu' }] })
    expect(values.filter((v) => v.canonicalId === 'client_last_name')).toEqual([])
  })
})
