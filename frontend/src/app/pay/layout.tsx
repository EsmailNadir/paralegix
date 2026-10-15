import type { Metadata } from 'next';
import ParalegixLogo from '@/components/ui/ParalegixLogo';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function PayLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-page flex flex-col">
      <header className="flex items-center justify-center py-4 border-b border-outline-subtle">
        <ParalegixLogo width={140} height={36} priority />
      </header>
      <main className="flex-1 flex flex-col items-center justify-center p-4">
        {children}
      </main>
    </div>
  );
}
