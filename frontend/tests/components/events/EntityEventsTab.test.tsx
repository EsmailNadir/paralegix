/**
 * The shared events tab behind the matter and client Events tabs.
 *
 * Each parent hands it an adapter for the parts that genuinely differ. The case
 * pinned here is the row menu: the matter tab builds its menu from permission
 * checks and can end up with nothing in it, so it asks for an empty menu to be
 * dropped; the client tab never asked, and its rows keep the kebab. Rendering
 * the shared tab directly, with nothing but that one flag changed between the
 * two cases, is what proves the flag and not something else decides it.
 */
import React from 'react';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../support/renderWithProviders';
import EntityEventsTab, {
  useEventStatusFilter,
  type EntityEventsAdapter,
  type EventSectionPage,
} from '@/components/eventComp/EntityEventsTab';
import type { MatterEvent } from '@/types/matterEvent';

type Row = Pick<MatterEvent, 'id' | 'type' | 'title' | 'status' | 'date' | 'dateLocalDisplay'>;

const ROW: Row = {
  id: 'ev-1',
  type: 'hearing',
  title: 'Status hearing',
  status: 'upcoming',
  date: '2099-03-15T12:00:00.000Z',
  dateLocalDisplay: 'Mar 15, 2099',
};

function page(rows: Row[]): EventSectionPage<Row> {
  return {
    rows,
    total: rows.length,
    page: 1,
    setPage: () => {},
    rowsPerPage: 10,
    setRowsPerPage: () => {},
    loading: false,
    fetching: false,
  };
}

function adapter(overrides: Partial<EntityEventsAdapter<Row>>): EntityEventsAdapter<Row> {
  return {
    detailsIdPrefix: 'test-event-details-',
    hasDetails: () => false,
    renderBadges: () => null,
    renderMeta: (event) => event.dateLocalDisplay ?? '',
    renderDetails: () => null,
    rowActions: () => ({ menu: [] }),
    hideEmptyRowMenu: false,
    emptyMessage: { canManage: 'Add one.', readOnly: 'None yet.' },
    ...overrides,
  };
}

function Harness({ tabAdapter }: { tabAdapter: EntityEventsAdapter<Row> }) {
  const filter = useEventStatusFilter();
  return (
    <EntityEventsTab<Row>
      canManage
      filter={filter}
      sections={{ upcoming: page([ROW]), completed: page([]), cancelled: page([]) }}
      error={null}
      onDismissError={() => {}}
      onAdd={() => {}}
      adapter={tabAdapter}
    />
  );
}

describe('a row whose action menu has nothing in it', () => {
  it('drops the kebab when the adapter asks for an empty menu to be hidden', async () => {
    renderWithProviders(<Harness tabAdapter={adapter({ hideEmptyRowMenu: true })} />);

    // The row itself is on screen, so the missing kebab is the flag's doing
    // rather than an empty list.
    expect((await screen.findAllByText('Status hearing')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
  });

  it('keeps the kebab when the adapter does not ask for it to be hidden', async () => {
    renderWithProviders(<Harness tabAdapter={adapter({ hideEmptyRowMenu: false })} />);

    expect((await screen.findAllByText('Status hearing')).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'More actions' }).length).toBeGreaterThan(0);
  });

  it('shows the kebab either way once the menu has an action in it', async () => {
    renderWithProviders(
      <Harness
        tabAdapter={adapter({
          hideEmptyRowMenu: true,
          rowActions: () => ({ menu: [{ label: 'Edit event', onClick: () => {} }] }),
        })}
      />,
    );

    expect((await screen.findAllByText('Status hearing')).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'More actions' }).length).toBeGreaterThan(0);
  });
});

describe('a row the adapter gives no actions at all', () => {
  it('renders neither the primary action nor the kebab', async () => {
    renderWithProviders(
      <Harness tabAdapter={adapter({ rowActions: () => null, hideEmptyRowMenu: false })} />,
    );

    expect((await screen.findAllByText('Status hearing')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
  });
});
