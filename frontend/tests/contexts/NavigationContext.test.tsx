/**
 * The navigation context's default value.
 *
 * A component rendered outside every provider used to get a navigate that did
 * nothing, so a click looked handled and went nowhere. The client portal's
 * notification bell sat outside its provider for exactly that reason.
 */
jest.unmock('@/contexts/NavigationContext');

import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { useNavigation } from '@/contexts/NavigationContext';

function Probe({ href }: { href: string }) {
  const { navigate } = useNavigation();
  return <button type="button" onClick={() => navigate(href)}>go</button>;
}

describe('NavigationContext default', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    window.history.replaceState({}, '', '/client/lawfirm/firm-a/matters');
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    window.history.replaceState({}, '', '/');
  });

  it('still navigates when no provider is mounted, and warns about it', async () => {
    render(<Probe href="/client/lawfirm/firm-a/matters#notification" />);

    await act(async () => {
      screen.getByRole('button', { name: 'go' }).click();
    });

    // jsdom performs only same-document navigations, so a hash change is the
    // observable proof that the fallback reached the browser's location.
    expect(window.location.hash).toBe('#notification');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('outside a NavigationContext provider'));
  });
});
