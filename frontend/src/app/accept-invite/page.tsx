import AcceptInvitePageClient from "./AcceptInvitePageClient";

// Utility surface with no standalone value in search results.
export const metadata = {
  title: "Accept invitation",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default function AcceptInvitePage() {
  return <AcceptInvitePageClient />;
}
