import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import TabBar, { type TabBarTab } from '@/components/ui/TabBar';

jest.mock('@/hooks/useHorizontalOverflow', () => ({
  __esModule: true,
  default: () => ({
    ref: { current: null },
    overflow: { left: false, right: false },
    scrollStep: jest.fn(),
    onWheel: jest.fn(),
  }),
}));

jest.mock('@/hooks/useSlidingHighlight', () => ({
  __esModule: true,
  default: () => ({
    containerRef: jest.fn(),
    registerItem: () => jest.fn(),
    rect: { left: 0, top: 0, width: 100, height: 40 },
  }),
}));

type SectionTab = 'overview' | 'activity' | 'settings' | 'billing';

const tabs: TabBarTab<SectionTab>[] = [
  { value: 'overview', label: 'Overview', count: 3 },
  { value: 'activity', label: 'Activity' },
  { value: 'settings', label: 'Settings', disabled: true },
  { value: 'billing', label: 'Rates & Setup', secondary: true },
];

describe('TabBar', () => {
  it('renders tabs and marks the active tab with aria-current="true"', () => {
    render(
      <TabBar
        tabs={tabs}
        value="overview"
        onChange={jest.fn()}
      />
    );

    const overviewBtn = screen.getByRole('button', { name: /Overview/ });
    const activityBtn = screen.getByRole('button', { name: /Activity/ });

    expect(overviewBtn).toHaveAttribute('aria-current', 'true');
    expect(activityBtn).not.toHaveAttribute('aria-current');
  });

  it('renders count badge when count is greater than zero', () => {
    render(
      <TabBar
        tabs={tabs}
        value="overview"
        onChange={jest.fn()}
      />
    );

    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('calls onChange with tab value when an enabled tab is clicked', () => {
    const handleChange = jest.fn();

    render(
      <TabBar
        tabs={tabs}
        value="overview"
        onChange={handleChange}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Activity/ }));

    expect(handleChange).toHaveBeenCalledWith('activity');
  });

  it('disables the tab button and does not call onChange when disabled is true', () => {
    const handleChange = jest.fn();

    render(
      <TabBar
        tabs={tabs}
        value="overview"
        onChange={handleChange}
      />
    );

    const settingsBtn = screen.getByRole('button', { name: /Settings/ });
    expect(settingsBtn).toBeDisabled();

    fireEvent.click(settingsBtn);
    expect(handleChange).not.toHaveBeenCalled();
  });

  it('renders trailing node when provided', () => {
    render(
      <TabBar
        tabs={tabs}
        value="overview"
        onChange={jest.fn()}
        trailing={<button data-testid="tab-action">New Item</button>}
      />
    );

    expect(screen.getByTestId('tab-action')).toBeInTheDocument();
  });

  it('splits secondary tabs when align="split"', () => {
    render(
      <TabBar
        tabs={tabs}
        value="overview"
        onChange={jest.fn()}
        align="split"
      />
    );

    expect(screen.getByRole('button', { name: /Rates & Setup/ })).toBeInTheDocument();
  });
});
