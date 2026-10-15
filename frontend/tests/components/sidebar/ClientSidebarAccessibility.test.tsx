import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ClientSidebar from '@/components/sidebar/ClientSidebar';

jest.mock('next/navigation', () => ({
  usePathname: () => '/client/lawfirm/firm-a/matters/matter-a',
  useRouter: () => ({ push: jest.fn(), prefetch: jest.fn() }),
}));
jest.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { uid: 'client-a', email: 'pat@example.test', displayName: 'Pat' } }),
}));
jest.mock('@/hooks/useUnreadCount', () => ({ useUnreadCount: () => ({ unreadCount: 0 }) }));
jest.mock('@/contexts/ProfileContext', () => ({ useProfile: () => ({ profile: { name: 'Pat' } }) }));
jest.mock('@/components/notificationComp/ClientNotificationBell', () => ({
  __esModule: true,
  default: () => <button aria-label="Notifications" />,
}));

const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() { return this.closest('[hidden], [inert]') ? null : document.body; },
  });
});
afterAll(() => {
  if (offsetParent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParent);
});

it('keeps the offscreen mobile drawer inert and out of the accessibility tree', () => {
  render(<ClientSidebar lawFirmId="firm-a" />);
  const toggle = screen.getByRole('button', { name: 'Open navigation menu' });
  const drawer = document.getElementById(toggle.getAttribute('aria-controls')!);
  expect(drawer).toBeInTheDocument();
  expect(drawer).toHaveAttribute('inert');
  expect(drawer).toHaveAttribute('aria-hidden', 'true');
  expect(screen.queryByRole('button', { name: 'Close navigation menu' })).not.toBeInTheDocument();
});

it('moves focus into mobile navigation, traps it, and restores it on Escape', async () => {
  const user = userEvent.setup();
  render(<ClientSidebar lawFirmId="firm-a" />);
  const toggle = screen.getByRole('button', { name: 'Open navigation menu' });
  toggle.focus();
  await user.keyboard('{Enter}');
  const dialog = screen.getByRole('dialog', { name: 'Client navigation' });
  const close = within(dialog).getByRole('button', { name: 'Close navigation menu' });
  expect(close).toHaveFocus();
  expect(dialog).toHaveAttribute('aria-modal', 'true');
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(dialog).not.toHaveAttribute('inert');
  expect(document.documentElement.style.overflow).toBe('hidden');
  fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
  expect(within(dialog).getByRole('button', { name: 'Notifications' })).toHaveFocus();
  fireEvent.keyDown(document, { key: 'Tab' });
  expect(close).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(toggle).toHaveFocus();
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(document.documentElement.style.overflow).not.toBe('hidden');
});

it('marks the current matter section instead of the pending destination', () => {
  render(<ClientSidebar lawFirmId="firm-a" pendingHref="/client/lawfirm/firm-a/billing" />);
  expect(screen.getByRole('link', { name: 'My Matters' })).toHaveAttribute('aria-current', 'page');
  expect(screen.getByRole('link', { name: 'Billing' })).not.toHaveAttribute('aria-current');
});

it('closes the mobile drawer when the current page is selected', async () => {
  const user = userEvent.setup();
  render(<ClientSidebar lawFirmId="firm-a" />);
  await user.click(screen.getByRole('button', { name: 'Open navigation menu' }));
  const dialog = screen.getByRole('dialog', { name: 'Client navigation' });
  const current = within(dialog).getByRole('link', { name: 'My Matters' });
  // Next links are plain anchors in the global harness; jsdom cannot navigate.
  current.addEventListener('click', (event) => event.preventDefault());
  await user.click(current);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('keeps account actions inside mobile navigation so keyboard users can reach sign out', async () => {
  const user = userEvent.setup();
  render(<ClientSidebar lawFirmId="firm-a" />);
  await user.click(screen.getByRole('button', { name: 'Open navigation menu' }));
  const dialog = screen.getByRole('dialog', { name: 'Client navigation' });
  await user.click(within(dialog).getByRole('button', { name: 'Pat Pat' }));
  const logout = within(dialog).getByRole('button', { name: 'Log out' });
  const account = within(dialog).getByRole('link', { name: /pat@example.test/ });
  account.focus();
  await user.tab();
  expect(logout).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('makes page content inert only while mobile navigation is open', async () => {
  const user = userEvent.setup();
  render(<><ClientSidebar lawFirmId="firm-a" /><main id="main-content"><button>Page action</button></main></>);
  const main = screen.getByRole('main');
  const toggle = screen.getByRole('button', { name: 'Open navigation menu' });
  expect(main).not.toHaveAttribute('inert');
  await user.click(toggle);
  expect(main).toHaveAttribute('inert');
  await user.keyboard('{Escape}');
  expect(main).not.toHaveAttribute('inert');
  expect(toggle).toHaveFocus();
});

it('releases mobile navigation when the viewport switches to the desktop sidebar', async () => {
  const user = userEvent.setup();
  let resized: ((event: { matches: boolean }) => void) | undefined;
  const media = jest.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: false, media: query, onchange: null,
    addEventListener: (_type: string, listener: any) => { if (query === '(min-width: 768px)') resized = listener; },
    removeEventListener: jest.fn(), addListener: jest.fn(), removeListener: jest.fn(), dispatchEvent: jest.fn(),
  }));
  try {
    render(<ClientSidebar lawFirmId="firm-a" />);
    await user.click(screen.getByRole('button', { name: 'Open navigation menu' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(resized).toBeDefined();
    act(() => resized!({ matches: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.documentElement.style.overflow).not.toBe('hidden');
  } finally {
    media.mockRestore();
  }
});
