jest.unmock('@/services/settings.service');
jest.unmock('@/services/requestDeduplicator');

import { useLayoutEffect } from 'react';
import { act, waitFor } from '@testing-library/react';
import { PreferencesProvider, usePreferences } from '@/contexts/PreferencesContext';
import { FirmSettingsProvider, useFirmSettings } from '@/contexts/FirmSettingsContext';
import { DEFAULT_DASHBOARD_PREFERENCES, DEFAULT_SIDEBAR_PREFERENCES, DEFAULT_FIRM_FEATURES, type FirmSettings } from '@/types/preferences';
import { setupApiMock } from '../support/apiMock';
import { holdResponse } from '../support/deferred';
import { renderWithProviders } from '../support/renderWithProviders';

const api = setupApiMock();
const userUrl = (firm: string) => `/api/settings/user?lawFirmId=${firm}`;
const firmUrl = (firm: string) => `/api/lawfirms/${firm}/settings/firm`;
let current: ReturnType<typeof usePreferences>;
let firm: ReturnType<typeof useFirmSettings>;
function Probe() {
  const value = usePreferences();
  const firmValue = useFirmSettings();
  useLayoutEffect(() => { current = value; firm = firmValue; });
  return null;
}
function tree(firm: string, settings: Partial<FirmSettings> = {}) {
  return <FirmSettingsProvider lawFirmId={firm} initialSettings={settings}>
    <PreferencesProvider lawFirmId={firm}><Probe /></PreferencesProvider>
  </FirmSettingsProvider>;
}
beforeEach(() => { localStorage.clear(); process.env.NEXT_PUBLIC_DUP_FETCH_WARN = 'off'; });
afterEach(() => { delete process.env.NEXT_PUBLIC_DUP_FETCH_WARN; });

it('holds all preference writes until the saved user preferences arrive', async () => {
  const load = holdResponse();
  api.getExact(userUrl('a'), load.handler);
  renderWithProviders(tree('a'));
  await load.untilRequested();
  await act(async () => {
    await current.updateTheme('dark');
    await current.updateSidebarPreferences(DEFAULT_SIDEBAR_PREFERENCES);
    await current.updateDashboardPreferences(DEFAULT_DASHBOARD_PREFERENCES);
  });
  expect(api.calls('POST')).toHaveLength(0);
  expect(api.calls('PUT')).toHaveLength(0);
  await act(async () => load.release({ preferences: { theme: 'light' } }));
  await waitFor(() => expect(current.loading).toBe(false));
  expect(current.theme).toBe('light');
});

it('applies a firm theme lock after the user theme loads and refuses writes', async () => {
  api.getExact(userUrl('a'), { preferences: { theme: 'dark' } });
  const { rerender } = renderWithProviders(tree('a'));
  await waitFor(() => expect(current.theme).toBe('dark'));
  rerender(tree('a', { locks: { theme: true, sidebar: true }, lockedSettings: { theme: 'light' } }));
  await waitFor(() => expect(current.theme).toBe('light'));
  await act(async () => {
    await current.updateTheme('dark');
    await current.updateSidebarPreferences(DEFAULT_SIDEBAR_PREFERENCES);
  });
  expect(api.calls('POST')).toHaveLength(0);
  expect(api.calls('PUT')).toHaveLength(0);
  expect(localStorage.getItem('paralegix-theme')).toBe('light');
});

it.each(['theme', 'sidebar', 'dashboard'] as const)('rolls a refused %s save back to the stored value', async (kind) => {
  api.getExact(userUrl('a'), { preferences: { theme: 'light' } });
  const save = holdResponse();
  if (kind === 'sidebar') api.putExact(firmUrl('a'), save.handler);
  else api.postExact(userUrl('a'), save.handler);
  renderWithProviders(tree('a'));
  await waitFor(() => expect(current.loading).toBe(false));
  const previous = current[kind];
  const nextSidebar = { items: [{ key: 'tasks' as const, visible: false }] };
  const nextDashboard = { widgets: [{ key: 'hero' as const, visible: false }] };
  let saved!: Promise<unknown>;
  act(() => {
    saved = (kind === 'theme' ? current.updateTheme('dark')
      : kind === 'sidebar' ? current.updateSidebarPreferences(nextSidebar)
        : current.updateDashboardPreferences(nextDashboard)).catch((error: unknown) => error);
  });
  await save.untilRequested();
  expect(current[kind]).not.toEqual(previous);
  await act(async () => { save.release({ status: 403, body: { error: 'Refused' } }); await saved; });
  expect(current[kind]).toEqual(previous);
  if (kind === 'theme') expect(localStorage.getItem('paralegix-theme')).toBe(previous);
  if (kind === 'sidebar') expect(JSON.parse(localStorage.getItem('paralegix-sidebar:a')!)).toEqual(previous);
});

it.each(['theme', 'sidebar', 'dashboard'] as const)('does not roll a failed old-firm %s save into the next firm', async (kind) => {
  api.getExact(userUrl('a'), { preferences: { theme: 'light' } });
  api.getExact(userUrl('b'), { preferences: { theme: 'dark', dashboard: { widgets: [{ key: 'hero', visible: false }] } } });
  const save = holdResponse();
  if (kind === 'sidebar') api.putExact(firmUrl('a'), save.handler);
  else api.postExact(userUrl('a'), save.handler);
  const { rerender } = renderWithProviders(tree('a'));
  await waitFor(() => expect(current.loading).toBe(false));
  let saved!: Promise<unknown>;
  act(() => {
    saved = (kind === 'theme' ? current.updateTheme('dark')
      : kind === 'sidebar' ? current.updateSidebarPreferences({ items: [] })
        : current.updateDashboardPreferences({ widgets: [] })).catch((error: unknown) => error);
  });
  await save.untilRequested();
  rerender(tree('b', { sidebar: { items: [{ key: 'tasks', visible: false }] } }));
  await waitFor(() => expect(current.loading).toBe(false));
  expect(current.theme).toBe('dark');
  const expected = current[kind];
  await act(async () => { save.release({ status: 403, body: { error: 'Old firm refused' } }); await saved; });
  expect(current[kind]).toEqual(expected);
  expect(localStorage.getItem('paralegix-theme')).toBe('dark');
});

it('ignores a pending user-settings response after switching firms', async () => {
  const old = holdResponse();
  api.getExact(userUrl('a'), old.handler);
  api.getExact(userUrl('b'), { preferences: { theme: 'dark' } });
  const { rerender } = renderWithProviders(tree('a'));
  await old.untilRequested();
  rerender(tree('b'));
  await waitFor(() => expect(current.theme).toBe('dark'));
  await act(async () => old.release({ preferences: { theme: 'light' } }));
  expect(current.theme).toBe('dark');
});

it.each(['theme', 'sidebar', 'dashboard'] as const)('preserves a newer saved %s when an older save fails', async (kind) => {
  api.getExact(userUrl('a'), { preferences: { theme: 'light' } });
  const first = holdResponse();
  const second = holdResponse();
  let requests = 0;
  const handler = () => (++requests === 1 ? first.handler() : second.handler());
  if (kind === 'sidebar') api.putExact(firmUrl('a'), handler);
  else api.postExact(userUrl('a'), handler);
  renderWithProviders(tree('a'));
  await waitFor(() => expect(current.loading).toBe(false));
  const save = (newer: boolean) => (kind === 'theme' ? current.updateTheme(newer ? 'system' : 'dark')
    : kind === 'sidebar' ? current.updateSidebarPreferences({ items: [{ key: 'tasks', visible: newer }] })
      : current.updateDashboardPreferences({ widgets: [{ key: 'hero', visible: newer }] })).catch((error: unknown) => error);
  let old!: Promise<unknown>;
  act(() => { old = save(false); });
  await first.untilRequested();
  let latest!: Promise<unknown>;
  act(() => { latest = save(true); });
  await second.untilRequested();
  await act(async () => { second.release({ success: true }); await latest; });
  const expected = current[kind];
  await act(async () => { first.release({ status: 403, body: { error: 'Refused' } }); await old; });
  expect(current[kind]).toEqual(expected);
  if (kind === 'theme') expect(localStorage.getItem('paralegix-theme')).toBe(expected);
  if (kind === 'sidebar') expect(JSON.parse(localStorage.getItem('paralegix-sidebar:a')!)).toEqual(expected);
});

it.each(['old-first', 'new-first'] as const)('keeps a repeated theme choice after an older refusal (%s)', async (order) => {
  api.getExact(userUrl('a'), { preferences: { theme: 'light' } });
  const first = holdResponse();
  const second = holdResponse();
  let requests = 0;
  api.postExact(userUrl('a'), () => (++requests === 1 ? first.handler() : second.handler()));
  renderWithProviders(tree('a'));
  await waitFor(() => expect(current.loading).toBe(false));
  let old!: Promise<unknown>;
  act(() => { old = current.updateTheme('dark').catch((error: unknown) => error); });
  await first.untilRequested();
  let latest!: Promise<unknown>;
  act(() => { latest = current.updateTheme('dark'); });
  await second.untilRequested();
  const refuseOld = () => act(async () => { first.release({ status: 403, body: { error: 'Refused' } }); await old; });
  const saveLatest = () => act(async () => { second.release({ success: true }); await latest; });
  if (order === 'old-first') { await refuseOld(); await saveLatest(); }
  else { await saveLatest(); await refuseOld(); }
  expect(current.theme).toBe('dark');
  expect(localStorage.getItem('paralegix-theme')).toBe('dark');
});

it.each([
  ['theme', 'old-first'], ['theme', 'new-first'],
  ['sidebar', 'old-first'], ['sidebar', 'new-first'],
  ['dashboard', 'old-first'], ['dashboard', 'new-first'],
] as const)('restores stored %s when both overlapping saves fail (%s)', async (kind, order) => {
  api.getExact(userUrl('a'), { preferences: { theme: 'light' } });
  const first = holdResponse();
  const second = holdResponse();
  let requests = 0;
  const handler = () => (++requests === 1 ? first.handler() : second.handler());
  if (kind === 'sidebar') api.putExact(firmUrl('a'), handler);
  else api.postExact(userUrl('a'), handler);
  renderWithProviders(tree('a'));
  await waitFor(() => expect(current.loading).toBe(false));
  const stored = current[kind];
  const save = (newer: boolean) => (kind === 'theme' ? current.updateTheme(newer ? 'system' : 'dark')
    : kind === 'sidebar' ? current.updateSidebarPreferences({ items: [{ key: 'tasks', visible: newer }] })
      : current.updateDashboardPreferences({ widgets: [{ key: 'hero', visible: newer }] })).catch((error: unknown) => error);
  let old!: Promise<unknown>;
  act(() => { old = save(false); });
  await first.untilRequested();
  let latest!: Promise<unknown>;
  act(() => { latest = save(true); });
  await second.untilRequested();
  const failOld = () => act(async () => { first.release({ status: 403, body: { error: 'Refused' } }); await old; });
  const failLatest = () => act(async () => { second.release({ status: 403, body: { error: 'Refused' } }); await latest; });
  if (order === 'old-first') { await failOld(); await failLatest(); }
  else { await failLatest(); await failOld(); }
  expect(current[kind]).toEqual(stored);
  if (kind === 'theme') expect(localStorage.getItem('paralegix-theme')).toBe(stored);
  if (kind === 'sidebar') expect(JSON.parse(localStorage.getItem('paralegix-sidebar:a')!)).toEqual(stored);
});

it('keeps a firm-locked theme when a pending save succeeds', async () => {
  api.getExact(userUrl('a'), { preferences: { theme: 'light' } });
  const pending = holdResponse();
  api.postExact(userUrl('a'), pending.handler);
  const { rerender } = renderWithProviders(tree('a'));
  await waitFor(() => expect(current.loading).toBe(false));
  let saved!: Promise<unknown>;
  act(() => { saved = current.updateTheme('dark'); });
  await pending.untilRequested();
  rerender(tree('a', { locks: { theme: true }, lockedSettings: { theme: 'system' } }));
  await waitFor(() => expect(current.theme).toBe('system'));
  await act(async () => { pending.release({ success: true }); await saved; });
  expect(current.theme).toBe('system');
  expect(localStorage.getItem('paralegix-theme')).toBe('system');
});

describe('a saved sidebar and the shared firm settings', () => {
  const edited = { items: [{ key: 'tasks' as const, visible: false }] };

  it('reaches the firm settings, so a lock captures the layout on screen', async () => {
    api.getExact(userUrl('a'), { preferences: {} });
    api.putExact(firmUrl('a'), { success: true });
    renderWithProviders(tree('a'));
    await waitFor(() => expect(current.loading).toBe(false));

    await act(async () => { await current.updateSidebarPreferences(edited); });

    // The customization page locks `firm.settings.sidebar`; a stale copy there
    // locked the layout from before the edit.
    expect(firm.settings.sidebar.items.find((item) => item.key === 'tasks')?.visible).toBe(false);
    expect(current.sidebar.items.find((item) => item.key === 'tasks')?.visible).toBe(false);
  });

  it('survives a later, unrelated firm settings save', async () => {
    api.getExact(userUrl('a'), { preferences: {} });
    api.putExact(firmUrl('a'), { success: true });
    renderWithProviders(tree('a'));
    await waitFor(() => expect(current.loading).toBe(false));
    await act(async () => { await current.updateSidebarPreferences(edited); });
    const saved = current.sidebar;

    // A billing or feature save goes through the firm settings context, which
    // used to still hold the pre-edit sidebar and pushed it back on screen.
    await act(async () => { await firm.updateFirmSettings({ timezone: 'America/Chicago' } as never); });

    expect(current.sidebar).toEqual(saved);
    expect(JSON.parse(localStorage.getItem('paralegix-sidebar:a')!)).toEqual(saved);
  });
});

it('retains a saved theme when unrelated firm settings refresh', async () => {
  api.getExact(userUrl('a'), { preferences: { theme: 'light' } });
  api.postExact(userUrl('a'), { success: true });
  const { rerender } = renderWithProviders(tree('a'));
  await waitFor(() => expect(current.loading).toBe(false));
  await act(async () => { await current.updateTheme('dark'); });
  expect(current.theme).toBe('dark');
  rerender(tree('a', { features: { ...DEFAULT_FIRM_FEATURES, analytics: false } }));
  await waitFor(() => expect(current.theme).toBe('dark'));
  expect(localStorage.getItem('paralegix-theme')).toBe('dark');
});
