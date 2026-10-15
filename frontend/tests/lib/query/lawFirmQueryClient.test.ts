/**
 * The firm workspace QueryClient.
 *
 * The defaults decide how often every firm screen goes back to the server. The
 * dashboard summary alone costs 25-30 database queries, and under the old
 * defaults (30 second freshness, refetch on every window focus) each return to
 * the tab re-ran it along with every other stale query on the page.
 *
 * What has to break for these to go red: focus refetch turned back on, the
 * freshness window shortened, the retry policy dropped, a query that opts back
 * in to focus refetch no longer doing so, or an API write no longer marking the
 * cache stale (which would show a user their own edit undone on the next visit).
 */
import { focusManager, QueryObserver } from '@tanstack/react-query';
import {
  createLawFirmQueryClient,
  REFRESH_ON_FOCUS,
  markQueriesStaleOnApiWrite,
} from '@/lib/query/lawFirmQueryClient';
import { shouldRetryQuery } from '@/lib/query/retryPolicy';
import { emitApiWrite } from '@/lib/utils/apiWriteSignal';

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

afterEach(() => {
  focusManager.setFocused(undefined);
  jest.useRealTimers();
});

describe('createLawFirmQueryClient defaults', () => {
  it('keeps data fresh for two minutes, never refetches on focus, and keeps the shared retry policy', () => {
    const queries = createLawFirmQueryClient().getDefaultOptions().queries;

    expect(queries?.staleTime).toBe(2 * 60_000);
    expect(queries?.refetchOnWindowFocus).toBe(false);
    expect(queries?.gcTime).toBe(5 * 60_000);
    expect(queries?.retry).toBe(shouldRetryQuery);
  });

  it('returns a new client per call so a server render never shares a cache', () => {
    expect(createLawFirmQueryClient()).not.toBe(createLawFirmQueryClient());
  });
});

// `mount()` is what QueryClientProvider does; it is how focus events reach the
// cache, so without it a focus test would pass whatever the options said.
function observe(client: ReturnType<typeof createLawFirmQueryClient>, options: Record<string, unknown> = {}) {
  client.mount();
  const queryFn = jest.fn().mockResolvedValue('value');
  const observer = new QueryObserver(client, { queryKey: ['thing'], queryFn, ...options });
  const stop = observer.subscribe(() => {});
  const unsubscribe = () => {
    stop();
    client.unmount();
  };
  return { queryFn, unsubscribe };
}

describe('window focus', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-16T12:00:00Z'));
  });

  it('does not refetch a stale query when the window regains focus', async () => {
    const client = createLawFirmQueryClient();
    const { queryFn, unsubscribe } = observe(client);
    await flush();
    expect(queryFn).toHaveBeenCalledTimes(1);

    jest.setSystemTime(new Date('2026-09-16T12:10:00Z'));
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await flush();

    expect(queryFn).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('refetches a query that opts back in once its 30 second freshness has lapsed', async () => {
    const client = createLawFirmQueryClient();
    const { queryFn, unsubscribe } = observe(client, REFRESH_ON_FOCUS);
    await flush();

    jest.setSystemTime(new Date('2026-09-16T12:00:20Z'));
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await flush();
    expect(queryFn).toHaveBeenCalledTimes(1);

    jest.setSystemTime(new Date('2026-09-16T12:00:31Z'));
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await flush();
    expect(queryFn).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});

describe('markQueriesStaleOnApiWrite', () => {
  it('marks cached queries stale on a write without fetching anything', async () => {
    const client = createLawFirmQueryClient();
    const unbind = markQueriesStaleOnApiWrite(client);
    const { queryFn, unsubscribe } = observe(client);
    await flush();
    expect(client.getQueryState(['thing'])?.isInvalidated).toBe(false);

    emitApiWrite({ method: 'POST', url: 'https://api.example.com/api/lawfirms/firm-1/tasks' });
    await flush();

    expect(client.getQueryState(['thing'])?.isInvalidated).toBe(true);
    expect(queryFn).toHaveBeenCalledTimes(1);

    // The next screen to mount the query re-reads it.
    const second = observe(client);
    await flush();
    expect(second.queryFn).toHaveBeenCalledTimes(1);

    unsubscribe();
    second.unsubscribe();
    unbind();
  });

  it('stops marking once unbound', async () => {
    const client = createLawFirmQueryClient();
    const unbind = markQueriesStaleOnApiWrite(client);
    const { unsubscribe } = observe(client);
    await flush();
    unbind();

    emitApiWrite({ method: 'POST', url: 'https://api.example.com/api/lawfirms/firm-1/tasks' });

    expect(client.getQueryState(['thing'])?.isInvalidated).toBe(false);
    unsubscribe();
  });
});
