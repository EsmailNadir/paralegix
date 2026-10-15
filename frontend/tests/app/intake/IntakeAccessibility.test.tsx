jest.unmock('@/services/leads.service');
jest.unmock('@/services/requestDeduplicator');
jest.mock('next/navigation', () => ({ useParams: () => ({ token: 'intake-a' }) }));
import React from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Intake from '@/app/intake/[token]/page';
import { renderWithProviders } from '../../support/renderWithProviders';
import { setupApiMock, sequence } from '../../support/apiMock';
const api = setupApiMock();
const payload = { name: 'Client information', lawFirmName: 'Firm A', fields: [
  { key: 'name', label: 'Full name', type: 'text', required: true },
  { key: 'email', label: 'Email address', type: 'email', required: true },
  { key: 'topic', label: 'Topic', type: 'select', required: true, options: ['Estate', 'Property'] },
  { key: 'details', label: 'Details', type: 'textarea', required: false },
] };
it('associates access-code refusals, then focuses the unlocked form heading', async () => {
  api.getExact('/api/intake/intake-a', { name: payload.name, requiresAccessCode: true });
  api.postExact('/api/intake/intake-a/verify-access-code', sequence({ status: 403, body: { error: 'Incorrect access code' } }, payload));
  const user = userEvent.setup();
  renderWithProviders(<Intake />);
  const code = await screen.findByLabelText('Access code *');
  await user.type(code, 'wrong{Enter}');
  await screen.findByRole('alert');
  expect(code).toHaveFocus();
  expect(code).toHaveAttribute('aria-invalid', 'true');
  expect(code).toHaveAccessibleDescription('Incorrect access code');
  await user.clear(code);
  await user.type(code, 'valid{Enter}');
  const name = await screen.findByRole('textbox', { name: 'Full name *' });
  expect(screen.getByRole('heading', { level: 1, name: payload.name })).toHaveFocus();
  await user.tab();
  expect(name).toHaveFocus();
  expect(api.calls('POST').map(call => call.body)).toEqual([{ code: 'wrong' }, { code: 'valid' }]);
});

it('focuses required fields and repeated submission refusals before announcing actual receipt', async () => {
  api.getExact('/api/intake/intake-a', payload);
  api.postExact('/api/intake/intake-a/submit', sequence({ status: 403, body: { error: 'Submission unavailable' } }, { id: 'response-a' }));
  const user = userEvent.setup();
  renderWithProviders(<Intake />);
  const name = await screen.findByRole('textbox', { name: 'Full name *' });
  const submit = screen.getByRole('button', { name: 'Submit' });
  await user.click(submit);
  expect(name).toHaveFocus();
  expect(name).toHaveAttribute('aria-invalid', 'true');
  expect(name).toHaveAccessibleDescription(/Full name is required/);
  expect(api.calls('POST')).toHaveLength(0);
  await user.type(name, 'Pat Client');
  await user.type(screen.getByRole('textbox', { name: 'Email address *' }), 'pat@example.com');
  await user.click(submit);
  const topic = screen.getByRole('button', { name: /Topic.*Select/ });
  expect(topic).toHaveFocus();
  expect(topic).toHaveAttribute('aria-required', 'true');
  expect(topic).toHaveAttribute('aria-invalid', 'true');
  expect(topic).toHaveAccessibleDescription(/Topic is required/);
  await user.keyboard('{Enter}{ArrowDown}{Enter}');
  expect(topic).toHaveTextContent('Estate');
  await user.type(screen.getByRole('textbox', { name: 'Details' }), 'Review my estate plan');
  await user.click(submit);
  const error = await screen.findByRole('alert');
  expect(error).toHaveTextContent('Submission unavailable');
  expect(error.parentElement).toHaveFocus();
  expect(name).toHaveValue('Pat Client');
  await user.click(within(error).getByRole('button', { name: 'Close' }));
  expect(submit).toHaveFocus();
  await user.keyboard('{Enter}');
  await waitFor(() => expect(screen.getByRole('heading', { name: "Thanks, we'll be in touch" })).toHaveFocus());
  expect(api.calls('POST')[1].body).toEqual({ fieldValues: { name: 'Pat Client', email: 'pat@example.com', topic: 'Estate', details: 'Review my estate plan' } });
});
