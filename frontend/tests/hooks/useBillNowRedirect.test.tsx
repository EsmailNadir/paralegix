/**
 * `useBillNowRedirect`: where "save and bill now" on a time entry sends the
 * person.
 *
 * The tasks grid, the task detail page and the matter tasks tab all use it, so
 * the url it builds is the one contract behind three entry points. The invoice
 * composer reads the query string to preload the draft and pick who it bills:
 * one matter client directly, several as a split. A dropped parameter loads an
 * empty composer that looks like a normal one, and a url built under the wrong
 * firm opens another firm's composer.
 *
 * What has to break for these to go red: `onDone` not running on every save
 * (or after navigating), a plain save navigating, the matter/client choice,
 * the split-versus-single rule, or a stale firm captured by the callback.
 */
const mockNavigate = jest.fn();
jest.mock('@/contexts/NavigationContext', () => ({
  __esModule: true,
  useNavigation: () => ({ navigate: mockNavigate, isNavigating: false }),
}));

import { renderHook } from '@testing-library/react';

import { grantPermissions, resetPermissions } from '../support/permissions';

import { useBillNowRedirect, type AddTimeEntryResult } from '@/hooks/billingHooks/useBillNowRedirect';
import type { BillingReadyItem, TimeEntry } from '@/types';

beforeEach(() => {
  mockNavigate.mockReset();
});

afterEach(() => {
  resetPermissions();
});

function saved(draftItem?: Partial<BillingReadyItem>, shouldBillNow = true): AddTimeEntryResult {
  return {
    createdEntry: { id: 'te-1' } as unknown as TimeEntry,
    shouldBillNow,
    draftItem: draftItem as BillingReadyItem | undefined,
  };
}

/** The navigated url split into path and parsed query, so order does not matter. */
function navigated() {
  expect(mockNavigate).toHaveBeenCalledTimes(1);
  const [path, query = ''] = String(mockNavigate.mock.calls[0][0]).split('?');
  return { path, query: Object.fromEntries(new URLSearchParams(query)) };
}

describe('a save that is not billed now', () => {
  it.each([
    ['no result at all', undefined],
    ['bill now not chosen', saved({ matterId: 'm1', timeEntryId: 'te-1' }, false)],
    ['bill now chosen with no draft', saved(undefined)],
  ])('runs onDone and stays put: %s', (_label, result) => {
    const onDone = jest.fn();
    const { result: hook } = renderHook(() => useBillNowRedirect('firm-a', onDone));

    hook.current(result);

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe('a save billed now', () => {
  it('opens the matter invoice composer with the draft and its single bill-to client', () => {
    const { result } = renderHook(() => useBillNowRedirect('firm-a'));

    result.current(saved({ matterId: 'm1', clientId: 'c1', timeEntryId: 'te-1', matterClientId: 'mc-1' }));

    expect(navigated()).toEqual({
      path: '/lawfirm/firm-a/matters/m1/generate-invoice',
      query: { draftType: 'time_entry', draftId: 'te-1', billToMatterClientId: 'mc-1' },
    });
  });

  it('opens the composer in split mode when the matter bills several clients', () => {
    const { result } = renderHook(() => useBillNowRedirect('firm-a'));

    result.current(saved({
      matterId: 'm1',
      timeEntryId: 'te-1',
      matterClientId: 'mc-1',
      matterClientIds: ['mc-1', 'mc-2'],
    }));

    // Split wins over the single bill-to, which is not sent alongside it.
    expect(navigated()).toEqual({
      path: '/lawfirm/firm-a/matters/m1/generate-invoice',
      query: { draftType: 'time_entry', draftId: 'te-1', mode: 'split', preferredMatterClientIds: 'mc-1,mc-2' },
    });
  });

  it('treats a one-client list as a single bill-to, not a split', () => {
    const { result } = renderHook(() => useBillNowRedirect('firm-a'));

    result.current(saved({ matterId: 'm1', timeEntryId: 'te-1', matterClientId: 'mc-1', matterClientIds: ['mc-1'] }));

    expect(navigated().query).toEqual({ draftType: 'time_entry', draftId: 'te-1', billToMatterClientId: 'mc-1' });
  });

  it('opens the client invoice composer for work with no matter', () => {
    const { result } = renderHook(() => useBillNowRedirect('firm-a'));

    result.current(saved({ clientId: 'c1', timeEntryId: 'te-1' }));

    expect(navigated()).toEqual({
      path: '/lawfirm/firm-a/clients/c1/generate-invoice',
      query: { draftType: 'time_entry', draftId: 'te-1' },
    });
  });

  // Red if: only `matterId`/`clientId` are read, so a draft that names its
  // context the way the rest of billing does (`contextType` + `entityId`) goes
  // nowhere.
  it.each([
    ['matter', '/lawfirm/firm-a/matters/m9/generate-invoice', 'm9'],
    ['client', '/lawfirm/firm-a/clients/c9/generate-invoice', 'c9'],
  ] as const)('opens the %s composer for a draft named only by its context', (contextType, path, entityId) => {
    const { result } = renderHook(() => useBillNowRedirect('firm-a'));

    result.current(saved({ contextType, entityId, timeEntryId: 'te-1' }));

    expect(navigated()).toEqual({ path, query: { draftType: 'time_entry', draftId: 'te-1' } });
  });

  it('sends no query string when there is nothing to preload', () => {
    const { result } = renderHook(() => useBillNowRedirect('firm-a'));

    result.current(saved({ matterId: 'm1' }));

    expect(mockNavigate).toHaveBeenCalledWith('/lawfirm/firm-a/matters/m1/generate-invoice');
  });

  it('goes nowhere for a draft with neither a matter nor a client', () => {
    const onDone = jest.fn();
    const { result } = renderHook(() => useBillNowRedirect('firm-a', onDone));

    result.current(saved({ timeEntryId: 'te-1' }));

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('closes the modal before navigating away', () => {
    const order: string[] = [];
    mockNavigate.mockImplementation(() => order.push('navigate'));
    const { result } = renderHook(() => useBillNowRedirect('firm-a', () => order.push('onDone')));

    result.current(saved({ matterId: 'm1', timeEntryId: 'te-1' }));

    expect(order).toEqual(['onDone', 'navigate']);
  });

  it('builds the url under the current firm after the firm changes', () => {
    const { result, rerender } = renderHook(({ firm }: { firm: string }) => useBillNowRedirect(firm), {
      initialProps: { firm: 'firm-a' },
    });

    rerender({ firm: 'firm-b' });
    result.current(saved({ matterId: 'm1', timeEntryId: 'te-1' }));

    expect(navigated().path).toBe('/lawfirm/firm-b/matters/m1/generate-invoice');
  });
});

describe('the invoice composer permission', () => {
  const draft = { matterId: 'm1', timeEntryId: 'te-1' };

  it('saves and closes without redirecting when billing.manageInvoices is not held', () => {
    grantPermissions(['billing.manageTimeEntries']);
    const onDone = jest.fn();
    const { result } = renderHook(() => useBillNowRedirect('firm-a', onDone));

    result.current(saved(draft));

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('redirects to the composer when billing.manageInvoices is held', () => {
    grantPermissions(['billing.manageTimeEntries', 'billing.manageInvoices']);
    const { result } = renderHook(() => useBillNowRedirect('firm-a'));

    result.current(saved(draft));

    expect(navigated().path).toBe('/lawfirm/firm-a/matters/m1/generate-invoice');
  });
});
