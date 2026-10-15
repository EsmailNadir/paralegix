/**
 * A percentage late fee is rounded half up in integer arithmetic. Pure function, no database.
 */
import { computeLateFeeCents } from '../../../src/modules/billing/invoices/invoices.service';

it.each([[3000, 7.25, 218], [10000, 9.975, 998], [6200, 7.25, 450]])(
  'late fee on %p remaining cents at %p%% is %p cents',
  (remaining, percent, want) => {
    expect(computeLateFeeCents(remaining, { enabled: true, percent })).toBe(want);
  },
);
