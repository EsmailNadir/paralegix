let mockPathname = '/dashboard';
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => mockPathname,
  useParams: () => ({}),
}));

const mockEnable = jest.fn();
const mockDisable = jest.fn();
jest.mock('@/lib/analytics/analytics', () => ({
  __esModule: true,
  initAnalytics: jest.fn(),
  enableAnalytics: () => mockEnable(),
  disableAnalytics: () => mockDisable(),
}));

import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import CookieNotice from '@/components/ui/CookieNotice';
import CookieSettingsLink from '@/components/ui/CookieSettingsLink';
import userEvent from '@testing-library/user-event';

describe('CookieNotice', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    // The region lookup is cached per session; seeding it keeps these cases synchronous.
    sessionStorage.setItem('paralegix_consent_region', 'notice');
    mockPathname = '/dashboard';
    jest.clearAllMocks();
  });

  it('renders cookie notice banner when unacknowledged in localStorage', () => {
    render(<CookieNotice />);

    const banner = screen.getByRole('region', { name: 'Cookie notice' });
    expect(banner).toBeInTheDocument();
    expect(screen.getByText(/We use essential cookies/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy#cookies');
  });

  // Where analytics starts without asking, the notice has to say it is already
  // running, who runs it, and how to turn it off.
  it('switches the notice to the accept/decline choice from its own Cookie settings link', () => {
    render(<CookieNotice />);

    fireEvent.click(screen.getByRole('button', { name: 'Cookie settings' }));

    expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Got it' })).toBeNull();
  });

  it('tells a notice-region visitor analytics is on, who provides it, and where to turn it off', () => {
    render(<CookieNotice />);

    const text = screen.getByText(/We use essential cookies/i);
    expect(text).toHaveTextContent('PostHog');
    expect(text).toHaveTextContent('Cookie settings');
  });

  it('dismisses banner and sets localStorage flag on acknowledge click', async () => {
    render(<CookieNotice />);

    const btn = screen.getByRole('button', { name: 'Got it' });
    fireEvent.click(btn);

    expect(localStorage.getItem('paralegix_cookie_notice_ack')).toBe('1');
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Cookie notice' })).toBeNull());
  });

  // Dismissing plays the slide-away before the banner unmounts, still showing
  // the text it was showing rather than blanking out.
  it('slides away with its content intact before it unmounts', async () => {
    render(<CookieNotice />);
    const card = screen.getByText(/We use essential cookies/i).parentElement!;
    expect(card).toHaveClass('cookie-banner-enter');

    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));

    expect(card).toHaveClass('cookie-banner-exit');
    expect(screen.getByText(/We use essential cookies/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Cookie notice' })).toBeNull());
  });

  it('does not render banner if already acknowledged in localStorage', () => {
    localStorage.setItem('paralegix_cookie_notice_ack', '1');
    const { container } = render(<CookieNotice />);
    expect(container.firstChild).toBeNull();
  });

  // Marketing pages are always light paper and ink, whatever the app theme, so
  // a banner in the app's dark surface colours sits on them as a dark slab.
  it.each(['/', '/pricing', '/features', '/workflow'])(
    'uses the marketing palette on %s, with no dark variant',
    (path) => {
      mockPathname = path;
      render(<CookieNotice />);

      const card = screen.getByText(/We use essential cookies/i).parentElement!;
      expect(card).toHaveClass('bg-mkt-card');
      expect(card).not.toHaveClass('bg-surface');
      expect(card).not.toHaveClass('dark:bg-surface');
    },
  );

  // The sign-in pages are paper in light mode and the app surface in dark mode,
  // so the banner switches with them.
  it.each(['/login', '/register'])('matches the sign-in card on %s in both themes', (path) => {
    mockPathname = path;
    render(<CookieNotice />);

    const card = screen.getByText(/We use essential cookies/i).parentElement!;
    expect(card).toHaveClass('bg-mkt-card', 'dark:bg-surface');
    expect(card).not.toHaveClass('bg-surface');
  });

  it.each(['/dashboard', '/lawfirm/firm-1/matters', '/client/documents', '/privacy', '/register/invite'])(
    'uses the themed app surface on %s',
    (path) => {
      mockPathname = path;
      render(<CookieNotice />);

      const card = screen.getByText(/We use essential cookies/i).parentElement!;
      expect(card).toHaveClass('bg-surface');
      expect(card).not.toHaveClass('bg-mkt-card');
    },
  );

  describe('where the visitor must choose first', () => {
    beforeEach(() => {
      sessionStorage.setItem('paralegix_consent_region', 'required');
    });

    it('asks to accept or decline instead of showing the notice', () => {
      render(<CookieNotice />);

      expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Got it' })).toBeNull();
      expect(screen.getByText(/With your permission/)).toHaveTextContent('PostHog');
      // Quebec's Law 25 asks that a visitor be told the technology can locate them.
      expect(screen.getByText(/With your permission/)).toHaveTextContent('approximate location');
    });

    // Refusing has to be as easy and as visible as agreeing.
    it('gives Decline the same weight as Accept', () => {
      render(<CookieNotice />);

      expect(screen.getByRole('button', { name: 'Decline' }).className).toBe(
        screen.getByRole('button', { name: 'Accept' }).className,
      );
    });

    it('accepting records the choice, turns analytics on and closes', async () => {
      render(<CookieNotice />);

      fireEvent.click(screen.getByRole('button', { name: 'Accept' }));

      expect(localStorage.getItem('paralegix_analytics_consent')).toBe('granted');
      expect(mockEnable).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.queryByRole('region', { name: 'Cookie notice' })).toBeNull());
    });

    it('declining records the choice, keeps analytics off and closes', async () => {
      render(<CookieNotice />);

      fireEvent.click(screen.getByRole('button', { name: 'Decline' }));

      expect(localStorage.getItem('paralegix_analytics_consent')).toBe('denied');
      expect(mockDisable).toHaveBeenCalledTimes(1);
      expect(mockEnable).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByRole('region', { name: 'Cookie notice' })).toBeNull());
    });

    it('keeps its accept/decline wording while it slides away', () => {
      render(<CookieNotice />);

      fireEvent.click(screen.getByRole('button', { name: 'Accept' }));

      expect(screen.getByText(/With your permission/)).toBeInTheDocument();
    });

    it('stays closed once a choice was made', () => {
      localStorage.setItem('paralegix_analytics_consent', 'denied');
      const { container } = render(<CookieNotice />);
      expect(container.firstChild).toBeNull();
    });

    it('looks the region up when the session has not yet', async () => {
      sessionStorage.clear();
      (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ region: 'required' }) });

      render(<CookieNotice />);

      expect(await screen.findByRole('button', { name: 'Accept' })).toBeInTheDocument();
      delete (global as any).fetch;
    });
  });

  it('reopens as a choice from cookie settings, even after the notice was dismissed', () => {
    localStorage.setItem('paralegix_cookie_notice_ack', '1');
    render(
      <>
        <CookieNotice />
        <CookieSettingsLink />
      </>,
    );
    expect(screen.queryByRole('region', { name: 'Cookie notice' })).toBeNull();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Cookie settings' }));
    });

    expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(localStorage.getItem('paralegix_analytics_consent')).toBe('denied');
  });

  it.each(['Decline', 'Accept'])('focuses an explicitly opened choice and returns to Cookie settings after %s', async choice => {
    localStorage.setItem('paralegix_cookie_notice_ack', '1');
    render(<><CookieSettingsLink /><CookieNotice /></>);
    const trigger = screen.getByRole('button', { name: 'Cookie settings' });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const banner = screen.getByRole('region', { name: 'Cookie notice' });
    expect(screen.getByRole('button', { name: 'Decline' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: choice }));
    expect(localStorage.getItem('paralegix_analytics_consent')).toBe(choice === 'Accept' ? 'granted' : 'denied');
    expect(trigger).toHaveFocus();
    expect(banner).toHaveAttribute('inert');
    expect(screen.queryByRole('button', { name: choice })).not.toBeInTheDocument();
  });

  it('does not steal focus when the regional choice appears automatically', () => {
    sessionStorage.setItem('paralegix_consent_region', 'required');
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    try {
      render(<CookieNotice />);
      expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
      expect(button).toHaveFocus();
    } finally { button.remove(); }
  });
});
