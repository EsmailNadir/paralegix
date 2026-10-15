/**
 * LIVE smoke test of the data hooks against a running backend: each hook loads
 * through React Query with a real token and settles without an error.
 *
 * The offline `.contract.test.tsx` suites pin these hooks' behaviour; this only
 * proves the real endpoints still answer them. Excluded from `npm test`; run
 * with `npm run test:integration` (see `tests/services/README.md`).
 */
jest.mock('@/lib/utils/auth', () =>
  jest.requireActual('../support/liveAuth').liveAuthUtilsModule());

import { renderHook, waitFor } from '@testing-library/react';
import useBillingWorkbench from '@/hooks/billingHooks/useBillingWorkbench';
import { useLawfirmTasks } from '@/hooks/taskHooks/useTasks';
import useTrustAccounts from '@/hooks/trustHooks/useTrustAccounts';
import useTrustTransactions from '@/hooks/trustHooks/useTrustTransactions';
import { createQueryWrapper } from '../support/queryWrapper';
import { resolveTestFirmId } from '../services/_firm';

let lawFirmId: string;

beforeAll(async () => {
  // Not `lawFirmIds[0]`: the test account belongs to two firms and the first is
  // a legacy one whose role lacks newer permissions, so it 403s. See _firm.ts.
  lawFirmId = await resolveTestFirmId();
});

const LIST_HOOKS = [
  { name: 'useLawfirmTasks', useListHook: useLawfirmTasks as (id: string) => any, rows: (r: any) => r.tasks },
  { name: 'useTrustAccounts', useListHook: useTrustAccounts as (id: string) => any, rows: (r: any) => r.accounts },
  { name: 'useTrustTransactions', useListHook: useTrustTransactions as (id: string) => any, rows: (r: any) => r.transactions },
];

it.each(LIST_HOOKS)('$name loads a list from the live backend', async ({ useListHook, rows }) => {
  const { result } = renderHook(() => useListHook(lawFirmId), { wrapper: createQueryWrapper() });

  await waitFor(() => {
    expect(result.current.loading).toBe(false);
  });

  expect(result.current.error).toBeNull();
  expect(Array.isArray(rows(result.current))).toBe(true);
});

it('useBillingWorkbench loads the workbench from the live backend', async () => {
  const { result } = renderHook(() => useBillingWorkbench(lawFirmId), { wrapper: createQueryWrapper() });

  await waitFor(() => {
    expect(result.current.isLoading).toBe(false);
  }, { timeout: 15000 });

  expect(result.current.isError).toBe(false);
  expect(result.current.data).toEqual(expect.any(Object));
});
