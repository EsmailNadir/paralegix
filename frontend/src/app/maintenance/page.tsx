import MaintenancePage from "@/components/ui/MaintenancePage";

// Utility surface with no standalone value in search results.
export const metadata = {
  title: "Under maintenance",
  robots: { index: false, follow: false },
};

export default function MaintenanceRoute() {
  return <MaintenancePage />;
}
