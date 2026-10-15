/**
 * Whose entries the matter Time Tracking panel offers Edit, Delete and bulk
 * delete on.
 *
 * `billing.manageTimeEntries` covers the viewer's own time. An entry logged by
 * another member needs `billing.manageOthersTimeEntries` as well, and the API
 * refuses a bulk delete that contains one outright, so the panel must not offer
 * the row actions and must not put a teammate's id in the bulk request.
 *
 * WHAT BREAKS THESE: drop the `canActOnEntry` gate on the row actions and the
 * teammate's row shows Edit and Delete; drop it from `confirmBulkDelete` and the
 * request carries the teammate's id, which the server answers with a 403 for the
 * whole selection.
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
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { grantPermissions, resetPermissions } from '../../support/permissions';
import { mockAuthValue } from '../../setup';
import {
  BULK_DELETE,
  FIRM_TIME_ENTRIES,
  answerBulkDelete,
  bulkDeleteIds,
  confirmEntityBulkDelete,
  serveFirmTimeEntries,
  timeEntryRow,
} from '../../support/fixtures/timeEntries';

const CONTEXT: BillingContext = { type: 'matter', entityId: 'matter-1', lawFirmId: 'firm-1' };

let api: ApiMock;

const own = timeEntryRow({ id: 'own-1', userId: mockAuthValue.user.uid });
const teammates = timeEntryRow({ id: 'teammate-1', userId: 'someone-else' });

function renderPanel() {
  api.get(FIRM_TIME_ENTRIES, serveFirmTimeEntries([own, teammates]));
  return renderWithProviders(
    <TimeTracking context={CONTEXT} members={[]} users={[]} matterName="Smith v. Jones" />,
  );
}

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  resetPermissions();
  api.restore();
});

describe('without billing.manageOthersTimeEntries', () => {
  beforeEach(() => grantPermissions(['billing.viewTimeEntries', 'billing.manageTimeEntries']));

  it('offers Edit and Delete on the viewer\'s own entry only', async () => {
    renderPanel();

    await screen.findAllByRole('button', { name: 'Edit' });
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1);
  });

  it('leaves a teammate\'s id out of a bulk delete and says why', async () => {
    const user = userEvent.setup();
    api.post(BULK_DELETE, answerBulkDelete());
    renderPanel();

    await user.click(await screen.findByRole('checkbox', { name: 'Select all 2' }));
    await confirmEntityBulkDelete(user, 2);

    await waitFor(() => expect(api.callsTo(BULK_DELETE)).toHaveLength(1));
    expect(bulkDeleteIds(api)).toEqual(['own-1']);
    expect(await screen.findByText(/1 entry logged by other members was not deleted/)).toBeInTheDocument();
  });
});

describe('with billing.manageOthersTimeEntries', () => {
  it('offers Edit and Delete on every entry and sends every id in a bulk delete', async () => {
    grantPermissions(['billing.viewTimeEntries', 'billing.manageTimeEntries', 'billing.manageOthersTimeEntries']);
    const user = userEvent.setup();
    api.post(BULK_DELETE, answerBulkDelete());
    renderPanel();

    await screen.findAllByRole('button', { name: 'Edit' });
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(2);

    await user.click(await screen.findByRole('checkbox', { name: 'Select all 2' }));
    await confirmEntityBulkDelete(user, 2);

    await waitFor(() => expect(api.callsTo(BULK_DELETE)).toHaveLength(1));
    expect(new Set(bulkDeleteIds(api))).toEqual(new Set(['own-1', 'teammate-1']));
  });
});
