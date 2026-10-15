import { fieldLabel } from '@/lib/wordTemplates/vocabulary'

// The name a person reads for a template field, in place of the tag the
// template stores. Word-first templates show these where people read or fill them.

describe('fieldLabel', () => {
  it("uses the vocabulary's label for a known field", () => {
    expect(fieldLabel('judge_name_caps')).toBe('Judge name (UPPERCASE)')
    expect(fieldLabel('case_number')).toBe('Case number')
  })

  it('reads a field inside a section by its own name', () => {
    // Breaks if the section prefix is kept: "Payment Plan Initial Payment
    // Amount" instead of the field's name.
    expect(fieldLabel('payment_plan.initial_payment_amount')).toBe(fieldLabel('initial_payment_amount'))
    expect(fieldLabel('paid_in_full.flat_fee_due_date')).toBe('Flat fee due date (paid in full)')
  })

  it('makes an unknown tag readable', () => {
    expect(fieldLabel('some_custom_field')).toBe('Some Custom Field')
    expect(fieldLabel('Client DOB')).toBe('Client Dob')
  })

  it('falls back to the tag when nothing is left to read', () => {
    expect(fieldLabel('___')).toBe('___')
  })
})
