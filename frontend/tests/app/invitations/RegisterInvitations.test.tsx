const mockRouter = { push: jest.fn(), replace: jest.fn() };
jest.mock('next/navigation', () => ({ useRouter: () => mockRouter, useSearchParams: () => new URLSearchParams('token=invite-a') }));
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: null, loading: false }) }));
jest.mock('@/lib/utils/emailVerification', () => ({ isWhitelistedEmail: () => true }));
jest.mock('next/image', () => ({ __esModule: true, default: ({ priority: _priority, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { priority?: boolean }) => <img {...props} alt={props.alt || ''} /> }));
jest.mock('@/services/auth.service', () => ({ __esModule: true, default: { signUp: jest.fn().mockResolvedValue({}), signUpWithGoogle: jest.fn().mockResolvedValue({ needsRegistration: true }), signUpWithMicrosoft: jest.fn().mockResolvedValue({ needsRegistration: true }), completeOAuthRegistration: jest.fn().mockResolvedValue({}) } }));

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ClientRegister from '@/app/register/invite/page';
import MemberRegister from '@/app/register/member-invite/page';
import authService from '@/services/auth.service';
import { scanAccessibility } from '../../support/accessibility';
import { setupApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';

const api = setupApiMock();
beforeEach(() => jest.clearAllMocks());

describe.each([
  { Page: ClientRegister, path: '/api/invitations/accept/invite-a', userType: 'client', button: 'Create Client Account', destination: '/client/dashboard', acceptance: '/accept-invite?token=invite-a' },
  { Page: MemberRegister, path: '/api/invitations/member-accept/invite-a', userType: 'firm_member', button: 'Create Account', destination: '/accept-member-invite?token=invite-a', acceptance: '/accept-member-invite?token=invite-a' },
])('$userType registration', ({ Page, path, userType, button, destination, acceptance }) => {
  beforeEach(() => api.getExact(path, { invitation: { lawFirmId: 'firm-a', lawFirmName: 'Inviting Firm', email: 'invite@example.com' } }));
  it('validates passwords before signing up with the invitation email and target account type', async () => {
    const { container } = renderWithProviders(<Page />);
    await userEvent.type(await screen.findByLabelText('Full Name *'), 'Invited Person');
    await userEvent.type(screen.getByLabelText('Password *'), 'abcdef');
    await userEvent.type(screen.getByLabelText('Confirm Password *'), 'different');
    await userEvent.click(screen.getByRole('button', { name: button }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Passwords do not match');
    expect(authService.signUp).not.toHaveBeenCalled();
    expect((await scanAccessibility(container)).violations).toEqual([]);
    await userEvent.clear(screen.getByLabelText('Confirm Password *'));
    await userEvent.type(screen.getByLabelText('Confirm Password *'), 'abcdef');
    await userEvent.click(screen.getByRole('button', { name: button }));
    await waitFor(() => expect(authService.signUp).toHaveBeenCalledWith('invite@example.com', 'abcdef', { name: 'Invited Person', userType }));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith(destination));
  });
  it('keeps password visibility controls in the keyboard order', async () => {
    renderWithProviders(<Page />);
    const password = await screen.findByLabelText('Password *');
    expect(screen.getByRole('main')).toContainElement(password);
    expect(screen.getByRole('heading', { level: 1, name: /been invited/ })).toBeInTheDocument();
    password.focus();
    await userEvent.tab();
    expect(screen.getAllByRole('button', { name: 'Show password' })[0]).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(password).toHaveAttribute('type', 'text');
    screen.getByLabelText('Confirm Password *').focus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveFocus();
  });

  it('focuses and describes mismatched confirmation on every failed attempt, then clears it on retry', async () => {
    renderWithProviders(<Page />);
    await userEvent.type(await screen.findByLabelText('Full Name *'), 'Invited Person');
    await userEvent.type(screen.getByLabelText('Password *'), 'abcdef');
    await userEvent.type(screen.getByLabelText('Confirm Password *'), 'different');
    for (let attempt = 0; attempt < 2; attempt++) {
      await userEvent.click(screen.getByRole('button', { name: button }));
      expect(screen.getByLabelText('Confirm Password *')).toHaveFocus();
      expect(screen.getByLabelText('Confirm Password *')).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByLabelText('Confirm Password *')).toHaveAccessibleDescription(/Passwords do not match/);
      expect(screen.getByLabelText('Password *')).not.toHaveAttribute('aria-invalid', 'true');
    }
    expect(authService.signUp).not.toHaveBeenCalled();
    await userEvent.clear(screen.getByLabelText('Confirm Password *'));
    await userEvent.type(screen.getByLabelText('Confirm Password *'), 'abcdef');
    await userEvent.click(screen.getByRole('button', { name: button }));
    await waitFor(() => expect(authService.signUp).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Confirm Password *')).not.toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Confirm Password *')).not.toHaveAttribute('aria-describedby');
  });

  it.each(['Google', 'Microsoft'])('completes %s registration for the correct account type and preserves the acceptance token', async provider => {
    renderWithProviders(<Page />);
    await screen.findByLabelText('Full Name *');
    await userEvent.click(screen.getByRole('button', { name: new RegExp(provider) }));
    await waitFor(() => expect(authService.completeOAuthRegistration).toHaveBeenCalledWith(userType));
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith(acceptance));
  });
});
