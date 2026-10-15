/**
 * Correcting an invoice's billing email. The firm finds the address was wrong,
 * enters the right one, can fix the client's record at the same time, and is
 * offered to resend a payment link that already went to the wrong place.
 *
 * Driven through the real billing and clients services with only the
 * transport faked. Red if the new list is not what is sent, if the client
 * record is changed when the firm said not to (or is not changed when it said
 * to), if a bad address reaches the server, or if a pending payment link is
 * resent without asking, or without the invoice's fee choice.
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EditBillingEmailModal from '@/components/billingComp/EditBillingEmailModal';
import { renderWithProviders } from '../../support/renderWithProviders';
import { setupApiMock } from '../../support/apiMock';
import type { Invoice } from '@/types';

const api = setupApiMock();
const CONTEXT = { type: 'client' as const, lawFirmId: 'firm-a', entityId: 'client-a' };
const EDIT_URL = '/api/lawfirms/firm-a/billing/invoices/client/client-a/invoice-a/billing-email';
const CLIENT_URL = '/api/lawfirms/firm-a/clients/client-a';
const REQUEST_URL = '/api/stripe/payment/firm-a/client/client-a/invoice-a/request';

const baseInvoice = { id: 'invoice-a', stripePaymentRequested: false } as Invoice;

function renderModal(props: Partial<React.ComponentProps<typeof EditBillingEmailModal>> = {}) {
  const onSaved = jest.fn();
  const onClose = jest.fn();
  renderWithProviders(
    <EditBillingEmailModal
      open
      onClose={onClose}
      onSaved={onSaved}
      invoice={baseInvoice}
      billingContext={CONTEXT}
      clientId="client-a"
      clientName="Pat Client"
      canUpdateClient
      currentEmails={['wrong@example.test']}
      {...props}
    />,
  );
  return { onSaved, onClose };
}

const emailField = () => screen.getByRole('textbox', { name: 'Billing email' });
const removeWrong = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: 'Remove wrong@example.test' }));

it('saves the corrected address to the invoice and the client record', async () => {
  api.put(CLIENT_URL, { message: 'ok' });
  api.put(EDIT_URL, { message: 'ok' });
  const user = userEvent.setup();
  const { onSaved, onClose } = renderModal();

  expect(screen.getByText('wrong@example.test')).toBeInTheDocument();
  await removeWrong(user);
  await user.type(emailField(), 'right@example.test');
  await user.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.calls('PUT').find((c) => c.url.endsWith('/billing-email'))?.body).toEqual({ emails: ['right@example.test'] });
  expect(api.calls('PUT').find((c) => c.url.endsWith('/clients/client-a'))?.body).toEqual({ email: 'right@example.test' });
  expect(onClose).toHaveBeenCalled();
});

it('leaves the client record alone when the firm unticks the box', async () => {
  api.put(EDIT_URL, { message: 'ok' });
  const user = userEvent.setup();
  const { onSaved } = renderModal();

  await removeWrong(user);
  await user.type(emailField(), 'right@example.test');
  await user.click(screen.getByRole('checkbox', { name: /Also update Pat Client's email/ }));
  await user.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.callsTo('/clients/client-a')).toHaveLength(0);
});

it('offers no client update for a company, whose recipients are its members', async () => {
  renderModal({ canUpdateClient: false });

  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
});

it('sends a list when several addresses are entered', async () => {
  api.put(EDIT_URL, { message: 'ok' });
  const user = userEvent.setup();
  const { onSaved } = renderModal({ canUpdateClient: false });

  await removeWrong(user);
  await user.type(emailField(), 'ap@acme.example.test{Enter}cfo@acme.example.test,');
  // Each address becomes its own chip rather than one comma-joined string.
  expect(screen.getByRole('button', { name: 'Remove ap@acme.example.test' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Remove cfo@acme.example.test' })).toBeInTheDocument();
  expect(emailField()).toHaveValue('');
  await user.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.calls('PUT')[0].body).toEqual({ emails: ['ap@acme.example.test', 'cfo@acme.example.test'] });
});

it('keeps an address that is already listed and adds the one being typed on save', async () => {
  api.put(EDIT_URL, { message: 'ok' });
  const user = userEvent.setup();
  const { onSaved } = renderModal({ canUpdateClient: false });

  await user.type(emailField(), 'second@example.test');
  await user.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.calls('PUT')[0].body).toEqual({ emails: ['wrong@example.test', 'second@example.test'] });
});

it('will not save with every address removed', async () => {
  const user = userEvent.setup();
  renderModal();

  await removeWrong(user);
  await user.click(screen.getByRole('button', { name: 'Save' }));

  expect(await screen.findByText('Enter at least one billing email.')).toBeInTheDocument();
  expect(api.calls('PUT')).toHaveLength(0);
});

it('leaves an invalid address in the field instead of turning it into a chip', async () => {
  const user = userEvent.setup();
  renderModal();

  await user.type(emailField(), 'not-an-email{Enter}');

  expect(await screen.findByText('"not-an-email" is not a valid email address.')).toBeInTheDocument();
  expect(emailField()).toHaveValue('not-an-email');
  expect(screen.queryByRole('button', { name: 'Remove not-an-email' })).not.toBeInTheDocument();
});

it('refuses an address that is not an email, without asking the server', async () => {
  const user = userEvent.setup();
  renderModal();

  await removeWrong(user);
  await user.type(emailField(), 'not-an-email');
  await user.click(screen.getByRole('button', { name: 'Save' }));

  expect(await screen.findByText('"not-an-email" is not a valid email address.')).toBeInTheDocument();
  expect(api.calls('PUT')).toHaveLength(0);
});

it('offers to resend a pending payment link, with the invoice fee choice', async () => {
  api.put(CLIENT_URL, { message: 'ok' });
  api.put(EDIT_URL, { message: 'ok' });
  api.post(REQUEST_URL, { hostedInvoiceUrl: null, paymentUrl: 'https://app.test/pay', stripeInvoiceId: null });
  const user = userEvent.setup();
  const { onClose } = renderModal({
    invoice: { ...baseInvoice, stripePaymentRequested: true, stripePaymentStatus: 'pending', isCardFeePassedOn: true, isBankFeePassedOn: true } as Invoice,
  });

  await removeWrong(user);
  await user.type(emailField(), 'right@example.test');
  await user.click(screen.getByRole('button', { name: 'Save' }));

  // Nothing is resent until the firm says so.
  expect(await screen.findByText(/already sent to the old address/)).toBeInTheDocument();
  expect(api.calls('POST')).toHaveLength(0);
  await user.click(screen.getByRole('button', { name: 'Resend payment link' }));

  await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
  // A resend emails the new link to the corrected address.
  expect(api.calls('POST')[0].body).toEqual({ isCardFeePassedOn: true, isBankFeePassedOn: true, sendEmail: true });
  expect(onClose).toHaveBeenCalled();
});

it('resends an installment link for the same installment', async () => {
  api.put(CLIENT_URL, { message: 'ok' });
  api.put(EDIT_URL, { message: 'ok' });
  api.post(REQUEST_URL, { message: 'Payment link emailed', paymentUrl: 'https://app.test/pay' });
  const user = userEvent.setup();
  renderModal({
    invoice: {
      ...baseInvoice, stripePaymentRequested: true, stripePaymentStatus: 'pending', payLinkInstallmentId: 'ep-2',
    } as Invoice,
  });

  await removeWrong(user);
  await user.type(emailField(), 'right@example.test');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await user.click(await screen.findByRole('button', { name: 'Resend payment link' }));

  await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
  // Breaks if a resent installment link silently becomes a full-balance link.
  expect(api.calls('POST')[0].body).toMatchObject({ installmentId: 'ep-2' });
});
