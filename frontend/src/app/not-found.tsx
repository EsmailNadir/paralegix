import ResourceNotFoundPage from "@/components/ui/ResourceNotFoundPage";

export default function NotFound() {
  return (
    <ResourceNotFoundPage
      resourceLabel="page"
      title="That page is not in the record"
      description="The address may be outdated or mistyped."
      primaryAction={{
        label: "Back home",
        href: "/",
      }}
      secondaryAction={{
        label: "Open dashboard",
        href: "/dashboard",
      }}
    />
  );
}
