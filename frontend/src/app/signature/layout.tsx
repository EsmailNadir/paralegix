import type { Metadata } from "next";
import SignatureLayoutClient from "./SignatureLayoutClient";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function SignatureLayout({ children }: { children: React.ReactNode }) {
  return <SignatureLayoutClient>{children}</SignatureLayoutClient>;
}
