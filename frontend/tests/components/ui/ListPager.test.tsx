import { render, screen, fireEvent } from '@testing-library/react';
import ListPager, { pagerWillRender } from '@/components/ui/ListPager';

describe('ListPager', () => {
  it('returns false for pagerWillRender when total is below smallest page size', () => {
    expect(pagerWillRender(5, [10, 25, 50])).toBe(false);
    expect(pagerWillRender(15, [10, 25, 50])).toBe(true);
  });

  it('renders nothing when total rows fit within one page', () => {
    const { container } = render(
      <ListPager
        page={1}
        totalPages={1}
        total={8}
        rowsPerPage={10}
        onPageChange={jest.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders range and handles page navigation', () => {
    const handlePageChange = jest.fn();

    render(
      <ListPager
        page={2}
        totalPages={5}
        total={45}
        rowsPerPage={10}
        onPageChange={handlePageChange}
      />,
    );

    expect(screen.getByText('11–20 of 45')).toBeInTheDocument();

    const prevBtn = screen.getByRole('button', { name: 'Prev' });
    const nextBtn = screen.getByRole('button', { name: 'Next' });

    expect(prevBtn).toBeEnabled();
    expect(nextBtn).toBeEnabled();

    fireEvent.click(nextBtn);
    expect(handlePageChange).toHaveBeenCalledWith(3);

    fireEvent.click(prevBtn);
    expect(handlePageChange).toHaveBeenCalledWith(1);
  });

  describe('server-paged click acknowledgement', () => {
    const serverPager = (busy: boolean, onPageChange = jest.fn(), onPendingChange = jest.fn()) => (
      <ListPager
        page={1}
        totalPages={3}
        total={30}
        rowsPerPage={10}
        onPageChange={onPageChange}
        onPendingChange={onPendingChange}
        busy={busy}
        serverPaged
      />
    );

    it('marks the clicked button loading until the fetch it started completes', () => {
      const onPageChange = jest.fn();
      const onPendingChange = jest.fn();
      const { rerender } = render(serverPager(false, onPageChange, onPendingChange));

      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      expect(onPageChange).toHaveBeenCalledWith(2);
      expect(screen.getByRole('button', { name: /Loading/ })).toBeDisabled();
      expect(onPendingChange).toHaveBeenLastCalledWith(true);

      // The server fetch starts, then finishes.
      rerender(serverPager(true, onPageChange, onPendingChange));
      expect(screen.getByRole('button', { name: /Loading/ })).toBeInTheDocument();
      rerender(serverPager(false, onPageChange, onPendingChange));

      // Cleared by the fetch completing, not by the cached-page fallback timer.
      expect(screen.queryByRole('button', { name: /Loading/ })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
      expect(onPendingChange).toHaveBeenLastCalledWith(false);
    });

    it('ignores a page click while a fetch is already in flight', () => {
      const onPageChange = jest.fn();
      render(serverPager(true, onPageChange));

      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      expect(onPageChange).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: /Loading/ })).not.toBeInTheDocument();
    });
  });
});
