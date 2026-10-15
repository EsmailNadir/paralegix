import React from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NoteTypeColorPicker from '@/components/notesComp/NoteTypeColorPicker';

describe('NoteTypeColorPicker', () => {
  it('animates the swatch popover in and plays an exit before it unmounts', async () => {
    jest.useFakeTimers();
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<NoteTypeColorPicker value="info" onChange={jest.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Change note type color' }));
    const popover = screen.getByRole('button', { name: 'success' }).parentElement as HTMLElement;
    expect(popover.className).toContain('overlay-menu-enter');

    await user.keyboard('{Escape}');
    // Still on screen, animating out, rather than gone in the same frame.
    expect(screen.getByRole('button', { name: 'success' })).toBeInTheDocument();
    expect(popover.className).toContain('overlay-menu-exit');

    act(() => {
      jest.advanceTimersByTime(150);
    });
    expect(screen.queryByRole('button', { name: 'success' })).not.toBeInTheDocument();
    jest.useRealTimers();
  });
});
