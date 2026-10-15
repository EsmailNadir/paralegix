import AuthRequiredPage from "@/components/ui/AuthRequiredPage";

// Utility surface with no standalone value in search results.
export const metadata = {
  title: "Sign in required",
  robots: { index: false, follow: false },
};

export default function AuthRequiredRoute() {
  return <AuthRequiredPage />;
}
