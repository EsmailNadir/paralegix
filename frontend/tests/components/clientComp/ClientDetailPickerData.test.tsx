/**
 * `ClientDetail` loads the firm user roster and courts only for its closed
 * create-matter and create-task modals, so a visit to a client must not
 * request either until one of those modals opens.
 *
 * What has to break for this to go red: either hook called without its
 * `enabled` flag tied to the modals' open state.
 */

// No client record: the page stops at its not-found state, which is enough, as
// the hooks under test run before it decides what to draw.
jest.mock('@/services/clients.service', () => ({
  __esModule: true,
  default: new Proxy({}, { get: (_target, prop) => (prop === 'getClient' ? async () => null : jest.fn().mockResolvedValue({})) }),
}));

const mockUseCourtsArgs = jest.fn();
const mockUseLawFirmUsersArgs = jest.fn();

jest.mock('@/hooks/courtHooks/useCourts', () => {
  const actual = jest.requireActual('@/hooks/courtHooks/useCourts');
  return {
    __esModule: true,
    default: (...args: unknown[]) => {
      mockUseCourtsArgs(...args);
      return actual.default(...args);
    },
  };
});

jest.mock('@/hooks/useUsers', () => {
  const actual = jest.requireActual('@/hooks/useUsers');
  return {
    __esModule: true,
    ...actual,
    useLawFirmUsers: (...args: unknown[]) => {
      mockUseLawFirmUsersArgs(...args);
      return actual.useLawFirmUsers(...args);
    },
  };
});

import React from 'react';
import ClientDetail from '@/components/clientComp/ClientDetail';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installApiMock } from '../../support/apiMock';

describe('ClientDetail picker data', () => {
  it('asks for no courts or firm users while its modals are closed', async () => {
    // The page's own reads are not the subject; keep them off the network.
    const api = installApiMock();
    api.allowUnhandled();
    const { unmount } = renderWithProviders(<ClientDetail lawFirmId="firm-1" clientId="client-1" />);
    await new Promise((resolve) => setTimeout(resolve, 100));
    unmount();
    api.restore();

    expect(mockUseCourtsArgs).toHaveBeenCalled();
    expect(mockUseCourtsArgs.mock.calls.every((call) => call[1] === false)).toBe(true);
    expect(mockUseLawFirmUsersArgs).toHaveBeenCalled();
    expect(mockUseLawFirmUsersArgs.mock.calls.every((call) => call[1] === false)).toBe(true);
  });
});
