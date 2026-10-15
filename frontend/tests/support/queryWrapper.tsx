/**
 * A `renderHook` wrapper that provides a fresh React Query client.
 *
 * The client comes from `makeTestQueryClient()`, so a hook test gets the same
 * options a component test does: no retries, no warm cache, no focus refetch.
 * Each call builds its own client. Pass one in when the spec needs to read or
 * seed the cache directly.
 *
 *   const { result } = renderHook(() => useThing(id), { wrapper: createQueryWrapper() });
 */
import React from 'react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { makeTestQueryClient } from './renderWithProviders';

export function createQueryWrapper(
  queryClient: QueryClient = makeTestQueryClient(),
): React.FC<{ children: React.ReactNode }> {
  return function QueryWrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}
