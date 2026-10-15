jest.unmock('@/services/settings.service');
jest.unmock('@/services/requestDeduplicator');

import { useLayoutEffect } from 'react';
import { act, waitFor } from '@testing-library/react';
import { PreferencesProvider, usePreferences } from '@/contexts/PreferencesContext';
import { FirmSettingsProvider } from '@/contexts/FirmSettingsContext';
import { setupApiMock } from '../support/apiMock';
import { holdResponse } from '../support/deferred';
import { renderWithProviders } from '../support/renderWithProviders';

// The Templates page offers three template experiences and remembers which one
// each person last picked. The choice rides on the user's own preferences, so
// it reaches the server through the same settings endpoint as the theme.
const api = setupApiMock();
const userUrl = (firm: string) => `/api/settings/user?lawFirmId=${firm}`;
let current: ReturnType<typeof usePreferences>;
function Probe() {
  const value = usePreferences();
  useLayoutEffect(() => { current = value; });
  return null;
}
const tree = (firm: string) => (
  <FirmSettingsProvider lawFirmId={firm} initialSettings={{}}>
    <PreferencesProvider lawFirmId={firm}><Probe /></PreferencesProvider>
  </FirmSettingsProvider>
);
beforeEach(() => { localStorage.clear(); process.env.NEXT_PUBLIC_DUP_FETCH_WARN = 'off'; });
afterEach(() => { delete process.env.NEXT_PUBLIC_DUP_FETCH_WARN; });

it('defaults to the overlay version when nothing is saved', async () => {
  api.getExact(userUrl('a'), { preferences: {} });
  renderWithProviders(tree('a'));
  await waitFor(() => expect(current.loading).toBe(false));
  expect(current.templateVersion).toBe('overlay');
});

it.each(['full-editor', 'word-first'] as const)('restores a saved %s choice', async (saved) => {
  api.getExact(userUrl('a'), { preferences: { templateVersion: saved } });
  renderWithProviders(tree('a'));
  await waitFor(() => expect(current.templateVersion).toBe(saved));
});

it('falls back to overlay for a value it does not know', async () => {
  api.getExact(userUrl('a'), { preferences: { templateVersion: 'packets' } });
  renderWithProviders(tree('a'));
  await waitFor(() => expect(current.loading).toBe(false));
  expect(current.templateVersion).toBe('overlay');
});

it('saves a new choice to the user settings endpoint and shows it at once', async () => {
  api.getExact(userUrl('a'), { preferences: {} });
  const save = holdResponse();
  api.postExact(userUrl('a'), save.handler);
  renderWithProviders(tree('a'));
  await waitFor(() => expect(current.loading).toBe(false));

  let saved!: Promise<void>;
  act(() => { saved = current.updateTemplateVersion('word-first'); });
  await save.untilRequested();
  expect(current.templateVersion).toBe('word-first');
  const [call] = api.calls('POST');
  expect(call.body).toEqual({ preferences: { templateVersion: 'word-first' } });

  await act(async () => { save.release({ preferences: { templateVersion: 'word-first' } }); await saved; });
  expect(current.templateVersion).toBe('word-first');
});

it('rolls a refused save back to the version that was showing', async () => {
  api.getExact(userUrl('a'), { preferences: { templateVersion: 'full-editor' } });
  api.postExact(userUrl('a'), { status: 500, body: { error: 'nope' } });
  renderWithProviders(tree('a'));
  await waitFor(() => expect(current.templateVersion).toBe('full-editor'));

  await act(async () => {
    await current.updateTemplateVersion('word-first').catch(() => {});
  });
  expect(current.templateVersion).toBe('full-editor');
});
