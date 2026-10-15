import type { Metadata } from "next";
import DocsClient from "./DocsClient";

// A hand-off page that immediately forwards to the separate docs site, so there
// is nothing here worth indexing - the docs site is the canonical destination.
export const metadata: Metadata = {
  title: "Documentation",
  description: "Paralegix product documentation.",
  robots: { index: false, follow: true },
};

export default function DocsPage() {
  return <DocsClient />;
}
