/**
 * The money formatters. Two functions, two different contracts, no coverage.
 *
 * Everything in this app is stored as integer cents, so `formatCents` is the
 * one that matches the database and `formatCurrency` takes dollars. They have
 * nearly the same name and nearly the same signature, and passing cents to the
 * dollars one renders a bill a hundred times too large. That is the class of
 * mistake these tests exist to catch.
 *
 * Two cases below are CHARACTERISATION and marked as such: they record what
 * ships today, and both are reported rather than changed, because quietly
 * altering how money renders is a product decision.
 */
import { formatCents, formatCurrency, parseMoneyInput, parseSignedMoneyInput } from '@/lib/utils/currency';

describe('formatCents', () => {
  it('renders whole dollars', () => {
    expect(formatCents(100)).toBe('$1.00');
    expect(formatCents(12345)).toBe('$123.45');
  });

  it('renders sub-dollar amounts without losing the cent', () => {
    // The smallest unit the system stores. A formatter that divided and rounded
    // wrong would show "$0.00" for a real one-cent balance.
    expect(formatCents(1)).toBe('$0.01');
    expect(formatCents(99)).toBe('$0.99');
  });

  it('renders zero as zero, not as an empty string', () => {
    // A paid invoice shows its balance. Blank reads as "unknown", not "settled".
    expect(formatCents(0)).toBe('$0.00');
  });

  it('renders a negative amount with the sign OUTSIDE the currency symbol', () => {
    // A credit note or an overpayment. "-$123.45", not "$-123.45": the second is
    // what a naive `'$' + (cents/100)` produces and it looks like a typo on an
    // invoice.
    expect(formatCents(-12345)).toBe('-$123.45');
    expect(formatCents(-1)).toBe('-$0.01');
  });

  it('groups thousands', () => {
    // Firm-level totals reach seven figures. Ungrouped digits are misread.
    expect(formatCents(100_000_000)).toBe('$1,000,000.00');
  });

  it('is exact on amounts that float arithmetic would drift on', () => {
    // The reason money is stored as integer cents in the first place. Summing
    // 0.1 + 0.2 in dollars gives 0.30000000000000004; summing 10 + 20 cents
    // cannot drift.
    expect(formatCents(10 + 20)).toBe('$0.30');
    expect(formatCents(70 + 5)).toBe('$0.75');
  });

  it('CHARACTERISATION: renders NaN as "$NaN"', () => {
    // Reported, not changed. `formatCurrency` below guards NaN and returns
    // "$0.00"; this one does not, so the same bad value renders two different
    // ways depending on which helper a component reached for.
    //
    // Deliberately left alone: showing "$0.00" for an amount that failed to
    // compute is arguably WORSE than showing "$NaN", because it reads as a
    // settled balance. Making them consistent means deciding which way, and that
    // is the owner's call. This test goes red when someone decides.
    expect(formatCents(Number.NaN)).toBe('$NaN');
  });
});

describe('formatCurrency', () => {
  it('takes DOLLARS, not cents', () => {
    // The whole hazard in one assertion. The two helpers differ by a factor of
    // 100, and confusing them turns a $12.34 invoice into $1,234.00.
    expect(formatCurrency(1234.5)).toBe('$1,234.50');
    expect(formatCents(1234)).toBe('$12.34');
  });

  it('always shows two decimal places', () => {
    // A dollars value arrives as a float, so 1234.5 must not render "$1,234.5".
    expect(formatCurrency(0)).toBe('$0.00');
    expect(formatCurrency(1234.5)).toBe('$1,234.50');
  });

  it('signs a negative amount the same way formatCents does', () => {
    // The two helpers appear side by side on the same screen. Different sign
    // placement between them looks like a rendering bug.
    expect(formatCurrency(-1234.5)).toBe('-$1,234.50');
  });

  it('renders a non-numeric amount as zero rather than crashing', () => {
    // The documented guard. An undefined field reaching this must not put the
    // literal "NaN" on an invoice.
    expect(formatCurrency(Number.NaN)).toBe('$0.00');
    expect(formatCurrency(undefined as unknown as number)).toBe('$0.00');
    expect(formatCurrency(null as unknown as number)).toBe('$0.00');
    expect(formatCurrency('12.34' as unknown as number)).toBe('$0.00');
  });

  it('CHARACTERISATION: does NOT guard Infinity', () => {
    // Reported, not changed. `isNaN` is false for Infinity, so the guard misses
    // it and the invoice renders the infinity glyph. Reachable through a divide
    // by a zero count, which is the shape a per-person split takes.
    expect(formatCurrency(Number.POSITIVE_INFINITY)).toBe('$∞');
  });
});

describe('parseMoneyInput', () => {
  // Red if a third decimal is accepted (the backend refuses it, so the person
  // would see a server error for a typo), or if a valid cents amount is
  // refused or altered.
  it('accepts whole dollars, one decimal and two decimals unchanged', () => {
    expect(parseMoneyInput('10')).toEqual({ amount: 10 });
    expect(parseMoneyInput('10.5')).toEqual({ amount: 10.5 });
    expect(parseMoneyInput('10.55')).toEqual({ amount: 10.55 });
    expect(parseMoneyInput(' 0.01 ')).toEqual({ amount: 0.01 });
  });

  it('refuses a third decimal place, including a trailing zero', () => {
    expect(parseMoneyInput('10.999')).toEqual({ error: 'Amounts can have at most two decimal places.' });
    expect(parseMoneyInput('0.005')).toEqual({ error: 'Amounts can have at most two decimal places.' });
    // Ambiguous enough to refuse rather than guess: 10.500 is "probably" 10.50,
    // but 10.505 is not, and one rule is easier to explain than two.
    expect(parseMoneyInput('10.500')).toEqual({ error: 'Amounts can have at most two decimal places.' });
  });

  it('refuses empty, zero, negative and non-numeric input', () => {
    expect(parseMoneyInput('')).toEqual({ error: 'Enter an amount greater than zero.' });
    expect(parseMoneyInput('0')).toEqual({ error: 'Enter an amount greater than zero.' });
    expect(parseMoneyInput('0.00')).toEqual({ error: 'Enter an amount greater than zero.' });
    expect(parseMoneyInput('-5')).toEqual({ error: 'Enter an amount greater than zero.' });
    expect(parseMoneyInput('abc')).toEqual({ error: 'Enter an amount greater than zero.' });
  });

  it('names the format, not the sign, when a positive number is not typed plainly', () => {
    const plain = { error: 'Enter the amount as a plain number, for example 1000.50.' };
    expect(parseMoneyInput('1,000.50')).toEqual(plain);
    expect(parseMoneyInput('1e3')).toEqual(plain);
    expect(parseMoneyInput('+5')).toEqual(plain);
  });
});

describe('parseSignedMoneyInput', () => {
  // For figures that can legitimately be negative or zero, such as a bank
  // statement balance or a reconciliation adjustment. Red if a sign is lost,
  // if zero is refused, or if any of the loose formats parseFloat accepted
  // ("12abc" as 12, "1e3" as 1000, a third decimal rounded away) gets through.
  it('accepts positive, negative and zero amounts with up to two decimals', () => {
    expect(parseSignedMoneyInput('1050.00')).toEqual({ amount: 1050 });
    expect(parseSignedMoneyInput('-250.5')).toEqual({ amount: -250.5 });
    expect(parseSignedMoneyInput(' -0.01 ')).toEqual({ amount: -0.01 });
    expect(parseSignedMoneyInput('.5')).toEqual({ amount: 0.5 });
    expect(parseSignedMoneyInput('-.5')).toEqual({ amount: -0.5 });
    expect(parseSignedMoneyInput('0')).toEqual({ amount: 0 });
  });

  it('reads negative zero as plain zero', () => {
    // Object.is, because toEqual treats -0 and 0 as equal.
    const parsed = parseSignedMoneyInput('-0.00');
    expect('amount' in parsed && Object.is(parsed.amount, 0)).toBe(true);
  });

  it('refuses a third decimal place on either sign', () => {
    expect(parseSignedMoneyInput('1.005')).toEqual({ error: 'Amounts can have at most two decimal places.' });
    expect(parseSignedMoneyInput('-12.345')).toEqual({ error: 'Amounts can have at most two decimal places.' });
  });

  it('refuses text, exponents, separators and stray signs instead of reading a number out of them', () => {
    const plain = { error: 'Enter the amount as a plain number, for example -1000.50.' };
    expect(parseSignedMoneyInput('12abc')).toEqual(plain);
    expect(parseSignedMoneyInput('1e3')).toEqual(plain);
    expect(parseSignedMoneyInput('1,000.50')).toEqual(plain);
    expect(parseSignedMoneyInput('+5')).toEqual(plain);
    expect(parseSignedMoneyInput('--5')).toEqual(plain);
    expect(parseSignedMoneyInput('-')).toEqual(plain);
    expect(parseSignedMoneyInput('.')).toEqual(plain);
  });

  it('refuses an empty amount', () => {
    expect(parseSignedMoneyInput('')).toEqual({ error: 'Enter an amount.' });
    expect(parseSignedMoneyInput('   ')).toEqual({ error: 'Enter an amount.' });
  });

  it('refuses a magnitude above the server maximum on either side of zero', () => {
    const tooLarge = { error: 'Enter an amount between -$1,000,000,000 and $1,000,000,000.' };
    expect(parseSignedMoneyInput('1000000000')).toEqual({ amount: 1_000_000_000 });
    expect(parseSignedMoneyInput('-1000000000')).toEqual({ amount: -1_000_000_000 });
    expect(parseSignedMoneyInput('1000000000.01')).toEqual(tooLarge);
    expect(parseSignedMoneyInput('-1000000000.01')).toEqual(tooLarge);
  });
});
