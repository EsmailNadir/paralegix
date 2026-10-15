/**
 * Time-entry rows and the bulk-delete route, as the contract specs for the
 * three time-entry panels (firm Billing tab, matter Time Tracking, client
 * Billing) serve and read them over `apiMock`.
 */
import { screen, within } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';

import type { ApiMock, RecordedCall } from '../apiMock';

export const FIRM_TIME_ENTRIES = '/billing/time-entries/firm';
export const BULK_DELETE = '/billing/time-entries/bulk-delete';

/**
 * The route clamps a read that names no `limit` to this. Read from the real
 * module because `tests/setup.ts` replaces `billing.service` with a stub.
 */
const ROUTE_ROW_CEILING: number = jest.requireActual<typeof import('@/services/billing.service')>(
  '@/services/billing.service',
).FIRM_BILLING_MAX_LIMIT;

/** One unbilled, deletable matter entry as the firm time-entry route returns it. */
export function timeEntryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'entry-0',
    matterId: 'matter-1',
    matterName: 'Smith v. Jones',
    clientId: 'client-1',
    clientName: 'Jane Smith',
    clientNames: [] as string[],
    userName: 'Pat Attorney',
    date: '2026-09-01',
    hours: 1,
    hourlyRate: 200,
    amount: 200,
    billable: true,
    billingStatus: 'unbilled',
    contextType: 'matter',
    ...overrides,
  };
}

export type TimeEntryRow = ReturnType<typeof timeEntryRow>;

/** `count` rows with ids `entry-0` .. `entry-{count-1}`. */
export function makeTimeEntries(count: number, overrides: Record<string, unknown> = {}) {
  return Array.from({ length: count }, (_, i) => timeEntryRow({ ...overrides, id: `entry-${i}` }));
}

/**
 * The firm time-entry route as the backend behaves: a `limit` is served as
 * that window of `page`, and NO `limit` is clamped to the ceiling with
 * `truncated` set when rows were withheld. `totalItems` and `summary` always
 * describe the whole match set.
 */
export function serveFirmTimeEntries(entries: TimeEntryRow[]) {
  return (call: RecordedCall) => {
    const requestedLimit = call.query.limit?.[0];
    const limit = requestedLimit ? Number(requestedLimit) : ROUTE_ROW_CEILING;
    const page = Number(call.query.page?.[0] ?? '1');
    const window = entries.slice((page - 1) * limit, (page - 1) * limit + limit);
    return {
      timeEntries: window,
      totalItems: entries.length,
      summary: { totalHours: entries.length, totalAmount: entries.length * 200 },
      truncated: requestedLimit == null && entries.length > window.length,
    };
  };
}

/** What the bulk-delete route answers when the `failed` ids were refused per entry. */
export function bulkDeleteAnswer(requestedIds: string[], failed: string[] = []) {
  return {
    message: 'Bulk delete completed',
    requested: requestedIds.length,
    deleted: requestedIds.length - failed.length,
    failed,
    errors: Object.fromEntries(
      failed.map((id) => [id, 'Cannot delete a time entry that has been billed on an invoice']),
    ),
  };
}

/**
 * A bulk-delete handler that refuses `failed` (or, given a function, whichever
 * of the requested ids it picks) and deletes the rest.
 */
export function answerBulkDelete(failed: string[] | ((ids: string[]) => string[]) = []) {
  return (call: RecordedCall) => {
    const ids = (call.body as { timeEntryIds: string[] }).timeEntryIds;
    return bulkDeleteAnswer(ids, typeof failed === 'function' ? failed(ids) : failed);
  };
}

/** The ids the first bulk-delete request carried. */
export function bulkDeleteIds(api: ApiMock): string[] {
  return (api.callsTo(BULK_DELETE)[0]?.body as { timeEntryIds?: string[] })?.timeEntryIds ?? [];
}

/**
 * Run Delete from the bulk menu of `EntityTimeEntriesTab` (the matter and
 * client panels) once `count` rows are ticked, and confirm it.
 */
export async function confirmEntityBulkDelete(
  user: ReturnType<typeof userEvent.setup>,
  count: number,
) {
  // `ListView` renders its trailing strip once per breakpoint, so the bulk menu
  // trigger has a mobile and a desktop copy driving the same selection.
  await user.click(screen.getAllByRole('button', { name: `${count} selected` })[0]);
  await user.click(await screen.findByRole('button', { name: `Delete (${count})` }));
  // Scoped to the dialog: every row carries its own "Delete" icon button.
  const dialog = await screen.findByRole('dialog', { name: 'Delete time entries' });
  await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
}
