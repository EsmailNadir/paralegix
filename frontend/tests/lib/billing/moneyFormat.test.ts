/**
 * Money formatting and typed-amount parsing, checked against integer-cent
 * oracles and against the backend's whole-cent rule.
 *
 * The backend refuses an amount unless its shortest decimal text is at most two
 * decimals (`isWholeCents`, backend/src/modules/billing/shared/moneyInput.ts)
 * and at most MAX_MONEY_AMOUNT. `backendAccepts` restates that rule so a typed
 * string can be compared with what the server would say about the number the
 * parser produced.
 */
import { centsToDollars, formatCents, formatCurrency, parseMoneyInput } from '@/lib/utils/currency';

const MAX_MONEY_AMOUNT = 1_000_000_000;

function backendAccepts(amount: number): boolean {
  return /^\d+(\.\d{1,2})?$/.test(String(amount)) && amount >= 0.01 && amount <= MAX_MONEY_AMOUNT;
}

/** The exact dollars text for a whole-cent integer, with thousands separators. */
function expectedDollarText(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${whole}.${String(abs % 100).padStart(2, '0')}`;
}

describe('formatCents and formatCurrency agree on every whole-cent amount', () => {
  const cents = [
    0, 1, 5, 9, 10, 29, 57, 99, 100, 101, 110, 115, 1_999, 99_999, 100_000, 123_456_789,
    100_000_000_000, 450_359_962_737_049, 900_719_925_474_099,
  ];
  it.each(cents)('renders %p cents as the exact dollars text, positive and negative', (c) => {
    expect(formatCents(c)).toBe(expectedDollarText(c));
    expect(formatCents(-c === 0 ? 0 : -c)).toBe(c === 0 ? '$0.00' : expectedDollarText(-c));
    expect(formatCurrency(c / 100)).toBe(expectedDollarText(c));
  });

  it('renders 5000 seeded whole-cent amounts identically through both helpers', () => {
    let a = 123456789;
    const next = () => {
      a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
      return a / 4294967296;
    };
    for (let i = 0; i < 5000; i += 1) {
      const c = Math.floor(next() * 10 ** (1 + (i % 14)));
      expect(formatCents(c)).toBe(expectedDollarText(c));
      expect(formatCurrency(c / 100)).toBe(expectedDollarText(c));
      expect(centsToDollars(c)).toBe(`${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`);
    }
  });

  it('shows float dust from a dollar sum as the exact cents', () => {
    expect(formatCurrency(0.1 + 0.2)).toBe('$0.30');
    expect(formatCurrency(1.1 * 3)).toBe('$3.30');
    expect(formatCurrency(0.07 * 100)).toBe('$7.00');
    expect(formatCurrency(4503599627370.49)).toBe('$4,503,599,627,370.49');
    expect(formatCurrency(9007199254740.99)).toBe('$9,007,199,254,740.99');
  });

  it('formats a half cent, a zero and a non-number the documented way', () => {
    expect(formatCurrency(0.005)).toBe('$0.01');
    expect(formatCurrency(0.125)).toBe('$0.13');
    expect(formatCurrency(0)).toBe('$0.00');
    expect(formatCurrency(Number.NaN)).toBe('$0.00');
    expect(formatCurrency(undefined as unknown as number)).toBe('$0.00');
    expect(formatCurrency('12.5' as unknown as number)).toBe('$0.00');
  });
});

describe('parseMoneyInput against the backend whole-cent rule', () => {
  const table: Array<[string, number | null]> = [
    ['0.01', 0.01], ['0.1', 0.1], ['.5', 0.5], ['1.', 1], ['5', 5], ['12.30', 12.3],
    ['1000', 1000], ['33.33', 33.33], ['1234567.89', 1234567.89], ['1000000000', 1_000_000_000],
    ['999999999.99', 999_999_999.99], ['0099.10', 99.1], ['  7.25  ', 7.25],
    ['0', null], ['0.00', null], ['-5', null], ['-0.01', null], ['+5', null], ['1e3', null],
    ['1,000.50', null], ['$5', null], ['5.123', null], ['0.001', null], ['0.005', null],
    ['', null], ['.', null], ['abc', null], ['1.2.3', null], ['١٢٣', null],
  ];

  it.each(table)('reads %j as %p', (raw, expected) => {
    const result = parseMoneyInput(raw);
    if (expected === null) {
      expect(result).toHaveProperty('error');
    } else {
      expect(result).toEqual({ amount: expected });
    }
  });

  it('only ever returns an amount the backend would store as exactly the typed cents', () => {
    for (const [raw, expected] of table) {
      if (expected === null) continue;
      const result = parseMoneyInput(raw);
      if (!('amount' in result)) throw new Error(`${raw} refused`);
      expect(backendAccepts(result.amount)).toBe(true);
      const typed = raw.trim().replace(/^\./, '0.').replace(/\.$/, '');
      const typedCents = Math.round(Number(typed) * 100);
      expect(Math.round(result.amount * 100)).toBe(typedCents);
    }
  });

  it('agrees with the backend on 20000 seeded two-decimal strings', () => {
    let a = 987654321;
    const next = () => {
      a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
      return a / 4294967296;
    };
    for (let i = 0; i < 20_000; i += 1) {
      const cents = 1 + Math.floor(next() * 10 ** (2 + (i % 9)));
      const text = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
      const result = parseMoneyInput(text);
      if (!('amount' in result)) throw new Error(`${text} refused`);
      expect({ text, ok: backendAccepts(result.amount), cents: Math.round(result.amount * 100) })
        .toEqual({ text, ok: cents <= MAX_MONEY_AMOUNT * 100, cents });
    }
  });

  it('refuses a third decimal exactly when the backend would', () => {
    for (const text of ['0.001', '0.009', '1.005', '10.999', '99.9999']) {
      expect(parseMoneyInput(text)).toHaveProperty('error');
      expect(backendAccepts(Number(text))).toBe(false);
    }
    // A trailing zero in the third place is a third decimal as typed, so refused,
    // even though the number itself would be whole cents.
    expect(parseMoneyInput('1.100')).toHaveProperty('error');
    expect(backendAccepts(Number('1.100'))).toBe(true);
  });
});
