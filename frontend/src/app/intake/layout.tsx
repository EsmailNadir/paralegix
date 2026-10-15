'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ParalegixLogo from '@/components/ui/ParalegixLogo';

/**
 * Public intake forms live outside both the law-firm and client shells, so they
 * inherit no provider from either. A local QueryClient keeps the page self-contained
 * for any hooks that need one, mirroring the signature layout.
 */
export default function IntakeLayout({ children }: { children: React.ReactNode }) {
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
        <main className="flex-1 flex flex-col items-center justify-center p-4">
          {children}
        </main>
      </div>
    </QueryClientProvider>
  );
}
