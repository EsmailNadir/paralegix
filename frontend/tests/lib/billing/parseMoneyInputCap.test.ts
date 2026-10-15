/**
 * parseMoneyInput refuses amounts above the server's MAX_MONEY_AMOUNT.
 */
import { parseMoneyInput } from '@/lib/utils/currency';

it.each(['1000000000.01', '99999999999.99', '123456789012345678.99'])(
  'refuses %s, which the server would refuse',
  (text) => {
    expect(parseMoneyInput(text)).toHaveProperty('error');
  },
);
