import InvalidLinkPage from "@/components/ui/InvalidLinkPage";

// Utility surface with no standalone value in search results.
export const metadata = {
  title: "Invalid link",
  robots: { index: false, follow: false },
};

export default function InvalidLinkRoute() {
  return <InvalidLinkPage />;
}
