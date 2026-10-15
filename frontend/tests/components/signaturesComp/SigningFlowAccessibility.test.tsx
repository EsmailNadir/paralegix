jest.unmock('@/services/signatures.service');
jest.unmock('@/services/requestDeduplicator');
jest.mock('@/components/signaturesComp/PDFPageViewer', () => {
  const { useEffect } = require('react');
  const pdf = { numPages: 1, getPage: async () => ({ getTextContent: async () => ({ items: [{ str: 'The agreement terms', hasEOL: true }] }) }) };
  function Viewer(props: any) {
    const { onDocumentLoad, onDocumentProxy } = props;
    useEffect(() => { onDocumentLoad?.(1); onDocumentProxy?.(pdf); }, [onDocumentLoad, onDocumentProxy]);
    return <div>{props.children(1, 800, 1000, { width: 612, height: 792 })}</div>;
  }
  return { __esModule: true, default: Viewer };
});
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RestrictedSigningView from '@/components/signaturesComp/RestrictedSigningView';
import { setupApiMock, sequence } from '../../support/apiMock';
const api = setupApiMock();
const props = { file: { url: 'blob:agreement', name: 'Agreement.pdf' }, token: 'signer-a', sourceRevision: 'revision-a' };

it('uses existing signer controls to complete fields and retry a focused refusal without losing consent', async () => {
  api.postExact('/api/signing/signer-a/complete', sequence(
    { status: 403, body: { error: 'Signing temporarily refused' } },
    { completed: true, state: 'completed', consentRecorded: true },
  ));
  const user = userEvent.setup();
  render(<RestrictedSigningView {...props} fields={[{ id: 'text-a', page: 1, xPercent: 10, yPercent: 10, widthPercent: 20, heightPercent: 5, fieldType: 'text', label: 'Approved amount', required: true }]} />);
  const field = screen.getByRole('button', { name: 'Approved amount, page 1, required, incomplete' });
  field.focus();
  await user.keyboard('{Enter}');
  await user.type(screen.getByRole('textbox', { name: 'Approved amount' }), '125');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByRole('button', { name: 'Approved amount, page 1, required, complete' })).toHaveTextContent('125');
  expect(await within(screen.getByRole('region', { name: 'Document text' })).findByText('The agreement terms')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Done' }));
  await user.type(screen.getByRole('textbox', { name: /Full Legal Name/ }), 'Jane Client');
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: 'Sign & Submit' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Signing temporarily refused');
  expect(alert).toHaveFocus();
  expect(screen.getByRole('textbox', { name: /Full Legal Name/ })).toHaveValue('Jane Client');
  expect(screen.getByRole('checkbox')).toBeChecked();
  const submit = screen.getByRole('button', { name: 'Sign & Submit' });
  submit.focus();
  await user.keyboard('{Enter}');
  const heading = await screen.findByRole('heading', { name: 'Signing Complete' });
  await waitFor(() => expect(heading).toHaveFocus());
  expect(api.calls('POST').map(call => call.body)).toEqual([
    expect.objectContaining({ consentName: 'Jane Client', consentAgreed: true, sourceRevision: 'revision-a', fieldValues: [{ fieldId: 'text-a', value: '125' }] }),
    expect.objectContaining({ consentName: 'Jane Client', consentAgreed: true, sourceRevision: 'revision-a', fieldValues: [{ fieldId: 'text-a', value: '125' }] }),
  ]);
});

it('announces a refused decline in its own dialog and preserves the reason for a keyboard retry', async () => {
  api.postExact('/api/signing/signer-a/decline', sequence({ status: 403, body: { error: 'Decline temporarily refused' } }, {}));
  const user = userEvent.setup();
  render(<RestrictedSigningView {...props} fields={[]} />);
  await user.click(screen.getByRole('button', { name: 'Decline to Sign' }));
  const dialog = screen.getByRole('dialog', { name: 'Decline to Sign' });
  await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Please revise the agreement');
  await user.click(within(dialog).getByRole('button', { name: 'Decline' }));
  const alert = await within(dialog).findByRole('alert');
  expect(alert).toHaveTextContent('Decline temporarily refused');
  expect(alert).toHaveFocus();
  expect(within(dialog).getByRole('textbox', { name: 'Reason' })).toHaveValue('Please revise the agreement');
  within(dialog).getByRole('button', { name: 'Decline' }).focus();
  await user.keyboard('{Enter}');
  const heading = await screen.findByRole('heading', { name: 'You Have Declined to Sign' });
  await waitFor(() => expect(heading).toHaveFocus());
  expect(api.calls('POST').map(call => call.body)).toEqual([{ reason: 'Please revise the agreement' }, { reason: 'Please revise the agreement' }]);
  expect(api.callsTo('/complete')).toHaveLength(0);
});
