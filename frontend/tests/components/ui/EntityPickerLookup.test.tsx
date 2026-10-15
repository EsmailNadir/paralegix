/**
 * `EntityPicker` against the real lookup hook and the real matters service,
 * with only the transport faked: when the picker asks the server for anything,
 * and how a preselected value gets its label.
 *
 * `EntityPicker.test.tsx` stubs `useEntityLookup` whole, so it cannot see a
 * request at all. The render timing of the same picker is benchmarked in
 * `tests/perf/render-perf.test.tsx`.
 */
jest.unmock('@/services/matters.service');
jest.unmock('@/services/requestDeduplicator');

import { fireEvent, screen, waitFor } from '@testing-library/react';
import EntityPicker from '@/components/ui/EntityPicker';
import { setupApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';

const api = setupApiMock();

describe('EntityPicker lookups', () => {
  it('issues no lookup request until the picker is opened', async () => {
    api.get('/matters/lookup', { items: [{ id: 'm-1', label: 'Matter 1' }], hasMore: false });

    renderWithProviders(<EntityPicker entity="matters" lawFirmId="firm-1" value="" onChange={() => {}} />);

    expect(screen.getByRole('button')).toBeInTheDocument();
    expect(api.calls()).toEqual([]);

    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByRole('option', { name: 'Matter 1' })).toBeInTheDocument();
    expect(api.callsTo('/matters/lookup')).toHaveLength(1);
  });

  it("resolves a preselected value's label through the ids lookup without searching", async () => {
    api.get('/matters/lookup', (call) => (
      call.query.ids?.[0] === 'm-42'
        ? { items: [{ id: 'm-42', label: 'Estate of Ruiz' }], hasMore: false }
        : { items: [], hasMore: false }
    ));

    renderWithProviders(<EntityPicker entity="matters" lawFirmId="firm-1" value="m-42" onChange={() => {}} />);

    expect(await screen.findByText('Estate of Ruiz')).toBeInTheDocument();
    // Resolved without ever opening the menu, so the search branch stayed idle.
    await waitFor(() => expect(api.calls()).toHaveLength(1));
    expect(api.calls()[0].query).toEqual({ ids: ['m-42'], limit: ['1'] });
  });
});
