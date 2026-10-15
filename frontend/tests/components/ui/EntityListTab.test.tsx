import { render, screen, fireEvent } from '@testing-library/react';
import EntityListTab from '@/components/ui/EntityListTab';

jest.unmock('@/components/ui/ListView');

/**
 * The matters tab and the tasks tab were this component twice. The parts that
 * genuinely differ are the two predicates, and both tabs read "open" as
 * something the status column does not literally say: an open matter is
 * `active`, and an open task is anything but `blocked`. Routing those through
 * `matchesStatus` is the whole point of the extraction, so it is what this pins.
 */
type Row = { id: string; name: string; status: string };

const ROWS: Row[] = [
  { id: '1', name: 'Delgado Freight', status: 'active' },
  { id: '2', name: 'Whitlock Estate', status: 'closed' },
  { id: '3', name: 'Braddock Appeal', status: 'pending' },
];

function setup(props: Partial<React.ComponentProps<typeof EntityListTab<Row>>> = {}) {
  const onRowClick = jest.fn();
  const view = render(
    <EntityListTab<Row>
      rows={ROWS}
      getRowId={(row) => row.id}
      onRowClick={onRowClick}
      searchPlaceholder="Search matters..."
      matchesSearch={(row, term) => row.name.toLowerCase().includes(term)}
      statusOptions={[
        { value: 'all', label: 'All Matters (3)' },
        { value: 'open', label: 'Open / Active' },
        { value: 'closed', label: 'Closed' },
      ]}
      matchesStatus={(row, status) =>
        status === 'open' ? row.status === 'active' : row.status === status
      }
      renderRow={(row) => ({ title: row.name })}
      emptyIcon={<span />}
      emptyTitle="No matters found"
      emptyMessage="There are no matters associated with this entity yet."
      noMatchTitle="No matching matters"
      {...props}
    />,
  );
  return { onRowClick, ...view };
}

describe('EntityListTab', () => {
  it('lists every row before anything narrows it', () => {
    setup();
    expect(screen.getByText('Delgado Freight')).toBeInTheDocument();
    expect(screen.getByText('Whitlock Estate')).toBeInTheDocument();
    expect(screen.getByText('Braddock Appeal')).toBeInTheDocument();
  });

  it('narrows to the rows the caller predicate accepts', () => {
    setup();

    fireEvent.change(screen.getByPlaceholderText('Search matters...'), {
      target: { value: 'delgado' },
    });

    expect(screen.getByText('Delgado Freight')).toBeInTheDocument();
    expect(screen.queryByText('Whitlock Estate')).not.toBeInTheDocument();
  });

  it('lower-cases the term before the predicate sees it', () => {
    const matchesSearch = jest.fn(() => true);
    setup({ matchesSearch });

    fireEvent.change(screen.getByPlaceholderText('Search matters...'), {
      target: { value: 'DELGADO' },
    });

    expect(matchesSearch).toHaveBeenCalledWith(expect.anything(), 'delgado');
  });

  it('never asks the predicate about "all", so every row survives it', () => {
    const matchesStatus = jest.fn(() => false);
    setup({ matchesStatus });

    expect(matchesStatus).not.toHaveBeenCalled();
    expect(screen.getByText('Whitlock Estate')).toBeInTheDocument();
  });

  it('says nothing matched while narrowing, and nothing exists otherwise', () => {
    setup();
    expect(screen.queryByText('No matters found')).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search matters...'), {
      target: { value: 'nothing matches this' },
    });

    expect(screen.getByText('No matching matters')).toBeInTheDocument();
    expect(screen.getByText('Try adjusting your search or filter settings.')).toBeInTheDocument();
    expect(screen.queryByText('No matters found')).not.toBeInTheDocument();
  });

  it('opens the row the caller points at', () => {
    const { onRowClick } = setup();

    fireEvent.click(screen.getByText('Delgado Freight'));
    expect(onRowClick).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }));
  });

  it('shows the create button only when the caller offers one', () => {
    const { unmount } = setup();
    expect(screen.queryByRole('button', { name: /New Matter/ })).not.toBeInTheDocument();
    unmount();

    const onClick = jest.fn();
    setup({ create: { label: 'New Matter', onClick } });
    fireEvent.click(screen.getByRole('button', { name: /New Matter/ }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
  // The box was a bare input with a placeholder and nothing else: no accessible
  // name, and no way to clear it short of selecting the text.
  it('names its search box and offers a clear button once something is typed', () => {
    setup();
    const box = screen.getByRole('textbox', { name: 'Search matters...' });
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();

    fireEvent.change(box, { target: { value: 'delgado' } });
    expect(screen.queryByText('Whitlock Estate')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(box).toHaveValue('');
    expect(screen.getByText('Whitlock Estate')).toBeInTheDocument();
  });
  // A parent that searches on the server owns the term: the box shows and edits
  // ITS value, and the rows it hands over are already the matches, so filtering
  // them again here would hide rows the server meant to show (a match on a field
  // the row does not display).
  describe('with a search the parent controls', () => {
    it('shows the parent term, reports typing to it, and does not filter locally', () => {
      const onChange = jest.fn();
      const matchesSearch = jest.fn(() => false);
      setup({ matchesSearch, search: { value: 'estate', onChange } });

      const box = screen.getByRole('textbox', { name: 'Search matters...' });
      expect(box).toHaveValue('estate');
      // matchesSearch would drop every row; the server's rows all stay.
      expect(matchesSearch).not.toHaveBeenCalled();
      expect(screen.getByText('Delgado Freight')).toBeInTheDocument();

      fireEvent.change(box, { target: { value: 'estates' } });
      expect(onChange).toHaveBeenCalledWith('estates');
    });

    it('says nothing matched, not that nothing exists, while the parent term is set', () => {
      setup({ rows: [], search: { value: 'zzz', onChange: jest.fn() } });
      expect(screen.getByText('No matching matters')).toBeInTheDocument();
    });
  });
});
