/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://app.paralegix.test"}
 *
 * Offline contract coverage for the layout-level calendar sync engine.
 *
 * No test file existed for this hook before. It is the actual "sync settings"
 * engine behind the calendar's Google/Outlook indicators: it reads
 * `useUserSyncSettings` (real, against a faked transport here) and drives the
 * two provider sync services independently. The docblock overrides jsdom's
 * default `http://localhost/` origin - the hook's own `isLocal` short-circuit
 * (`window.location.hostname === "localhost"`) exists to skip sync in local
 * dev and would otherwise make every case here a silent no-op.
 */
jest.unmock('@/services/settings.service');
jest.unmock('@/services/requestDeduplicator');

// Real imports of these two services statically pull in the initialized
// Firebase app (see AGENTS.md's Quirks section - they are the two named
// exceptions to the dynamic-import rule), which this suite has no Firebase
// environment for. A factory mock never evaluates the real module body. The
// jest.fn()s are built INSIDE each factory (rather than referencing an outer
// const) because jest.mock calls are hoisted above every other statement in
// the file, including const declarations - referencing one from the factory
// hits its temporal-dead-zone.
jest.mock('@/services/googleCalendarSync.service', () => ({
  GoogleCalendarSync: {
    initParalegixCalendar: jest.fn().mockResolvedValue({}),
    syncFromGoogle: jest.fn().mockResolvedValue({}),
  },
}));
jest.mock('@/services/outlookCalendarSync.service', () => ({
  OutlookCalendarSync: {
    initParalegixCalendar: jest.fn().mockResolvedValue({}),
    syncFromOutlook: jest.fn().mockResolvedValue({ success: true }),
  },
}));

import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import { useCalendarBackgroundSync } from '@/hooks/useCalendarBackgroundSync';
import { GoogleCalendarSync } from '@/services/googleCalendarSync.service';
import { OutlookCalendarSync } from '@/services/outlookCalendarSync.service';
import { FirmSettingsProvider } from '@/contexts/FirmSettingsContext';
import { makeTestQueryClient } from '../support/renderWithProviders';
import { setupApiMock } from '../support/apiMock';

// The real classes' static methods, recast as the jest.fn()s the mocks above
// actually installed.
const mockGoogleSync = GoogleCalendarSync as unknown as {
  initParalegixCalendar: jest.Mock;
  syncFromGoogle: jest.Mock;
};
const mockOutlookSync = OutlookCalendarSync as unknown as {
  initParalegixCalendar: jest.Mock;
  syncFromOutlook: jest.Mock;
};

const api = setupApiMock();

function syncFlagsResponse(overrides: Record<string, boolean> = {}) {
  return {
    preferences: {
      loggedInWithGoogle: true,
      allowGoogleToParalegixSync: true,
      loggedInWithMicrosoft: true,
      allowOutlookToParalegixSync: true,
      ...overrides,
    },
  };
}

/** Exposes the queryClient used by the tree, so a spec can assert on cache invalidation. */
let capturedQueryClient: ReturnType<typeof makeTestQueryClient>;

function createWrapper() {
  capturedQueryClient = makeTestQueryClient();
  return function TestWrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={capturedQueryClient}>
        <FirmSettingsProvider lawFirmId="firm-a" initialSettings={{}}>
          {children}
        </FirmSettingsProvider>
      </QueryClientProvider>
    );
  };
}

beforeEach(() => {
  window.localStorage.clear();
  mockGoogleSync.initParalegixCalendar.mockClear().mockResolvedValue({});
  mockGoogleSync.syncFromGoogle.mockClear().mockResolvedValue({});
  mockOutlookSync.initParalegixCalendar.mockClear().mockResolvedValue({});
  mockOutlookSync.syncFromOutlook.mockClear().mockResolvedValue({ success: true });
});

describe('useCalendarBackgroundSync offline contract', () => {
  it('is disabled without a firm - no settings request, no provider call', async () => {
    const { result } = renderHook(() => useCalendarBackgroundSync(undefined), { wrapper: createWrapper() });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(api.calls('GET')).toHaveLength(0);
    expect(mockGoogleSync.syncFromGoogle).not.toHaveBeenCalled();
    expect(mockOutlookSync.syncFromOutlook).not.toHaveBeenCalled();
    expect(result.current).toEqual({ syncingGoogle: false, syncingOutlook: false, outlookError: null });
  });

  describe('disconnect', () => {
    it('never calls a provider whose sync-to-Paralegix flag is off, even when the account is still linked', async () => {
      api.get('/settings/user', syncFlagsResponse({ allowGoogleToParalegixSync: false }));

      renderHook(() => useCalendarBackgroundSync('firm-a'), { wrapper: createWrapper() });

      await waitFor(() => expect(mockOutlookSync.syncFromOutlook).toHaveBeenCalledWith('firm-a'));
      // Google is still "loggedInWithGoogle: true" (the account link survives),
      // but the disconnect toggle (`allowGoogleToParalegixSync: false`) must
      // stop the engine from calling Google at all - a disconnected provider's
      // sync must not keep running against stale cached flags.
      expect(mockGoogleSync.syncFromGoogle).not.toHaveBeenCalled();
    });

    it('never calls a provider that was never linked', async () => {
      api.get('/settings/user', syncFlagsResponse({ loggedInWithMicrosoft: false, allowOutlookToParalegixSync: false }));

      renderHook(() => useCalendarBackgroundSync('firm-a'), { wrapper: createWrapper() });

      await waitFor(() => expect(mockGoogleSync.syncFromGoogle).toHaveBeenCalledWith('firm-a'));
      expect(mockOutlookSync.syncFromOutlook).not.toHaveBeenCalled();
    });
  });

  describe('partial provider failure', () => {
    it('an Outlook failure does not block or misreport the Google sync that succeeded', async () => {
      api.get('/settings/user', syncFlagsResponse());
      mockOutlookSync.syncFromOutlook.mockResolvedValue({ success: false, error: 'Outlook grant expired' });

      const { result } = renderHook(() => useCalendarBackgroundSync('firm-a'), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.outlookError).toBe('Outlook grant expired'));
      // Google's own success path is independent: it must have run and settled
      // with no trace of Outlook's failure.
      await waitFor(() => expect(mockGoogleSync.syncFromGoogle).toHaveBeenCalledWith('firm-a'));
      await waitFor(() => expect(result.current.syncingGoogle).toBe(false));
      expect(result.current.syncingOutlook).toBe(false);
    });

    it('a Google failure does not block or misreport the Outlook sync that succeeded', async () => {
      api.get('/settings/user', syncFlagsResponse());
      mockGoogleSync.syncFromGoogle.mockRejectedValue(new Error('Google grant expired'));

      const { result } = renderHook(() => useCalendarBackgroundSync('firm-a'), { wrapper: createWrapper() });

      await waitFor(() => expect(mockOutlookSync.syncFromOutlook).toHaveBeenCalledWith('firm-a'));
      await waitFor(() => expect(result.current.outlookError).toBeNull());
      await waitFor(() => expect(result.current.syncingGoogle).toBe(false));
      // A thrown Google failure carries no dedicated error slot on this hook's
      // return value (see `googleCalendarSync.service`'s own reconnect-event
      // mechanism for that surface) - what matters here is that it does not
      // leak into Outlook's state.
      expect(result.current.syncingOutlook).toBe(false);
    });
  });

  describe('calendar data refresh', () => {
    it('invalidates tasks and external events after a successful Google import', async () => {
      api.get('/settings/user', syncFlagsResponse({
        loggedInWithMicrosoft: false, allowOutlookToParalegixSync: false,
      }));
      const wrapper = createWrapper();
      const invalidate = jest.spyOn(capturedQueryClient, 'invalidateQueries');

      renderHook(() => useCalendarBackgroundSync('firm-a'), { wrapper });

      await waitFor(() => expect(mockGoogleSync.syncFromGoogle).toHaveBeenCalledWith('firm-a'));
      await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['externalEvents', 'firm-a'] }));
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tasks', 'firm-a'] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['matterEvents', 'firm-a'] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['clientEvents', 'firm-a'] });
      expect(mockOutlookSync.syncFromOutlook).not.toHaveBeenCalled();
    });

    it('retries Google after a failed import instead of recording a successful sync', async () => {
      api.get('/settings/user', syncFlagsResponse({
        loggedInWithMicrosoft: false, allowOutlookToParalegixSync: false,
      }));
      mockGoogleSync.syncFromGoogle.mockRejectedValueOnce(new Error('temporary Google failure'));
      const wrapper = createWrapper();

      const first = renderHook(() => useCalendarBackgroundSync('firm-a'), { wrapper });
      await waitFor(() => expect(mockGoogleSync.syncFromGoogle).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(first.result.current.syncingGoogle).toBe(false));
      first.unmount();

      renderHook(() => useCalendarBackgroundSync('firm-a'), { wrapper });
      await waitFor(() => expect(mockGoogleSync.syncFromGoogle).toHaveBeenCalledTimes(2));
    });
  });

  describe('tab visibility', () => {
    let hidden = false;
    beforeAll(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    });
    afterEach(() => { hidden = false; });
    afterAll(() => { delete (document as unknown as { hidden?: boolean }).hidden; });

    /** Mounts the hook in a hidden tab and waits until its sync effect has run with the loaded flags. */
    async function mountHidden() {
      hidden = true;
      api.get('/settings/user', syncFlagsResponse());
      const wrapper = createWrapper();
      renderHook(() => useCalendarBackgroundSync('firm-a'), { wrapper });
      await waitFor(() => expect(capturedQueryClient.getQueryData(['userSyncSettings', 'firm-a'])).toBeDefined());
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }

    it('does not sync either provider while the tab is hidden', async () => {
      await mountHidden();
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });

      expect(capturedQueryClient.getQueryData(['userSyncSettings', 'firm-a'])).toMatchObject({ loggedInWithGoogle: true });
      expect(mockGoogleSync.syncFromGoogle).not.toHaveBeenCalled();
      expect(mockOutlookSync.syncFromOutlook).not.toHaveBeenCalled();
    });

    it('syncs both providers when a hidden tab becomes visible again', async () => {
      await mountHidden();
      expect(mockGoogleSync.syncFromGoogle).not.toHaveBeenCalled();

      hidden = false;
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });

      await waitFor(() => expect(mockGoogleSync.syncFromGoogle).toHaveBeenCalledWith('firm-a'));
      await waitFor(() => expect(mockOutlookSync.syncFromOutlook).toHaveBeenCalledWith('firm-a'));
    });
  });

  describe('recovery', () => {
    it('refetching updated sync settings (e.g. after a reconnect) is reflected on the next interval tick without remounting', async () => {
      api.get('/settings/user', syncFlagsResponse({ allowGoogleToParalegixSync: false }));

      const { result } = renderHook(() => useCalendarBackgroundSync('firm-a'), { wrapper: createWrapper() });
      await waitFor(() => expect(mockOutlookSync.syncFromOutlook).toHaveBeenCalledTimes(1));
      expect(mockGoogleSync.syncFromGoogle).not.toHaveBeenCalled();

      // Simulate the settings page's reconnect flow invalidating the shared
      // cache: the next read reflects Google being allowed again.
      api.get('/settings/user', syncFlagsResponse());
      await act(async () => {
        await capturedQueryClient.invalidateQueries({ queryKey: ['userSyncSettings', 'firm-a'] });
      });

      await waitFor(() => expect(mockGoogleSync.syncFromGoogle).toHaveBeenCalledWith('firm-a'));
      void result;
    });
  });
});
