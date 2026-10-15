import type { Metadata } from "next";
import ClientLayoutClient from "./ClientLayoutClient";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  return <ClientLayoutClient>{children}</ClientLayoutClient>;
}
