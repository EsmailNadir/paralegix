/**
 * Bulk delete on the matter detail page's Time Tracking panel.
 *
 * THE DEFECT THIS PINS. `confirmBulkDelete` sent one DELETE per selected row.
 * Bounding that fan-out stopped it draining the twelve-connection pool in a
 * burst, but the round trips were still one per row.
 * `POST /billing/time-entries/bulk-delete` is one request for the whole
 * selection, and it answers per entry, so the honest partial report survives.
 *
 * LOCKED ROWS. `confirmBulkDelete` also used to hand every selected id to the
 * delete call, including rows the panel itself draws with a disabled Delete
 * button because their time has reached an invoice. The server refuses those,
 * so the run reported the refusal back as a failure: "9 of 10 deleted, 1 could
 * not be deleted", about a row that was never deletable. Both sibling panels
 * filter those rows out before sending by the same rule, `isTimeEntryLocked`
 * (a billing status that is set and is not "unbilled"). See
 * `billingComp/BillingTimeEntriesView` (`deletableSelected`) and
 * `clientComp/ClientBillingTimeEntriesSection` (`deletable`).
 *
 * This panel and `ClientBillingTimeEntriesSection` both delegate to
 * `EntityTimeEntriesTab.confirmBulkDelete`, so the single-request and
 * in-flight properties are asserted here for both; the client spec keeps what
 * its adapter decides differently.
 *
 * `billing.service` and the transport under it are real, so the delete urls
 * and the sentence the user reads both execute.
 *
 * WHAT BREAKS THESE: restoring the per-entry loop sends ten DELETEs and no bulk
 * POST; reading `deleted` instead of `failed` leaves the wrong rows ticked;
 * dropping the `errors` plumbing loses both halves of the count; dropping the
 * `isTimeEntryLocked` filter sends the locked row's id; and reporting the
 * skipped rows as failures loses the read-only notice.
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/requestDeduplicator');

jest.mock('@/contexts/BillingTimerContext', () =>
  require('../../support/fixtures/billingContext').idleBillingTimerModule());

jest.mock('@/hooks/chargeCodeHooks/useChargeCodes', () =>
  require('../../support/fixtures/billingContext').noChargeCodesModule());

import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import TimeTracking from '@/components/matterComp/TimeTracking';
import type { BillingContext } from '@/types/billing';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installApiMock, type ApiMock, type RecordedCall } from '../../support/apiMock';
import { resetPermissions } from '../../support/permissions';
import {
  BULK_DELETE,
  FIRM_TIME_ENTRIES,
  answerBulkDelete,
  bulkDeleteAnswer,
  bulkDeleteIds,
  confirmEntityBulkDelete,
  makeTimeEntries,
  serveFirmTimeEntries,
  timeEntryRow,
  type TimeEntryRow,
} from '../../support/fixtures/timeEntries';

/** One full page of the panel's default 10 rows per page. */
const PAGE_SIZE = 10;

const CONTEXT: BillingContext = {
  type: 'matter',
  entityId: 'matter-1',
  lawFirmId: 'firm-1',
};

let api: ApiMock;

/**
 * The list asks the server for `unbilled,queued,covered_by_retainer`. Only
 * `billed` (on an invoice) is locked, which is the server's own rule, so a
 * `queued` or `covered_by_retainer` row is sent like an unbilled one.
 */
const entry = (id: string, billingStatus: string) => timeEntryRow({ id, billingStatus });

function renderPanel() {
  return renderWithProviders(
    <TimeTracking
      context={CONTEXT}
      members={[]}
      users={[]}
      matterName="Smith v. Jones"
    />,
  );
}

/** Tick the page's select-all box, then run Delete from the bulk menu. */
async function selectPageAndConfirmDelete(
  user: ReturnType<typeof userEvent.setup>,
  count: number,
) {
  await user.click(await screen.findByRole('checkbox', { name: `Select all ${count}` }));
  await confirmEntityBulkDelete(user, count);
}

function serve(entries: TimeEntryRow[]) {
  api.get(FIRM_TIME_ENTRIES, serveFirmTimeEntries(entries));
}

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  resetPermissions();
  api.restore();
});

describe('TimeTracking bulk delete', () => {
  it('sends one request carrying every selected id, not one request per entry', async () => {
    const user = userEvent.setup();
    const entries = makeTimeEntries(PAGE_SIZE);
    serve(entries);
    api.post(BULK_DELETE, answerBulkDelete());

    renderPanel();
    await selectPageAndConfirmDelete(user, PAGE_SIZE);

    await waitFor(() => expect(api.callsTo(BULK_DELETE)).toHaveLength(1));
    expect(api.calls('DELETE')).toHaveLength(0);
    expect(new Set(bulkDeleteIds(api))).toEqual(new Set(entries.map((e) => e.id)));
  });

  it('reports a partial run with both counts and keeps only the failures selected', async () => {
    const user = userEvent.setup();
    const entries = makeTimeEntries(PAGE_SIZE);
    serve(entries);

    const doomed = ['entry-2', 'entry-5'];
    api.post(BULK_DELETE, answerBulkDelete(doomed));

    renderPanel();
    await selectPageAndConfirmDelete(user, PAGE_SIZE);

    // Every id was still offered. The route decides per entry, so a refusal is
    // reported rather than cancelling the other eight.
    await waitFor(() => expect(api.callsTo(BULK_DELETE)).toHaveLength(1));
    expect(new Set(bulkDeleteIds(api))).toEqual(new Set(entries.map((e) => e.id)));

    await screen.findByText(
      `${PAGE_SIZE - doomed.length} of ${PAGE_SIZE} time entries deleted. ${doomed.length} could not be deleted and stayed selected.`,
    );
    // The eight that went are deselected; the two that failed are still there
    // to retry, and the bulk menu says so.
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: `${doomed.length} selected` }).length)
        .toBeGreaterThan(0),
    );
  });

  it('says so plainly when nothing could be deleted', async () => {
    const user = userEvent.setup();
    serve(makeTimeEntries(3));
    api.post(BULK_DELETE, answerBulkDelete((ids) => ids));

    renderPanel();
    await selectPageAndConfirmDelete(user, 3);

    await waitFor(() => expect(api.callsTo(BULK_DELETE)).toHaveLength(1));
    await screen.findByText('None of the 3 time entries could be deleted.');
  });

  it('names what it is deleting while the request is still in flight', async () => {
    const user = userEvent.setup();
    serve(makeTimeEntries(PAGE_SIZE));

    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    api.post(BULK_DELETE, async (call: RecordedCall) => {
      await held;
      return bulkDeleteAnswer((call.body as { timeEntryIds: string[] }).timeEntryIds);
    });

    renderPanel();
    await selectPageAndConfirmDelete(user, PAGE_SIZE);

    // One request has no per-item progress to count, so the dialog states what
    // is happening and to how many rows. Leaving the question up beside a
    // spinner reads as though the click had not registered.
    await screen.findByText(`Deleting ${PAGE_SIZE} time entries…`);

    release();
    await waitFor(() => expect(api.callsTo(BULK_DELETE)).toHaveLength(1));
  });
});

describe('TimeTracking bulk delete over locked rows', () => {
  it('counts several skipped rows in the plural', async () => {
    const user = userEvent.setup();
    const entries = [
      entry('open-1', 'unbilled'),
      entry('locked-1', 'billed'),
      entry('locked-2', 'billed'),
    ];
    serve(entries);
    api.post(BULK_DELETE, answerBulkDelete());

    renderPanel();
    await selectPageAndConfirmDelete(user, entries.length);

    await waitFor(() => expect(api.callsTo(BULK_DELETE)).toHaveLength(1));
    expect(bulkDeleteIds(api)).toEqual(['open-1']);
    await screen.findByText('2 billed entries are read-only and were not deleted.');
  });

  it('sends only the unlocked ids and keeps the skipped row out of the failure count', async () => {
    const user = userEvent.setup();
    const entries = [
      entry('open-1', 'unbilled'),
      entry('open-2', 'unbilled'),
      entry('locked-1', 'billed'),
    ];
    serve(entries);
    api.post(BULK_DELETE, answerBulkDelete(['open-2']));

    renderPanel();
    await selectPageAndConfirmDelete(user, entries.length);

    // The locked row's id is never sent. Selecting it does not make it
    // deletable, and asking the server about it could only ever produce a
    // refusal.
    await waitFor(() => expect(api.callsTo(BULK_DELETE)).toHaveLength(1));
    expect(new Set(bulkDeleteIds(api))).toEqual(new Set(['open-1', 'open-2']));

    // Two counts that mean different things: one row was refused, one was never
    // offered. Counting the locked row as an attempt would read "1 of 3".
    const notice = await screen.findByText(/read-only and was not deleted/);
    expect(notice).toHaveTextContent('1 billed entry is read-only and was not deleted.');
    expect(notice).toHaveTextContent(
      '1 of 2 time entries deleted. 1 could not be deleted and stayed selected.',
    );
  });
});

describe('TimeTracking bulk delete over queued and retainer-covered rows', () => {
  // Red if: the bulk delete treats every status but `unbilled` as locked, so it
  // drops time the server would delete and reports it as billed.
  it('sends them with the unbilled rows and reports nothing as read-only', async () => {
    const user = userEvent.setup();
    const entries = [
      entry('open-1', 'unbilled'),
      entry('queued-1', 'queued'),
      entry('covered-1', 'covered_by_retainer'),
    ];
    serve(entries);
    api.post(BULK_DELETE, answerBulkDelete());

    renderPanel();
    await selectPageAndConfirmDelete(user, entries.length);

    await waitFor(() => expect(api.callsTo(BULK_DELETE)).toHaveLength(1));
    expect(new Set(bulkDeleteIds(api))).toEqual(new Set(['open-1', 'queued-1', 'covered-1']));
    expect(screen.queryByText(/read-only and w(as|ere) not deleted/)).not.toBeInTheDocument();
  });
});
