import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import BulkActionsMenu from '@/components/filesComp/BulkActionsMenu';

afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

it('opens above a low trigger, runs one enabled action, and ignores disabled actions', () => {
  jest.useFakeTimers();
  const enabled = jest.fn();
  const disabled = jest.fn();
  jest.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(500);
  jest.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(100);
  render(<BulkActionsMenu count={2} actions={[{ key: 'delete', label: 'Delete', onClick: enabled, danger: true }, { key: 'move', label: 'Move', onClick: disabled, disabled: true }, false]} />);
  const trigger = screen.getByRole('button', { name: '2 selected' });
  jest.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ top: 450, bottom: 480, right: 300, left: 200, width: 100 } as DOMRect);
  fireEvent.click(trigger);
  const menu = screen.getByRole('button', { name: 'Delete' }).parentElement!;
  expect(Number.parseFloat(menu.style.top)).toBe(346);
  fireEvent.click(screen.getByRole('button', { name: 'Move' }));
  expect(disabled).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(enabled).toHaveBeenCalledTimes(1);
  act(() => jest.advanceTimersByTime(150));
  expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  fireEvent.click(trigger);
  fireEvent.keyDown(document, { key: 'Escape' });
  act(() => jest.advanceTimersByTime(150));
  expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
});
