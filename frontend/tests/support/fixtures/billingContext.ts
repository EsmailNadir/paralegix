/**
 * Stand-ins for the billing hooks and context that every time-entry panel
 * reads but few specs are about: the floating timer, the charge-code list, and
 * the paged time-entry table.
 *
 * The `*Module` builders are `jest.mock` factories. `jest.mock` is hoisted
 * above the file's imports, so reach them through `require` inside the factory:
 *
 *   jest.mock('@/contexts/BillingTimerContext', () =>
 *     require('../../support/fixtures/billingContext').idleBillingTimerModule());
 */

/** The timer context with nothing running, in the shape `useBillingTimer` returns. */
export function billingTimerState(overrides: Record<string, unknown> = {}) {
  return {
    isActive: false,
    isRunning: false,
    matterId: null as string | null,
    clientId: null as string | null,
    targetLabel: '',
    formattedTime: '00:00:00',
    description: '',
    startTimer: jest.fn(),
    pauseTimer: jest.fn(),
    resumeTimer: jest.fn(),
    stopTimer: jest.fn(),
    discardTimer: jest.fn(),
    updateTimerDescription: jest.fn(),
    setFloatingSuppressed: jest.fn(),
    ...overrides,
  };
}

/** `@/contexts/BillingTimerContext` with no timer running. */
export function idleBillingTimerModule() {
  const state = billingTimerState();
  return { __esModule: true, useBillingTimer: () => state };
}

/** `@/hooks/chargeCodeHooks/useChargeCodes` with a firm that has none. */
export function noChargeCodesModule() {
  return { __esModule: true, default: () => ({ chargeCodes: [], loading: false }) };
}

/** What `useFirmTimeEntriesTable` returns: an empty, settled first page. */
export function firmTimeEntriesTableState(overrides: Record<string, unknown> = {}) {
  return {
    rows: [] as unknown[],
    total: 0,
    summary: { totalHours: 0, totalAmount: 0 },
    loading: false,
    fetching: false,
    error: null,
    page: 1,
    setPage: jest.fn(),
    rowsPerPage: 10,
    setRowsPerPage: jest.fn(),
    sortModel: [],
    filters: {},
    setFilter: jest.fn(),
    clearFilters: jest.fn(),
    handleRequestSort: jest.fn(),
    refetch: jest.fn(),
    ...overrides,
  };
}
