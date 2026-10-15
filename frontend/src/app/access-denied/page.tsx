import AccessDeniedPage from "@/components/ui/AccessDeniedPage";

// Utility surface with no standalone value in search results.
export const metadata = {
  title: "Access denied",
  robots: { index: false, follow: false },
};

export default function AccessDeniedRoute() {
  return <AccessDeniedPage />;
}
