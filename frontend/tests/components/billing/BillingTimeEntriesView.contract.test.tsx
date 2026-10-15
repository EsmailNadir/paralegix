/**
 * Select-all and bulk delete on the firm Billing > Time entries tab, as a load
 * and honesty contract rather than a rendering one.
 *
 * SELECT-ALL. `GET .../billing/time-entries/firm` used to answer a request with
 * no `limit` by returning every matching row. It now clamps to 200 and reports
 * `truncated: true` when it withheld rows, while `totalItems` and `summary`
 * still describe the whole match set. The tab's select-all deliberately sent no
 * `limit`, so a firm with more than 200 matching entries silently selected 200
 * while the control read "select all 1,250", and the user then bulk-invoiced or
 * bulk-deleted that unannounced subset. The count the control shows after
 * select-all must equal the number of entries a bulk action then acts on, so
 * every select-all case asserts the REQUEST COUNT alongside the rendering: the
 * only way to hold that property against an endpoint that clamps is to page for
 * the rest, one request at a time, up to a stated cap.
 *
 * BULK DELETE. `confirmBulkDelete` sent one DELETE per selected row. Bounding
 * that fan-out to four at a time stopped it draining the pool in a burst, but
 * the round trips were still one per row: the select-all ceiling on this tab is
 * 1,000 entries, so a select-all-then-delete was a thousand requests against an
 * API instance that holds twelve Postgres connections for the whole firm.
 * `POST /billing/time-entries/bulk-delete` is one request for the whole
 * selection, and it answers per entry, so the honest partial report survives.
 *
 * WHAT BREAKS THESE:
 *  - a regression to a single unbounded select-all read fails both the count
 *    and the bound;
 *  - restore the per-entry delete loop (`runBulkRequests` over
 *    `deleteTimeEntry`) and the bulk-delete case sees DELETEs and no bulk POST;
 *  - read `deleted` instead of `failed` to decide what stays selected and the
 *    partial case leaves the wrong rows ticked;
 *  - drop the `errors`/`failed` plumbing and the message goes back to a generic
 *    one that never says how many rows DID go;
 *  - skip the reload and the list keeps showing rows the server no longer has.
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import BillingTimeEntriesView from '@/components/billingComp/BillingTimeEntriesView';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installApiMock, type ApiMock, type RecordedCall } from '../../support/apiMock';
import {
  BULK_DELETE,
  FIRM_TIME_ENTRIES,
  answerBulkDelete,
  bulkDeleteAnswer,
  bulkDeleteIds,
  makeTimeEntries,
  serveFirmTimeEntries,
} from '../../support/fixtures/timeEntries';
import {
  FIRM_BILLING_MAX_LIMIT,
  FIRM_TIME_ENTRY_SELECT_ALL_CEILING,
  FIRM_TIME_ENTRY_SELECT_ALL_MAX_PAGES,
} from '@/services/billing.service';

const SELECTED = 30;

let api: ApiMock;

function renderView() {
  return renderWithProviders(
    <BillingTimeEntriesView
      lawFirmId="firm-1"
      users={[]}
      onAddTimeEntry={jest.fn()}
      onBillNow={jest.fn()}
      onBatchBillNow={jest.fn()}
      canManage
    />,
  );
}

/** Click the whole-set select-all control and wait for it to stop spinning. */
async function clickSelectAll(user: ReturnType<typeof userEvent.setup>) {
  const control = await screen.findByRole('checkbox', { name: /^Select all/ });
  await user.click(control);
  await waitFor(() => expect(screen.queryByText('Selecting…')).not.toBeInTheDocument());
}

/** Select every matching entry, then open the bulk menu and confirm the delete. */
async function selectAllAndConfirmDelete(
  user: ReturnType<typeof userEvent.setup>,
  count: number,
) {
  await screen.findByRole('checkbox', { name: `Select all ${count} time entries` });
  await clickSelectAll(user);
  await screen.findByRole('checkbox', { name: `${count} selected` });

  // `ListView` renders its trailing strip twice, once per breakpoint, so the
  // bulk menu trigger has a mobile and a desktop copy. Either drives the same
  // selection.
  await user.click(screen.getAllByRole('button', { name: `${count} selected` })[0]);
  await user.click(await screen.findByRole('button', { name: `Delete ${count}` }));
  await user.click(await screen.findByRole('button', { name: 'Delete' }));
}

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  api.restore();
});

describe('BillingTimeEntriesView select-all', () => {
  it('selects every matching entry in ONE bounded request when the firm is under the ceiling', async () => {
    const user = userEvent.setup();
    api.get(FIRM_TIME_ENTRIES, serveFirmTimeEntries(makeTimeEntries(150)));

    renderView();
    await screen.findByRole('checkbox', { name: 'Select all 150 time entries' });
    const beforeSelectAll = api.callsTo(FIRM_TIME_ENTRIES).length;

    await clickSelectAll(user);

    // The whole set, and the control says so without qualification.
    await screen.findByRole('checkbox', { name: '150 selected' });

    const selectAllReads = api.callsTo(FIRM_TIME_ENTRIES).slice(beforeSelectAll);
    expect(selectAllReads).toHaveLength(1);
    // Bounded on the way out. Sending no `limit` is what the endpoint answers
    // with a silent 200-row clamp, so the read must name the window it wants
    // even when one page covers the whole match set.
    expect(selectAllReads[0].query.limit).toEqual([String(FIRM_BILLING_MAX_LIMIT)]);
    expect(selectAllReads[0].query.page).toEqual(['1']);
  });

  it('pages one request at a time to at most 5 reads over the ceiling, and states what the selection covers', async () => {
    const user = userEvent.setup();
    const total = FIRM_TIME_ENTRY_SELECT_ALL_CEILING + 250;
    api.get(FIRM_TIME_ENTRIES, serveFirmTimeEntries(makeTimeEntries(total)));

    renderView();
    await screen.findByRole('checkbox', { name: `Select all ${total} time entries` });
    const beforeSelectAll = api.callsTo(FIRM_TIME_ENTRIES).length;

    await clickSelectAll(user);

    // The count is what was actually gathered, stated against the real total, so
    // the user cannot read it as "all of them".
    await screen.findByRole('checkbox', {
      name: `${FIRM_TIME_ENTRY_SELECT_ALL_CEILING} of ${total} selected`,
    });
    expect(
      screen.getByText(/more matching time entries than we could select at once/i),
    ).toBeInTheDocument();

    const selectAllReads = api.callsTo(FIRM_TIME_ENTRIES).slice(beforeSelectAll);
    // Capped, and sequential: one page per request, never a fan-out. A firm-wide
    // burst would contend for the instance's twelve Postgres connections.
    expect(selectAllReads).toHaveLength(FIRM_TIME_ENTRY_SELECT_ALL_MAX_PAGES);
    expect(selectAllReads.map((call) => call.query.page?.[0])).toEqual(['1', '2', '3', '4', '5']);
    for (const call of selectAllReads) {
      expect(call.query.limit).toEqual([String(FIRM_BILLING_MAX_LIMIT)]);
    }
  });
});

describe('BillingTimeEntriesView select-all then Bill', () => {
  it('hands an entry the route sent without a numeric rate to billing with no rate, not a zero one', async () => {
    const user = userEvent.setup();
    const onBatchBillNow = jest.fn();
    // Twelve entries, so the unrated one sits past the first page and reaches the
    // selection only through select-all's own read.
    const entries = makeTimeEntries(12);
    entries[11] = { ...entries[11], hourlyRate: '250' as unknown as number };
    api.get(FIRM_TIME_ENTRIES, serveFirmTimeEntries(entries));

    renderWithProviders(
      <BillingTimeEntriesView
        lawFirmId="firm-1"
        users={[]}
        onAddTimeEntry={jest.fn()}
        onBillNow={jest.fn()}
        onBatchBillNow={onBatchBillNow}
        canManage
      />,
    );
    await screen.findByRole('checkbox', { name: 'Select all 12 time entries' });
    await clickSelectAll(user);
    await screen.findByRole('checkbox', { name: '12 selected' });

    await user.click(screen.getAllByRole('button', { name: 'Bill 12' })[0]);

    expect(onBatchBillNow).toHaveBeenCalledTimes(1);
    const billed = onBatchBillNow.mock.calls[0][0] as Array<{ id: string; hourlyRate: number | null }>;
    expect(billed).toHaveLength(12);
    expect(billed.find((entry) => entry.id === 'entry-0')?.hourlyRate).toBe(200);
    expect(billed.find((entry) => entry.id === 'entry-11')?.hourlyRate).toBeNull();
  });
});

describe('BillingTimeEntriesView bulk delete', () => {
  it('sends one request carrying exactly the ids the count promised, including the ones past the first page', async () => {
    const user = userEvent.setup();
    const entries = makeTimeEntries(FIRM_BILLING_MAX_LIMIT + 5);
    api.get(FIRM_TIME_ENTRIES, serveFirmTimeEntries(entries));
    api.post(BULK_DELETE, answerBulkDelete());

    renderView();
    await selectAllAndConfirmDelete(user, entries.length);

    // One request for the whole selection, whatever page each id came from, and
    // none of the per-entry DELETEs the panel used to send.
    await waitFor(() => expect(api.callsTo(BULK_DELETE)).toHaveLength(1));
    expect(api.calls('DELETE')).toHaveLength(0);
    // Exactly the selected set: the 5 entries that only a second page could
    // reach are deleted, and nothing outside the selection is touched.
    const sent = bulkDeleteIds(api);
    expect(new Set(sent)).toEqual(new Set(entries.map((entry) => entry.id)));
    expect(sent).toHaveLength(entries.length);
  });

  it('names what it is deleting while the request is still in flight', async () => {
    const user = userEvent.setup();
    api.get(FIRM_TIME_ENTRIES, serveFirmTimeEntries(makeTimeEntries(SELECTED)));

    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    api.post(BULK_DELETE, async (call: RecordedCall) => {
      await held;
      return bulkDeleteAnswer((call.body as { timeEntryIds: string[] }).timeEntryIds);
    });

    renderView();
    await selectAllAndConfirmDelete(user, SELECTED);

    // One request has no per-item progress to count, so the dialog states what
    // is happening and to how many rows rather than a number that would never
    // move. Not the question it opened with: "Delete 30 time entries?" beside a
    // spinner reads as though the click had not registered.
    await screen.findByText(`Deleting ${SELECTED} time entries…`);
    expect(screen.queryByText(`Delete ${SELECTED} time entries? This cannot be undone.`))
      .not.toBeInTheDocument();

    release();
    await waitFor(() => expect(api.callsTo(BULK_DELETE)).toHaveLength(1));
  });

  it('reports a partial run honestly, keeps the failures selected, and reloads the list', async () => {
    const user = userEvent.setup();
    const entries = makeTimeEntries(SELECTED);
    api.get(FIRM_TIME_ENTRIES, serveFirmTimeEntries(entries));

    const doomed = ['entry-0', 'entry-7', 'entry-21'];
    api.post(BULK_DELETE, answerBulkDelete(doomed));

    renderView();
    const readsBeforeDelete = api.callsTo(FIRM_TIME_ENTRIES).length;
    await selectAllAndConfirmDelete(user, SELECTED);

    // Every id was still offered. The route decides per entry, so a refusal is
    // reported rather than cancelling the other twenty-seven.
    await waitFor(() => expect(api.callsTo(BULK_DELETE)).toHaveLength(1));
    expect(new Set(bulkDeleteIds(api))).toEqual(new Set(entries.map((e) => e.id)));

    // Both numbers, not a bare "Failed to delete entries" and not silence.
    await screen.findByText(
      `${SELECTED - doomed.length} of ${SELECTED} time entries deleted. ${doomed.length} could not be deleted and stayed selected.`,
    );

    // The 27 that went through really are gone, so the list has to be re-read
    // rather than left showing rows the server no longer has.
    await waitFor(() =>
      expect(api.callsTo(FIRM_TIME_ENTRIES).length).toBeGreaterThan(readsBeforeDelete + 1),
    );

    // Only the failures stay selected, so retrying is one more click and cannot
    // re-send a delete that already succeeded.
    await screen.findByRole('checkbox', { name: `${doomed.length} selected` });
  });

  it('says so plainly when nothing could be deleted', async () => {
    const user = userEvent.setup();
    api.get(FIRM_TIME_ENTRIES, serveFirmTimeEntries(makeTimeEntries(4)));
    api.post(BULK_DELETE, answerBulkDelete((ids) => ids));

    renderView();
    await selectAllAndConfirmDelete(user, 4);

    await waitFor(() => expect(api.callsTo(BULK_DELETE)).toHaveLength(1));
    // No "4 of 4 deleted" arithmetic when the answer is none of them.
    await screen.findByText('None of the 4 time entries could be deleted.');
    await screen.findByRole('checkbox', { name: '4 selected' });
  });

  it('keeps the whole selection when the request itself fails', async () => {
    const user = userEvent.setup();
    api.get(FIRM_TIME_ENTRIES, serveFirmTimeEntries(makeTimeEntries(4)));
    api.post(BULK_DELETE, { status: 500, body: { error: 'Server error' } });

    renderView();
    await selectAllAndConfirmDelete(user, 4);

    // A request that never reached a decision deleted nothing, so every row
    // stays ticked and ready to retry. Silently clearing the selection here
    // would read as a successful delete.
    await screen.findByText('Server error');
    await screen.findByRole('checkbox', { name: '4 selected' });
  });
});
