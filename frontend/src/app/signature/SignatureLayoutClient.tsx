'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ParalegixLogo from '@/components/ui/ParalegixLogo';

/**
 * The signing editor and the public signing page live outside both the law-firm
 * and client shells, so they inherit no provider from either. They still render
 * components that read through React Query - `EntityPicker` (the signer and
 * filing-destination pickers) calls `useEntityLookup`, which threw "No QueryClient
 * set" here - so this route needs a client of its own.
 *
 * It is deliberately a separate instance from the firm shell's: a signer arriving
 * on a public link has no firm session to share a cache with. That is also why the
 * editor flags the firm's template list dirty through sessionStorage rather than
 * invalidating it (see `markSigningTemplatesDirty`); it cannot reach the firm's
 * cache from here, and this provider does not change that.
 *
 * Options mirror the law-firm shell so a lookup behaves the same in both places.
 */
export default function SignatureLayoutClient({ children }: { children: React.ReactNode }) {
  // Created per component instance rather than at module scope. A module-level
  // client is instantiated once per server process and shared by every render
  // that process handles, so anything cached into it during a server render
  // would be served to the next user. The lazy initializer keeps exactly one
  // client for the life of this layout.
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: 1,
      },
    },
  }));

  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-screen bg-page flex flex-col">
        <header className="flex items-center justify-center py-4 border-b border-outline-subtle">
          <ParalegixLogo width={140} height={36} priority />
        </header>
        <main className="flex-1 flex flex-col">
          {children}
        </main>
      </div>
    </QueryClientProvider>
  );
}
