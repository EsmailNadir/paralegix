/**
 * LimitsOverrideModal, through the REAL admin service against a fake transport.
 *
 * WHAT BREAKS THIS: letting a storage quota or per-file ceiling below 1 MB reach
 * the PATCH. `mbToBytes` turns any non-positive MB into 0 bytes, so a negative
 * entry was silently sent as a zero quota and refused by the server with a
 * generic validation error that names no field.
 */
jest.unmock('@/services/admin.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import LimitsOverrideModal from '@/components/adminComp/LimitsOverrideModal';

const LAW_FIRM_ID = 'firm-1';
const PLAN_URL = `/api/admin/lawfirms/${LAW_FIRM_ID}/plan`;
const MB = 1024 * 1024;

let api: ApiMock;
let onClose: jest.Mock;
let onSaved: jest.Mock;

function renderModal() {
  return renderWithProviders(
    <LimitsOverrideModal
      open
      onClose={onClose}
      lawFirmId={LAW_FIRM_ID}
      plan={undefined}
      onSaved={onSaved}
    />,
  );
}

beforeEach(() => {
  onClose = jest.fn();
  onSaved = jest.fn();
  api = installApiMock();
  api.getExact(PLAN_URL, {
    lawFirm: { id: LAW_FIRM_ID },
    limits: { maxMatters: 10, maxMembers: 5, storageQuotaBytes: 1024 * MB, maxFileSizeBytes: 100 * MB },
    features: {},
    usage: { matters: 0, members: 0, storageBytes: 0 },
  });
});

afterEach(() => api.restore());

describe.each([
  ['Storage Quota (MB)', '-5'],
  ['Max File Size (MB)', '-1'],
  ['Storage Quota (MB)', '0'],
])('the %s field holding %s', (label, value) => {
  it('is refused in the form and never sent', async () => {
    renderModal();
    await waitFor(() => expect(api.calls('GET')).toHaveLength(1));

    fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Overrides' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(`${label.replace(' (MB)', '')} must be at least 1 MB.`);
    expect(api.calls('PATCH')).toHaveLength(0);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

it('sends a positive storage quota in bytes', async () => {
  api.patchExact(PLAN_URL, { lawFirm: { id: LAW_FIRM_ID } });
  renderModal();
  await waitFor(() => expect(api.calls('GET')).toHaveLength(1));

  fireEvent.change(screen.getByLabelText('Storage Quota (MB)'), { target: { value: '2048' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Overrides' }));

  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(api.calls('PATCH')[0].body).toEqual({ limitOverrides: { storageQuotaBytes: 2048 * MB } });
});
