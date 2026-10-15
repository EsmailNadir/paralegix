/**
 * Render a component with the providers the app gives it in production.
 *
 * Eight existing specs each build their own `QueryClientProvider` wrapper by
 * hand, and they differ: some set `retry: false`, some do not, and a spec that
 * forgets it spends thirty seconds retrying a mocked 500 before timing out.
 * There is one correct set of options for a test, so it lives here once.
 *
 * A FRESH `QueryClient` per render is the load-bearing part. React Query caches
 * by key across renders, so a shared client hands the second spec in a file the
 * first spec's data and the assertion passes without the component ever
 * fetching. Every call here gets its own client and its own empty cache.
 */
import React from 'react';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

export function makeTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Without this a spec asserting an error path waits out the default
        // retry schedule and fails as a timeout, which names the wrong problem.
        retry: false,
        // The component must fetch in the test rather than read a warm cache.
        staleTime: 0,
        gcTime: 0,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
    // React Query logs expected rejections to stderr, which buries the real
    // failure in a passing run.
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  } as never);
}

export interface RenderWithProvidersResult extends RenderResult {
  queryClient: QueryClient;
}

export function renderWithProviders(
  ui: React.ReactElement,
  options: RenderOptions = {},
): RenderWithProvidersResult {
  const queryClient = makeTestQueryClient();
  const result = render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
    options,
  );
  const rerenderInsideProviders = result.rerender.bind(result);
  // Returned so a spec can assert on cache state, or invalidate to force a
  // refetch when it is testing what happens after a mutation. Keep that same
  // provider tree on rerender too: replacing it would remount the subject and
  // make a firm/user transition look like an unmount, hiding stale-response
  // bugs that only exist in a long-lived workspace.
  return Object.assign(result, {
    queryClient,
    rerender: (nextUi: React.ReactElement) => rerenderInsideProviders(
      <QueryClientProvider client={queryClient}>{nextUi}</QueryClientProvider>,
    ),
  });
}
