import { render, screen, fireEvent } from '@testing-library/react';
import ClearFiltersButton from '@/components/ui/ClearFiltersButton';

/**
 * The clear-filters control, which doubles as the active-filter indicator.
 *
 * Its visibility IS the signal: a list that is silently filtered, with no
 * control offering to unfilter it, is how a user concludes their data is
 * missing. So the two rules worth pinning are that it disappears at zero and
 * that the count is always reachable to a screen reader even when the visible
 * text omits it.
 *
 * The visible label and the count are separate text nodes inside one button, so
 * they are asserted through the button's own text content rather than with
 * `getByText`, which matches a single element.
 */
describe('ClearFiltersButton', () => {
  it('renders nothing when no filter is active', () => {
    const { container } = render(<ClearFiltersButton count={0} onClear={jest.fn()} />);

    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for a negative count', () => {
    // The guard is `count <= 0`, not `count === 0`. A caller computing the count
    // by subtraction can pass a negative, and a button offering to clear "-1
    // filters" is worse than no button.
    const { container } = render(<ClearFiltersButton count={-1} onClear={jest.fn()} />);

    expect(container.firstChild).toBeNull();
  });

  it('appears with one filter active, and omits the count', () => {
    render(<ClearFiltersButton count={1} onClear={jest.fn()} />);

    const button = screen.getByRole('button', { name: /clear filters/i });
    expect(button).toHaveTextContent('Clear filters');
    // "(1)" would be noise: the button's presence already says one filter is on.
    expect(button.textContent).not.toContain('(1)');
  });

  it('shows the count once more than one filter is active', () => {
    render(<ClearFiltersButton count={3} onClear={jest.fn()} />);

    expect(screen.getByRole('button').textContent?.replace(/\s+/g, ' ').trim())
      .toBe('Clear filters (3)');
  });

  it('names the count in the accessible label even when the text omits it', () => {
    render(<ClearFiltersButton count={1} onClear={jest.fn()} />);

    // A screen-reader user gets no benefit from the button merely existing, so
    // the count is in the accessible name at every count, including one.
    expect(screen.getByRole('button')).toHaveAccessibleName('Clear filters (1 active)');
  });

  it('calls back once per click', () => {
    const onClear = jest.fn();
    render(<ClearFiltersButton count={2} onClear={onClear} />);

    fireEvent.click(screen.getByRole('button'));

    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('uses a custom label in both the text and the accessible name', () => {
    render(<ClearFiltersButton count={4} onClear={jest.fn()} label="Reset" />);

    const button = screen.getByRole('button');
    expect(button.textContent?.replace(/\s+/g, ' ').trim()).toBe('Reset (4)');
    // Both places, because a custom label applied to only one of them leaves a
    // button reading "Reset" that announces itself as "Clear filters".
    expect(button).toHaveAccessibleName('Reset (4 active)');
  });
});
