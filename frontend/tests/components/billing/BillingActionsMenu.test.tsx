import React, { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import BillingActionsMenu from '@/components/billingComp/BillingActionsMenu';

const props = {
  onAddExpense: jest.fn(), onAddFlatFee: jest.fn(), onStartTimer: jest.fn(),
  onBulkInvoices: jest.fn(), canManageExpenses: true, canManageInvoices: true,
};

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('keeps the menu inside the viewport when the trigger is near the left edge', () => {
  jest.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(375);
  jest.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(800);
  jest.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(208);
  render(<BillingActionsMenu {...props} />);
  const trigger = screen.getByRole('button', { name: 'New' });
  jest.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
    top: 100, bottom: 130, left: 16, right: 80, width: 64, height: 30,
    x: 16, y: 100, toJSON: () => ({}),
  });
  fireEvent.click(trigger);
  const menu = screen.getByRole('button', { name: 'Expense' }).parentElement!;
  // translateX(-100%) puts the left edge one menu width before its anchor.
  expect(Number.parseFloat(menu.style.left) - menu.offsetWidth).toBeGreaterThanOrEqual(8);
});

it('holds the timer label through exit, then reflects the running timer on reopen', () => {
  jest.useFakeTimers();
  function Harness() {
    const [active, setActive] = useState(false);
    return <BillingActionsMenu {...props} timerActive={active} onStartTimer={() => setActive(true)} />;
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'New' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start Timer' }));
  expect(screen.getByRole('button', { name: 'Start Timer' })).toBeInTheDocument();
  act(() => jest.advanceTimersByTime(150));
  expect(screen.queryByRole('button', { name: 'Start Timer' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'New' }));
  expect(screen.getByRole('button', { name: 'Timer running' })).toBeDisabled();
});
