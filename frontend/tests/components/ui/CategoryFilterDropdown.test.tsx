import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * The matter-category filter.
 *
 * Categories are a TREE stored as flat rows with a `parentId` and a `path`, and
 * the dropdown has to rebuild that tree to render it. Two failures matter and
 * neither shows as an error: a child rendered at the root loses the context that
 * makes its name meaningful ("Commercial" under what?), and the value handed
 * back has to be the full `path`, because that is what the matter list filters
 * on. Handing back a bare name filters on a string no matter carries.
 *
 * WHY THE MOCK IS DECLARED HERE WITH AN EXPLICIT FACTORY. `tests/setup.ts`
 * already registers `@/services/matters.service` as a Proxy that hands out a
 * FRESH `jest.fn().mockResolvedValue({})` on every property access. Under that
 * mock, `jest.mock('@/services/matters.service')` with no factory leaves the
 * component receiving `{}` where it expects an array, while the test's own
 * `mockResolvedValue` lands on a throwaway function the component never calls -
 * so the component breaks AND the assertion reports zero calls. A stable
 * `jest.fn` closed over here is the pattern the passing specs use.
 */
const mockListCategories = jest.fn();

jest.mock('@/services/matters.service', () => ({
  __esModule: true,
  default: {
    listCategories: (...args: unknown[]) => mockListCategories(...args),
  },
}));

import CategoryFilterDropdown from '@/components/ui/CategoryFilterDropdown';

const CATEGORIES = [
  { id: 'cat-1', name: 'Litigation', path: 'Litigation', order: 0, parentId: null },
  { id: 'cat-2', name: 'Commercial', path: 'Litigation > Commercial', order: 0, parentId: 'cat-1' },
  { id: 'cat-3', name: 'Estate Planning', path: 'Estate Planning', order: 1, parentId: null },
];

beforeEach(() => {
  mockListCategories.mockResolvedValue(CATEGORIES);
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('CategoryFilterDropdown', () => {
  it('loads the firm categories and shows the empty-selection label', async () => {
    render(<CategoryFilterDropdown lawFirmId="firm-1" value="" onChange={jest.fn()} />);

    await waitFor(() => {
      expect(mockListCategories).toHaveBeenCalledWith('firm-1');
    });
    expect(screen.getByRole('button', { name: /all categories/i })).toBeInTheDocument();
  });

  it('does not ask for categories without a firm', () => {
    render(<CategoryFilterDropdown lawFirmId="" value="" onChange={jest.fn()} />);

    // The component renders on pages that mount before the firm is resolved. A
    // request with an empty id is a guaranteed 404 and a console error on every
    // one of those loads.
    expect(mockListCategories).not.toHaveBeenCalled();
  });

  it('keeps children collapsed until their parent is expanded', async () => {
    render(<CategoryFilterDropdown lawFirmId="firm-1" value="" onChange={jest.fn()} />);
    await waitFor(() => expect(mockListCategories).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /all categories/i }));

    // A deep tree rendered fully expanded is unusable in a dropdown, so the two
    // roots show and the child does not until asked for.
    expect(await screen.findByRole('button', { name: 'Litigation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Estate Planning' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Commercial' })).not.toBeInTheDocument();
  });

  it('hands back the full path, not the bare name, when a child is chosen', async () => {
    const onChange = jest.fn();
    const { container } = render(
      <CategoryFilterDropdown lawFirmId="firm-1" value="" onChange={onChange} />,
    );
    await waitFor(() => expect(mockListCategories).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /all categories/i }));
    await screen.findByRole('button', { name: 'Litigation' });
    // The expand chevron is the unnamed button beside the row; the named one
    // selects the category rather than opening it.
    const row = screen.getByRole('button', { name: 'Litigation' }).closest('li');
    const chevron = row!.querySelector('button');
    fireEvent.click(chevron!);

    fireEvent.click(await screen.findByRole('button', { name: 'Commercial' }));

    // 'Litigation > Commercial', not 'Commercial'. The matter list filters on
    // the stored path, so a bare name filters on a string no matter carries and
    // the list silently comes back empty.
    expect(onChange).toHaveBeenCalledWith('Litigation > Commercial');
    expect(container).toBeTruthy();
  });

  it('hands back a root category path too', async () => {
    const onChange = jest.fn();
    render(<CategoryFilterDropdown lawFirmId="firm-1" value="" onChange={onChange} />);
    await waitFor(() => expect(mockListCategories).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /all categories/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Litigation' }));

    expect(onChange).toHaveBeenCalledWith('Litigation');
  });

  it('shows the current selection on the closed button', async () => {
    render(
      <CategoryFilterDropdown
        lawFirmId="firm-1"
        value="Litigation > Commercial"
        onChange={jest.fn()}
      />,
    );
    await waitFor(() => expect(mockListCategories).toHaveBeenCalled());

    // Resolved from `flatCategories` by path. A closed control that still read
    // "All categories" while a filter was active is how a user concludes their
    // matters have disappeared.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /commercial/i })).toBeInTheDocument();
    });
  });

  it('survives a categories request that fails, without breaking the page', async () => {
    mockListCategories.mockRejectedValueOnce(new Error('network down'));

    render(<CategoryFilterDropdown lawFirmId="firm-1" value="" onChange={jest.fn()} />);

    // The dropdown sits in a toolbar above a list. A load failure must degrade
    // to "no categories to filter by", not take the surrounding page down.
    await waitFor(() => expect(mockListCategories).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /all categories/i })).toBeInTheDocument();
  });

  // Choosing a category closes the menu. Clearing the search in that same update
  // re-expanded the whole tree inside the fading list.
  it('keeps the search and its filtered tree while the menu animates closed', async () => {
    render(<CategoryFilterDropdown lawFirmId="firm-1" value="" onChange={jest.fn()} />);
    await waitFor(() => expect(mockListCategories).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /all categories/i }));
    fireEvent.change(await screen.findByPlaceholderText('Search categories…'), { target: { value: 'Comm' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Commercial' }));

    expect(screen.getByRole('listbox')).toHaveClass('overlay-select-menu-exit');
    expect(screen.getByPlaceholderText('Search categories…')).toHaveValue('Comm');
    expect(screen.queryByRole('button', { name: 'Estate Planning' })).not.toBeInTheDocument();
  });
});
