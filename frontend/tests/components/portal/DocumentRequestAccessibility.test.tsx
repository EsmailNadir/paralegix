jest.unmock('@/services/client-portal.service');
jest.unmock('@/services/requestDeduplicator');
import React from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RequestedDocumentsPanel from '@/components/portalComp/RequestedDocumentsPanel';
import { renderWithProviders } from '../../support/renderWithProviders';
import { setupApiMock, sequence } from '../../support/apiMock';
const api = setupApiMock();
const endpoint = '/api/client-portal/lawfirm/firm-a/document-requests?clientRecordId=record-a';
const request = {
  id: 'req-a', title: 'Proof of identity', status: 'open', matterId: null, clientId: 'record-a',
  createdAt: '2026-10-04T12:00:00Z', note: 'Provide a legible copy', dueDate: null,
  items: [{ id: 'item-a', requestId: 'req-a', label: 'Photo ID', status: 'pending', description: '', fulfillments: [] }],
};
it.each([false, true])('excludes collapsed request controls and relates both disclosures (compact=%s)', async compact => {
  api.getExact(endpoint, { requests: [request] });
  const user = userEvent.setup();
  renderWithProviders(<RequestedDocumentsPanel lawFirmId="firm-a" clientRecordId="record-a" compact={compact} />);
  const section = await screen.findByRole('button', { name: compact ? 'Requested from you' : 'Requested documents' });
  const requestToggle = screen.getByRole('button', { name: /Proof of identity/ });
  const upload = screen.getByRole('button', { name: 'Upload Photo ID' });
  expect(upload).toBeEnabled();
  const requestBody = document.getElementById(requestToggle.getAttribute('aria-controls')!);
  expect(requestBody).toContainElement(upload);
  requestToggle.focus();
  await user.keyboard('{Enter}');
  expect(requestToggle).toHaveAttribute('aria-expanded', 'false');
  expect(requestBody).toHaveAttribute('inert');
  expect(requestBody).toHaveAttribute('aria-hidden', 'true');
  expect(screen.queryByRole('button', { name: 'Upload Photo ID' })).not.toBeInTheDocument();
  await user.keyboard('{Enter}');
  expect(screen.getByRole('button', { name: 'Upload Photo ID' })).toBeEnabled();
  section.focus();
  await user.keyboard('{Enter}');
  const sectionBody = document.getElementById(section.getAttribute('aria-controls')!);
  expect(sectionBody).toContainElement(requestToggle);
  expect(sectionBody).toHaveAttribute('inert');
  expect(screen.queryByRole('button', { name: /Proof of identity/ })).not.toBeInTheDocument();
  expect(section).toHaveFocus();
});

it('exposes a failed request list instead of hiding the refusal with an empty panel', async () => {
  api.getExact(endpoint, sequence({ status: 403, body: { error: 'Requests unavailable' } }, { requests: [request] }));
  const view = renderWithProviders(<RequestedDocumentsPanel lawFirmId="firm-a" clientRecordId="record-a" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Requests unavailable');
  expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  view.unmount();
  renderWithProviders(<RequestedDocumentsPanel lawFirmId="firm-a" clientRecordId="record-a" />);
  expect(await screen.findByRole('button', { name: 'Upload Photo ID' })).toBeEnabled();
  expect(api.calls('GET')).toHaveLength(2);
});

it('keeps a removal refusal inside the existing confirmation and preserves the uploaded file', async () => {
  api.getExact(endpoint, { requests: [{ ...request, items: [{ ...request.items[0], fulfillments: [{ id: 'file-a', fileName: 'identity.pdf', uploadedBy: 'test-uid', objectPath: 'identity.pdf', uploadedAt: '2026-10-04' }] }] }] });
  api.deleteExact('/api/client-portal/lawfirm/firm-a/document-requests/req-a/items/item-a/fulfillments/file-a?clientRecordId=record-a', { status: 403, body: { error: 'Removal temporarily unavailable' } });
  const user = userEvent.setup();
  renderWithProviders(<RequestedDocumentsPanel lawFirmId="firm-a" clientRecordId="record-a" />);
  await screen.findByText('identity.pdf');
  await user.click(screen.getByRole('button', { name: 'Remove file' }));
  const dialog = screen.getByRole('dialog', { name: 'Remove file' });
  await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
  const alert = await within(dialog).findByRole('alert');
  expect(alert).toHaveTextContent('Removal temporarily unavailable');
  expect(alert.parentElement).toHaveFocus();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Remove file' })).toHaveFocus());
  expect(screen.getByRole('button', { name: 'identity.pdf' })).toBeInTheDocument();
});
