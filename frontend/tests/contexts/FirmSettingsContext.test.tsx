jest.unmock('@/services/settings.service');
jest.unmock('@/services/requestDeduplicator');

import { useLayoutEffect } from 'react';
import { act, waitFor } from '@testing-library/react';
import { FirmSettingsProvider, useFirmSettings } from '@/contexts/FirmSettingsContext';
import { setupApiMock } from '../support/apiMock';
import { holdResponse } from '../support/deferred';
import { renderWithProviders } from '../support/renderWithProviders';
import type { FirmSettings } from '@/types/preferences';

const api = setupApiMock();
beforeEach(() => { process.env.NEXT_PUBLIC_DUP_FETCH_WARN = 'off'; });
afterEach(() => { delete process.env.NEXT_PUBLIC_DUP_FETCH_WARN; });
const url = (firm: string) => `/api/lawfirms/${firm}/settings/firm`;
let current: ReturnType<typeof useFirmSettings>;
function Probe() {
  const value = useFirmSettings();
  useLayoutEffect(() => { current = value; });
  return null;
}
function tree(firm: string, initialSettings?: Partial<FirmSettings>) {
  return <FirmSettingsProvider lawFirmId={firm} initialSettings={initialSettings}><Probe /></FirmSettingsProvider>;
}

it.each(['success', 'failure'] as const)('does not apply a late unseeded %s from the previous firm', async (outcome) => {
  const old = holdResponse();
  api.getExact(url('a'), old.handler);
  api.getExact(url('b'), { settings: { features: { trustAccounting: false }, locks: { theme: true } } });
  const { rerender } = renderWithProviders(tree('a'));
  await old.untilRequested();
  rerender(tree('b'));
  await waitFor(() => expect(current.loading).toBe(false));
  expect(current.features.trustAccounting).toBe(false);
  await act(async () => old.release(outcome === 'success'
    ? { settings: { features: { trustAccounting: true }, locks: {} } }
    : { status: 500, body: { error: 'Old firm unavailable' } }));
  expect(current.features.trustAccounting).toBe(false);
  expect(current.isLocked('theme')).toBe(true);
});

it('does not apply a late refresh over another firm seeded settings', async () => {
  const old = holdResponse();
  api.getExact(url('a'), old.handler);
  const { rerender } = renderWithProviders(tree('a', { locks: {} }));
  let refresh!: Promise<void>;
  act(() => { refresh = current.refresh(); });
  await old.untilRequested();
  rerender(tree('b', { locks: { sidebar: true } }));
  await act(async () => { old.release({ settings: { locks: {} } }); await refresh; });
  expect(current.isLocked('sidebar')).toBe(true);
  expect(current.loading).toBe(false);
});

it('restores the previous settings when an optimistic save is refused', async () => {
  const save = holdResponse();
  api.putExact(url('a'), save.handler);
  renderWithProviders(tree('a', { locks: { theme: true } }));
  let outcome!: Promise<unknown>;
  act(() => { outcome = current.updateFirmSettings({ locks: { theme: false } }).catch((error: unknown) => error); });
  await save.untilRequested();
  expect(current.isLocked('theme')).toBe(false);
  await act(async () => save.release({ status: 403, body: { error: 'Locked by administrator' } }));
  expect(await outcome).toBeInstanceOf(Error);
  expect(current.isLocked('theme')).toBe(true);
  expect(api.calls('PUT')[0].body).toEqual({ settings: { locks: { theme: false } } });
});

it('does not roll a refused old-firm save back into the new firm', async () => {
  const save = holdResponse();
  api.putExact(url('a'), save.handler);
  const { rerender } = renderWithProviders(tree('a', { locks: { theme: true } }));
  let outcome!: Promise<unknown>;
  act(() => { outcome = current.updateFirmSettings({ locks: {} }).catch((error: unknown) => error); });
  await save.untilRequested();
  rerender(tree('b', { locks: { sidebar: true } }));
  await act(async () => { save.release({ status: 403, body: { error: 'Refused' } }); await outcome; });
  expect(current.isLocked('theme')).toBe(false);
  expect(current.isLocked('sidebar')).toBe(true);
});
