/**
 * Offline contract for the firm dashboard's search bar (`useDashboardSearch`).
 *
 * Four server queries (matters, clients, tasks, conversations) answer one
 * debounced term. Each keeps its previous rows on screen while the next term
 * loads, guarded on the previous key's FIRM so a firm switch cannot hand one
 * firm's results to another. That guard is written four times, once per
 * section, so the isolation case runs once per section with that section held.
 *
 * What has to break for these to go red: a request before the debounce
 * settles or without a term, a section dropping the firm, term, limit or
 * `full` flag, a mapping that loses a field the dropdown shows, or any one
 * section's firm guard.
 */
jest.unmock('@/services/matters.service');
jest.unmock('@/services/clients.service');
jest.unmock('@/services/tasks.service');
jest.unmock('@/services/messages.service');
jest.unmock('@/services/requestDeduplicator');

import { act, renderHook, waitFor } from '@testing-library/react';

import { useDashboardSearch, type DashboardSearchResults } from '@/hooks/dashboardHooks/useDashboardSearch';
import { SEARCH_DEBOUNCE_MS } from '@/lib/constants/search';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import { setupApiMock } from '../support/apiMock';
import { createQueryWrapper } from '../support/queryWrapper';
import { itKeepsScopeIsolated } from '../support/scopeIsolation';

const api = setupApiMock();

// Specs reuse the same lookup urls, which trips the dev-only duplicate-GET
// warning across tests; it says nothing about this hook.
beforeEach(() => {
  process.env.NEXT_PUBLIC_DUP_FETCH_WARN = 'off';
  __resetDuplicateRequestGuard();
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_DUP_FETCH_WARN;
});

const SECTIONS = ['matters', 'clients', 'tasks', 'conversations'] as const;
type Section = typeof SECTIONS[number];

const url = (section: Section, firm: string, term: string) => {
  const q = encodeURIComponent(term);
  switch (section) {
    case 'matters': return `/api/lawfirms/${firm}/matters/lookup?search=${q}&limit=5`;
    case 'clients': return `/api/lawfirms/${firm}/clients/lookup?search=${q}&limit=5&full=true`;
    case 'tasks': return `/api/lawfirms/${firm}/tasks/lookup?search=${q}&limit=5`;
    case 'conversations': return `/api/lawfirms/${firm}/messaging/conversations?limit=5&search=${q}`;
  }
};

/** One row per section, its id tagged with the firm that answered it. */
const body = (section: Section, firm: string) => section === 'conversations'
  ? { conversations: [{ conversationId: `${firm}-conversation` }], totalItems: 1 }
  : { items: [{ id: `${firm}-${section}`, label: `${firm} ${section}` }], hasMore: false };

function answerAll(firm: string, term: string, except?: Section) {
  for (const section of SECTIONS) {
    if (section !== except) api.getExact(url(section, firm, term), body(section, firm));
  }
}

const allIds = (r: { results: DashboardSearchResults }) => [
  ...r.results.matters.map((m) => m.id),
  ...r.results.clients.map((c) => c.id),
  ...r.results.tasks.map((t) => t.id),
  ...r.results.conversations.map((c) => c.conversationId),
];
const idsFor = (firm: string) => [`${firm}-matters`, `${firm}-clients`, `${firm}-tasks`, `${firm}-conversation`];

/** Let the debounce elapse with nothing else happening. */
async function pastDebounce() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 100));
  });
}

describe('when there is nothing to search', () => {
  it('sends nothing for a blank or whitespace-only term, even after the debounce', async () => {
    const { result } = renderHook(() => useDashboardSearch('firm-a', '   '), { wrapper: createQueryWrapper() });

    await pastDebounce();

    expect(api.calls()).toEqual([]);
    expect(allIds(result.current)).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.searching).toBe(false);
  });

  it('sends nothing without a firm, even with a term', async () => {
    const { result } = renderHook(() => useDashboardSearch(undefined, 'smith'), { wrapper: createQueryWrapper() });

    await pastDebounce();

    expect(api.calls()).toEqual([]);
    expect(result.current.searching).toBe(false);
  });
});

describe('a typed term', () => {
  it('waits for typing to pause, then searches every section once for the final term', async () => {
    answerAll('firm-a', 'smith');

    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => useDashboardSearch('firm-a', q),
      { wrapper: createQueryWrapper(), initialProps: { q: 'smi' } },
    );
    rerender({ q: 'smith' });

    await waitFor(() => expect(allIds(result.current)).toEqual(idsFor('firm-a')));
    expect(api.calls().map((c) => c.query.search?.[0])).toEqual(['smith', 'smith', 'smith', 'smith']);
    expect(result.current.searching).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it('trims the term before searching', async () => {
    answerAll('firm-a', 'smith');

    const { result } = renderHook(() => useDashboardSearch('firm-a', '  smith  '), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(allIds(result.current)).toEqual(idsFor('firm-a')));
  });

  it('maps each section to the fields the dropdown shows, with defaults for what is missing', async () => {
    api.getExact(url('matters', 'firm-a', 'smith'), { items: [
      { id: 'm1', label: 'Smith v. Jones', status: 'closed', matterNumber: 'M-0042' },
      { id: 'm2', label: 'Smith estate' },
    ] });
    api.getExact(url('clients', 'firm-a', 'smith'), { items: [
      { id: 'c1', label: 'Ann Smith', email: 'ann@example.test', matterIds: ['m1', 'm2'] },
      { id: 'c2', label: 'Smith LLC' },
    ] });
    api.getExact(url('tasks', 'firm-a', 'smith'), { items: [
      { id: 't1', label: 'Call Smith', sublabel: 'Smith v. Jones', priority: 'high', dueDate: '2026-10-01' },
      { id: 't2', label: 'Smith follow-up' },
    ] });
    api.getExact(url('conversations', 'firm-a', 'smith'), { conversations: [{ conversationId: 'conv-1' }], totalItems: 1 });

    const { result } = renderHook(() => useDashboardSearch('firm-a', 'smith'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.results.conversations).toHaveLength(1));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.results.matters).toEqual([
      { id: 'm1', name: 'Smith v. Jones', status: 'closed', matterReferenceId: 'M-0042' },
      { id: 'm2', name: 'Smith estate', status: 'active', matterReferenceId: null },
    ]);
    expect(result.current.results.clients).toEqual([
      { id: 'c1', name: 'Ann Smith', email: 'ann@example.test', matterCount: 2 },
      { id: 'c2', name: 'Smith LLC', email: undefined, matterCount: 0 },
    ]);
    expect(result.current.results.tasks).toEqual([
      { id: 't1', title: 'Call Smith', matterName: 'Smith v. Jones', priority: 'high', dueDate: '2026-10-01' },
      { id: 't2', title: 'Smith follow-up', matterName: null, priority: 'medium', dueDate: null },
    ]);
  });

  it('keeps the other sections when one section fails', async () => {
    answerAll('firm-a', 'smith', 'tasks');
    api.getExact(url('tasks', 'firm-a', 'smith'), { status: 500, body: { error: 'Task search down' } });

    const { result } = renderHook(() => useDashboardSearch('firm-a', 'smith'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(allIds(result.current)).toEqual(['firm-a-matters', 'firm-a-clients', 'firm-a-conversation']));
    await waitFor(() => expect(result.current.searching).toBe(false));
    expect(result.current.results.tasks).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('keeps the previous term rows on screen while the next term loads, within the same firm', async () => {
    answerAll('firm-a', 'smith');
    for (const section of SECTIONS) {
      api.getExact(url(section, 'firm-a', 'jones'), { status: 200, body: body(section, 'firm-a-jones'), delayMs: 60 });
    }

    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => useDashboardSearch('firm-a', q),
      { wrapper: createQueryWrapper(), initialProps: { q: 'smith' } },
    );
    await waitFor(() => expect(allIds(result.current)).toEqual(idsFor('firm-a')));

    rerender({ q: 'jones' });
    await waitFor(() => expect(api.calls().some((c) => c.query.search?.[0] === 'jones')).toBe(true));

    // In flight for "jones": the "smith" rows stay rather than blanking the menu.
    expect(allIds(result.current)).toEqual(idsFor('firm-a'));
    expect(result.current.searching).toBe(true);
    expect(result.current.loading).toBe(false);

    await waitFor(() => expect(allIds(result.current)).toEqual(idsFor('firm-a-jones')));
  });
});

describe.each(SECTIONS)('switching firms with the %s section still loading', (held) => {
  itKeepsScopeIsolated({
    title: "does not show the previous firm's results for the same term",
    mode: 'pending',
    api: () => {
      // Every section but the held one answers at once for both firms.
      answerAll('firm-a', 'smith', held);
      answerAll('firm-b', 'smith', held);
      return api;
    },
    useHook: ({ firm }: { firm: string }) => useDashboardSearch(firm, 'smith'),
    ids: allIds,
    a: { props: { firm: 'firm-a' }, url: url(held, 'firm-a', 'smith'), body: body(held, 'firm-a'), ids: idsFor('firm-a') },
    b: { props: { firm: 'firm-b' }, url: url(held, 'firm-b', 'smith'), body: body(held, 'firm-b'), ids: idsFor('firm-b') },
  });
});
