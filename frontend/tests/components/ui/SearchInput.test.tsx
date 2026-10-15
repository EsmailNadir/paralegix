import { render, screen, fireEvent } from '@testing-library/react';
import SearchInput from '@/components/ui/SearchInput';

/**
 * Eleven lists spelled this out. Three things differed between the copies and
 * all three have to survive: two grids suppress their row hover while the user
 * types but NOT when they clear, the template tab shows the clear button on its
 * own normalised query rather than on the raw value, and the icons come in two
 * sizes.
 */
describe('SearchInput', () => {
  const setup = (props: Partial<React.ComponentProps<typeof SearchInput>> = {}) =>
    render(
      <SearchInput
        value=""
        onChange={jest.fn()}
        placeholder="Search by client name or email..."
        {...props}
      />,
    );

  it('reports what the user types', () => {
    const handleChange = jest.fn();
    setup({ onChange: handleChange });

    fireEvent.change(screen.getByPlaceholderText('Search by client name or email...'), {
      target: { value: 'delgado' },
    });
    expect(handleChange).toHaveBeenCalledWith('delgado');
  });

  it('offers nothing to clear until there is something to clear', () => {
    const { unmount } = setup();
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
    unmount();

    setup({ value: 'delgado' });
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeInTheDocument();
  });

  it('clears through onChange when the caller gives no onClear', () => {
    const handleChange = jest.fn();
    setup({ value: 'delgado', onChange: handleChange });

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(handleChange).toHaveBeenCalledWith('');
  });

  it('clears through onClear alone, so typing side effects stay out of it', () => {
    const handleChange = jest.fn();
    const handleClear = jest.fn();
    setup({ value: 'delgado', onChange: handleChange, onClear: handleClear });

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(handleClear).toHaveBeenCalledTimes(1);
    expect(handleChange).not.toHaveBeenCalled();
  });

  it('lets the caller decide when to offer the clear, as the template tab does', () => {
    const { unmount } = setup({ value: 'delgado', showClear: false });
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
    unmount();

    setup({ value: '', showClear: true });
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeInTheDocument();
  });

  it('carries the label the accessible lists set on the field', () => {
    setup({ 'aria-label': 'Search templates' });
    expect(screen.getByRole('textbox', { name: 'Search templates' })).toBeInTheDocument();
  });

  it('keeps the wrapper classes the call site sizes its row with', () => {
    const { container } = setup({ className: 'w-full md:max-w-sm' });
    const wrapper = container.firstElementChild!;
    expect(wrapper.className).toContain('relative');
    expect(wrapper.className).toContain('md:max-w-sm');
  });
});
