/**
 * Offline contract for the firm's note types (`useNoteTypes`): the type picker
 * on every note, and the colour each type is drawn in.
 *
 * Colours come from two places on one list: a firm-custom type carries its
 * own, and a built-in type can carry a firm override. `noteTypeColors` is the
 * lookup every note badge reads, keyed by slug, so a row that loses its colour
 * there renders in the default everywhere.
 *
 * Driven through the real `noteTypes.service`.
 *
 * What has to break for these to go red: the colour map including uncoloured
 * rows or keying by label, a write addressing the wrong firm or an unencoded
 * slug, an invalidation that misses this firm or reaches another, or a write
 * sent with no firm.
 */
jest.unmock('@/services/noteTypes.service');
jest.unmock('@/services/requestDeduplicator');

import { act, renderHook, waitFor } from '@testing-library/react';

import useNoteTypes from '@/hooks/notesHooks/useNoteTypes';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import { sequence, setupApiMock } from '../support/apiMock';
import { createQueryWrapper } from '../support/queryWrapper';
import { itKeepsScopeIsolated, itSendsNothingWithoutScope } from '../support/scopeIsolation';

const api = setupApiMock();

// A write re-reads the list it just changed, which trips the dev-only
// duplicate-GET warning. That re-read is what these specs are about.
beforeEach(() => {
  process.env.NEXT_PUBLIC_DUP_FETCH_WARN = 'off';
  __resetDuplicateRequestGuard();
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_DUP_FETCH_WARN;
});

const TYPES = (firm: string) => `/api/lawfirms/${firm}/note-types`;
const type = (value: string, color: string | null = null, builtIn = false) => ({ value, label: value.toUpperCase(), color, builtIn });
const values = (r: { noteTypes: Array<{ value: string }> }) => r.noteTypes.map((t) => t.value);

itSendsNothingWithoutScope({
  title: 'sends nothing without a firm',
  api: () => api,
  useHook: () => useNoteTypes(undefined),
  settled: (r) => r.loading === false,
  finally: (r) => {
    expect(r.noteTypes).toEqual([]);
    expect(r.noteTypeColors).toEqual({});
  },
});

describe('reading', () => {
  it('maps every coloured type, custom or built-in override, by its slug, and skips the rest', async () => {
    api.getExact(TYPES('firm-a'), { noteTypes: [
      type('call', '#3b82f6', true),
      type('email', null, true),
      type('court-filing', '#ef4444'),
      type('internal'),
    ] });

    const { result } = renderHook(() => useNoteTypes('firm-a'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(values(result.current)).toEqual(['call', 'email', 'court-filing', 'internal']));
    expect(result.current.noteTypeColors).toEqual({ call: '#3b82f6', 'court-filing': '#ef4444' });
  });

  itKeepsScopeIsolated({
    title: "does not show one firm's note types while another firm's load",
    mode: 'pending',
    api: () => api,
    useHook: ({ firm }: { firm: string }) => useNoteTypes(firm),
    ids: values,
    a: { props: { firm: 'firm-a' }, url: TYPES('firm-a'), body: { noteTypes: [type('a-type', '#111111')] }, ids: ['a-type'] },
    b: { props: { firm: 'firm-b' }, url: TYPES('firm-b'), body: { noteTypes: [type('b-type')] }, ids: ['b-type'] },
    // The derived colour map must follow the rows, not lag behind them.
    finally: (r) => expect(r.noteTypeColors).toEqual({}),
  });
});

describe('writing', () => {
  it("creates a type in its own firm and refreshes only that firm's list", async () => {
    api.getExact(TYPES('firm-a'), sequence({ noteTypes: [type('call')] }, { noteTypes: [type('call'), type('deposition')] }));
    api.getExact(TYPES('firm-b'), { noteTypes: [type('b-type')] });
    api.postExact(TYPES('firm-a'), { message: 'Created', noteType: type('deposition') });

    const { result } = renderHook(() => ({ a: useNoteTypes('firm-a'), b: useNoteTypes('firm-b') }), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(values(result.current.a)).toEqual(['call']));
    await waitFor(() => expect(values(result.current.b)).toEqual(['b-type']));

    let created: unknown;
    await act(async () => {
      created = await result.current.a.createNoteType('Deposition');
    });

    expect(created).toEqual({ message: 'Created', noteType: type('deposition') });
    expect(api.calls('POST').map((c) => [c.pathname, c.body])).toEqual([[TYPES('firm-a'), { label: 'Deposition' }]]);
    await waitFor(() => expect(values(result.current.a)).toEqual(['call', 'deposition']));
    expect(api.callsTo('/firm-b/note-types')).toHaveLength(1);
  });

  it("recolours a type at its encoded slug and refreshes the colour map", async () => {
    api.getExact(TYPES('firm-a'), sequence(
      { noteTypes: [type('phone call', null, true)] },
      { noteTypes: [type('phone call', '#10b981', true)] },
    ));
    api.patchExact(`${TYPES('firm-a')}/phone%20call/color`, { message: 'Updated', noteType: type('phone call', '#10b981', true) });

    const { result } = renderHook(() => useNoteTypes('firm-a'), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(values(result.current)).toEqual(['phone call']));

    await act(async () => {
      await result.current.updateNoteTypeColor('phone call', '#10b981');
    });

    expect(api.calls('PATCH').map((c) => c.body)).toEqual([{ color: '#10b981' }]);
    await waitFor(() => expect(result.current.noteTypeColors).toEqual({ 'phone call': '#10b981' }));
  });

  it('rejects a refused write with the server reason and does not refetch', async () => {
    api.getExact(TYPES('firm-a'), { noteTypes: [type('call')] });
    api.postExact(TYPES('firm-a'), { status: 409, body: { error: 'A note type with that name already exists' } });

    const { result } = renderHook(() => useNoteTypes('firm-a'), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(values(result.current)).toEqual(['call']));

    await act(async () => {
      await expect(result.current.createNoteType('Call')).rejects.toThrow('A note type with that name already exists');
    });

    expect(api.calls('GET')).toHaveLength(1);
  });

  it('rejects both writes without sending anything when there is no firm', async () => {
    const { result } = renderHook(() => useNoteTypes(undefined), { wrapper: createQueryWrapper() });

    await act(async () => {
      await expect(result.current.createNoteType('Call')).rejects.toThrow('Law firm ID is required');
      await expect(result.current.updateNoteTypeColor('call', '#000000')).rejects.toThrow('Law firm ID is required');
    });

    expect(api.calls()).toEqual([]);
  });
});
