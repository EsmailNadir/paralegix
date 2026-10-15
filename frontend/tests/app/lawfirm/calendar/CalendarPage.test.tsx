/**
 * The firm calendar page: `RequirePermission` gating the real `Calendar`
 * component, which owns its own windowed reads (matter events, standalone
 * client events, external/synced events, tasks and - permission-gated -
 * billing payment dates) through `useCalendarWindowData`, driven against a
 * faked transport so the real service layer, React Query keys and permission
 * gating all execute.
 *
 * Calendar sync (`features.calendarSync`) is left OFF throughout: it drives an
 * unrelated background engine (`useUserSyncSettings` + a Google-auth self-heal
 * effect) that would otherwise need its own settings-endpoint mocks in every
 * test here for a feature none of these scenarios are about.
 */
jest.unmock('@/services/matterEvents.service');
jest.unmock('@/services/clients.service');
jest.unmock('@/services/calendarEvents.service');
jest.unmock('@/services/courts.service');
jest.unmock('@/services/tasks.service');
jest.unmock('@/services/users.service');
jest.unmock('@/services/billing.service');
jest.unmock('@/services/requestDeduplicator');

const useParamsMock = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/calendar',
  useParams: () => useParamsMock(),
  useSearchParams: () => new URLSearchParams(),
}));

import React from 'react';
import dayjs from 'dayjs';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import CalendarPage from '@/app/lawfirm/[lawFirmId]/calendar/page';
import { FirmSettingsProvider } from '@/contexts/FirmSettingsContext';
import { setupApiMock, type RecordedCall } from '../../../support/apiMock';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { grantOutsider, grantPermissions, resetPermissions } from '../../../support/permissions';

const FIRM_A = 'firm-a';
const FIRM_B = 'firm-b';

const api = setupApiMock();

/**
 * Every route the calendar fetches on mount for one law firm, with sensible
 * empty defaults. `matterEvents` is a separate `api.get` call so a test can
 * override it afterward (a later registration wins over an earlier one for
 * the same path).
 *
 * The window itself arrives in one `calendar-feed` read, built from the same
 * overrides. The per-section routes stay registered: a section re-reads its own
 * endpoint after a mutation, and every section falls back to its own endpoint
 * when the feed fails.
 */
function seedCalendarDefaults(
  firmId: string,
  overrides: {
    matterEvents?: Record<string, unknown>[];
    windowTasks?: Record<string, unknown>[];
    nextUpTasks?: Record<string, unknown>[];
  } = {},
) {
  api.get(`/lawfirms/${firmId}/calendar-feed`, calendarFeed(overrides));
  api.get(`/lawfirms/${firmId}/matters/events`, {
    events: overrides.matterEvents ?? [],
    totalEvents: (overrides.matterEvents ?? []).length,
  });
  api.get(`/lawfirms/${firmId}/clients/events`, { events: [], totalEvents: 0 });
  api.get(`/lawfirms/${firmId}/calendar-events`, { events: [], totalEvents: 0 });
  api.get(`/lawfirms/${firmId}/billing/invoices/calendar-payment-dates`, { paymentDates: [] });
  api.get(`/lawfirms/${firmId}/courts`, { courts: [] });
  api.get(`/lawfirm/${firmId}/users`, []);
  // The SAME endpoint backs both the calendar's own window read (carries
  // `dueTo`) and the firm-wide "next up" read (carries no `dueTo`).
  api.get(`/lawfirms/${firmId}/tasks`, (call: RecordedCall) => {
    if (call.query.dueTo) {
      return { tasks: overrides.windowTasks ?? [], totalTasks: (overrides.windowTasks ?? []).length };
    }
    return { tasks: overrides.nextUpTasks ?? [], totalTasks: (overrides.nextUpTasks ?? []).length };
  });
}

/** The feed body for one window: each section as its own endpoint would answer. */
function calendarFeed(overrides: { matterEvents?: Record<string, unknown>[]; windowTasks?: Record<string, unknown>[] } = {}) {
  return {
    matterEvents: { events: overrides.matterEvents ?? [], totalEvents: (overrides.matterEvents ?? []).length },
    clientEvents: { events: [], totalEvents: 0 },
    calendarEvents: { events: [], totalEvents: 0 },
    tasks: { tasks: overrides.windowTasks ?? [], totalTasks: (overrides.windowTasks ?? []).length },
    paymentDates: { paymentDates: [] },
  };
}

function allDayTask(overrides: Record<string, unknown> = {}) {
  const dueDate = dayjs().hour(0).minute(0).second(0).millisecond(0).format('YYYY-MM-DDTHH:mm:ss');
  return {
    id: 't1',
    taskId: 't1',
    lawFirmId: FIRM_A,
    title: 'Draft motion',
    status: 'open',
    priority: 'medium',
    dueDate,
    dueDateLocalInput: dueDate,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function matterEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'me1',
    matterId: 'matter-1',
    matterName: 'Smith v. Jones',
    type: 'hearing',
    title: 'Firm A Hearing',
    date: dayjs().hour(10).minute(0).second(0).millisecond(0).toISOString(),
    status: 'upcoming',
    allDay: false,
    ...overrides,
  };
}

/**
 * The always-mounted desktop agenda panel for the selected day (`selectedDate`
 * defaults to today). `Calendar` also renders a second, mobile-overlay copy of
 * the same panel that stays in the DOM (translated off-screen, not removed)
 * regardless of viewport, so a bare `getByText`/`getByRole` against the whole
 * page is ambiguous whenever the item shown also appears in the panel. Scope
 * to this one, real "aside" instead of asserting against whichever copy a
 * broader query happens to prefer.
 */
function desktopPanel() {
  const aside = [...document.querySelectorAll('aside')].find((el) => el.className.includes('348px'));
  if (!aside) throw new Error('desktop calendar side panel not found');
  return within(aside as HTMLElement);
}

/**
 * Wait past the loading skeleton, which mirrors the real three-column layout
 * (including a 348px-wide `aside`) closely enough that a bare `desktopPanel()`
 * call made too early binds to the SKELETON's placeholder aside rather than
 * the real one that later replaces it. The "Today" button only exists once
 * the real `Calendar` renders.
 */
async function waitForCalendarLoaded() {
  await screen.findByRole('button', { name: 'Today' });
}

function renderCalendarPage(firmId: string = FIRM_A) {
  return renderWithProviders(
    <FirmSettingsProvider lawFirmId={firmId} initialSettings={{ features: { calendarSync: false } as never }}>
      <CalendarPage />
    </FirmSettingsProvider>,
  );
}

beforeEach(() => {
  useParamsMock.mockReturnValue({ lawFirmId: FIRM_A });
  // The view-mode toggle persists to real `window.localStorage`
  // (`calendarViewPreference.ts`), which jsdom keeps across tests in this
  // file. Without clearing it, the "API failure" spec's switch to month view
  // would leak into every later spec and silently change which view they
  // render.
  window.localStorage.clear();
});

afterEach(() => {
  resetPermissions();
  jest.clearAllMocks();
});

describe('loaded content', () => {
  it('shows a real all-day task returned by the server', async () => {
    seedCalendarDefaults(FIRM_A, { windowTasks: [allDayTask()] });

    renderCalendarPage();
    await waitForCalendarLoaded();

    // `selectedDate` defaults to today, so the agenda panel for today shows the
    // real task the server returned without any extra navigation.
    expect(desktopPanel().getByText('Draft motion')).toBeInTheDocument();
  });
});

describe('a meaningful empty state', () => {
  it('says no events this week rather than rendering a blank grid', async () => {
    seedCalendarDefaults(FIRM_A);

    renderCalendarPage();

    expect(await screen.findByText('No events this week')).toBeInTheDocument();
    expect(screen.getByText('Click a time slot to create a task')).toBeInTheDocument();
  });
});

describe('an API failure', () => {
  it('shows the real error rather than a silently empty calendar', async () => {
    seedCalendarDefaults(FIRM_A);
    // The feed fails, so each section falls back to its own endpoint, and the
    // matter events read fails too.
    api.get(`/lawfirms/${FIRM_A}/calendar-feed`, { status: 500, body: { error: 'calendar service unavailable' } });
    api.get(`/lawfirms/${FIRM_A}/matters/events`, {
      status: 500,
      body: { error: 'calendar service unavailable' },
    });

    renderCalendarPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(/calendar service unavailable/i);
  });

  it('recovers once navigating crosses into a month that has not failed', async () => {
    seedCalendarDefaults(FIRM_A);
    let feedAttempt = 0;
    api.get(`/lawfirms/${FIRM_A}/calendar-feed`, () => {
      feedAttempt += 1;
      if (feedAttempt === 1) return { status: 500, body: { error: 'calendar service unavailable' } };
      return calendarFeed();
    });
    let attempt = 0;
    api.get(`/lawfirms/${FIRM_A}/matters/events`, () => {
      attempt += 1;
      if (attempt === 1) return { status: 500, body: { error: 'calendar service unavailable' } };
      return { events: [], totalEvents: 0 };
    });

    renderCalendarPage();

    await screen.findByRole('alert');

    // The calendar has no manual "Try again" affordance on this banner (see
    // functionality question logged for this page); the real way a viewer
    // recovers is by navigating to a month whose window has never failed,
    // which opens a fresh React Query key.
    await userEvent.click(screen.getByRole('button', { name: 'Month' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});

describe('narrow role behavior', () => {
  it('turns away a caller with no membership at all, and fires no calendar reads', async () => {
    grantOutsider();

    renderCalendarPage();

    expect(await screen.findByText('You do not have access to this area')).toBeInTheDocument();
    expect(api.calls()).toHaveLength(0);
  });

  it('skips the billing payment-dates read for a viewer without billing.viewInvoices', async () => {
    grantPermissions(['calendar.view']);
    seedCalendarDefaults(FIRM_A);

    renderCalendarPage();

    await screen.findByText('No events this week');
    expect(api.callsTo('/calendar-payment-dates')).toHaveLength(0);
  });
});

describe('a successful action: deleting a task', () => {
  it('removes the task from the calendar once the server confirms the delete', async () => {
    seedCalendarDefaults(FIRM_A, { windowTasks: [allDayTask()] });
    let deleteCalls = 0;
    api.delete(`/lawfirms/${FIRM_A}/tasks/t1`, () => {
      deleteCalls += 1;
      return { message: 'ok' };
    });
    // The window loaded through the feed; the refresh after a successful
    // delete re-requests the tasks section alone and gets the now-empty list.
    let taskCall = 0;
    api.get(`/lawfirms/${FIRM_A}/tasks`, (call: RecordedCall) => {
      if (!call.query.dueTo) return { tasks: [], totalTasks: 0 };
      taskCall += 1;
      return { tasks: [], totalTasks: 0 };
    });

    renderCalendarPage();
    await waitForCalendarLoaded();

    await userEvent.click(desktopPanel().getByRole('button', { name: 'Delete task' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByText('Draft motion')).not.toBeInTheDocument());
    expect(deleteCalls).toBe(1);
    expect(taskCall).toBeGreaterThanOrEqual(1);
  });
});

describe('a refused action: the delete fails', () => {
  it('tells the user the task was not deleted, and leaves it on the calendar', async () => {
    seedCalendarDefaults(FIRM_A, { windowTasks: [allDayTask()] });
    api.delete(`/lawfirms/${FIRM_A}/tasks/t1`, {
      status: 403,
      body: { error: 'You do not have permission to delete this task' },
    });

    renderCalendarPage();
    await waitForCalendarLoaded();

    await userEvent.click(desktopPanel().getByRole('button', { name: 'Delete task' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    expect(await screen.findByText(/do not have permission to delete this task/i)).toBeInTheDocument();
    // Still on the calendar - the delete never actually happened.
    expect(desktopPanel().getByText('Draft motion')).toBeInTheDocument();
  });
});

describe('a law firm switch while a request is pending', () => {
  it('never lets a slow response for the old firm land as the new firm\'s calendar', async () => {
    seedCalendarDefaults(FIRM_A, { matterEvents: [matterEvent({ title: 'Firm A Hearing' })] });
    seedCalendarDefaults(FIRM_B);
    api.get(`/lawfirms/${FIRM_B}/calendar-feed`, {
      delayMs: 200,
      body: calendarFeed({ matterEvents: [matterEvent({ id: 'me2', title: 'Firm B Hearing' })] }),
    });

    const { rerender } = renderCalendarPage(FIRM_A);
    await waitForCalendarLoaded();

    expect(desktopPanel().getByText('Firm A Hearing')).toBeInTheDocument();

    // Firm B's slow response is still in flight when the viewer switches firms.
    useParamsMock.mockReturnValue({ lawFirmId: FIRM_B });
    rerender(
      <FirmSettingsProvider lawFirmId={FIRM_B} initialSettings={{ features: { calendarSync: false } as never }}>
        <CalendarPage />
      </FirmSettingsProvider>,
    );

    // The firm-wide "next up" read keys only on lawFirmId and carries no
    // placeholder data, so it resets to loading the instant the firm switches
    // and the whole calendar (re-)shows its full skeleton very briefly. Wait
    // past that so the assertions below see the real grid, not the skeleton.
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());

    // Firm A's hearing must not keep rendering, full-opacity and clickable, as
    // though it belonged to firm B just because both windows cover the same
    // dates - firm B's matter-events read is still ~200ms from resolving.
    expect(desktopPanel().queryByText('Firm A Hearing')).not.toBeInTheDocument();

    await waitFor(() => expect(desktopPanel().queryByText('Firm B Hearing')).toBeInTheDocument());
    expect(desktopPanel().queryByText('Firm A Hearing')).not.toBeInTheDocument();
  });
});

it('retries the failed calendar range without navigating to another month', async () => {
  seedCalendarDefaults(FIRM_A);
  api.get(`/lawfirms/${FIRM_A}/calendar-feed`, { status: 500, body: { error: 'calendar service unavailable' } });
  let attempts = 0;
  api.get(`/lawfirms/${FIRM_A}/matters/events`, () => ++attempts === 1
    ? { status: 500, body: { error: 'calendar service unavailable' } }
    : { events: [], totalEvents: 0 });
  renderCalendarPage();
  expect(await screen.findByRole('alert')).toHaveTextContent('calendar service unavailable');
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(attempts).toBeGreaterThan(1);
});
