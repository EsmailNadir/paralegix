import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Client Portal · Paralegix',
  description: 'View your matters and communicate with your legal team',
};

export default function ClientLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}