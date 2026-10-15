/**
 * Copying an open payment request's link from the invoice, to text it.
 * Red if the wrong link is copied or the firm gets no sign that it worked.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CopyPaymentLinkButton from '@/components/billingComp/CopyPaymentLinkButton';

it('copies the link and says so', async () => {
  // userEvent.setup() installs its own clipboard, so the spy goes on after it.
  const user = userEvent.setup();
  const writeText = jest.spyOn(navigator.clipboard, 'writeText');
  render(<CopyPaymentLinkButton url="https://app.test/pay/tok_x" />);

  await user.click(screen.getByRole('button', { name: 'Copy Payment Link' }));

  expect(writeText).toHaveBeenCalledWith('https://app.test/pay/tok_x');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument());
});
