/**
 * How many option rows `Dropdown` re-renders, and what the trigger keeps
 * showing while the menu is filtered.
 *
 * `DropdownOptionRow` is memoized so that moving the pointer across a long list
 * re-renders only the rows whose `active` flag changed. Row renders are counted
 * without touching the component: each option exposes `label` as a getter, and
 * the only place `label` is read during a render is the row itself (the trigger
 * reads it too, but only for the selected option, and these cases run
 * unselected). The timing side of the same scenarios lives in
 * `tests/perf/render-perf.test.tsx`.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import Dropdown, { type DropdownOption } from '@/components/ui/Dropdown';
import { DROPDOWN_MAX_RENDERED } from '@/lib/constants/search';

function countingOptions(count: number) {
  const counter = { reads: 0 };
  const options: DropdownOption[] = Array.from({ length: count }, (_, i) => {
    const label = `Client ${i}`;
    return {
      value: `c${i}`,
      get label() {
        counter.reads += 1;
        return label;
      },
    };
  });
  return { options, counter };
}

describe('Dropdown row re-renders', () => {
  it('re-renders only the two rows whose active state changed on hover', () => {
    const { options, counter } = countingOptions(1000);
    render(<Dropdown value="" onChange={() => {}} options={options} />);
    fireEvent.click(screen.getByRole('button'));

    const rows = screen.getAllByRole('option');
    expect(rows).toHaveLength(DROPDOWN_MAX_RENDERED);

    // Everything up to here is the initial paint; only the hover is counted.
    counter.reads = 0;
    // The menu seeds its active option at index 0, so hovering row 50 changes
    // exactly two rows: 0 goes inactive, 50 goes active.
    fireEvent.mouseEnter(rows[50]);

    // A regression (a caller handing the menu a fresh `options` array, or the
    // memo being dropped) shows up here as ~100, every rendered row.
    expect(counter.reads).toBe(2);
  });

  it('re-renders every visible row when the caller hands it a fresh options array', () => {
    // The memo keys on `options` identity, so a parent re-render that rebuilds
    // the array (an inline `list.map(...)` in JSX) invalidates every row. Hover
    // is unaffected, because the active index lives inside the menu and never
    // reaches the parent, but any OTHER parent state change while the menu is
    // open pays for all 100 rows. Pinned here so the cost is a known quantity
    // rather than a surprise.
    const first = countingOptions(1000);
    const { rerender } = render(<Dropdown value="" onChange={() => {}} options={first.options} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getAllByRole('option')).toHaveLength(DROPDOWN_MAX_RENDERED);

    const second = countingOptions(1000);
    rerender(<Dropdown value="" onChange={() => {}} options={second.options} />);

    expect(second.counter.reads).toBe(DROPDOWN_MAX_RENDERED);
  });
});

describe('Dropdown trigger while filtering', () => {
  it('keeps the selected label on the trigger when the filter hides it', () => {
    const options = Array.from({ length: 1000 }, (_, i) => ({ value: `c${i}`, label: `Client ${i}` }));
    render(<Dropdown value="c900" onChange={() => {}} options={options} />);
    const trigger = screen.getByRole('button');
    expect(trigger).toHaveTextContent('Client 900');

    fireEvent.click(trigger);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Client 12' } });

    expect(screen.queryByRole('option', { name: 'Client 900' })).not.toBeInTheDocument();
    expect(trigger).toHaveTextContent('Client 900');
  });
});
