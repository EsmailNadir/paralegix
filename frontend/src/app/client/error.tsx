"use client";

import { useEffect } from "react";
import UnexpectedErrorPage from "@/components/ui/UnexpectedErrorPage";
import { useErrorRetry } from "@/hooks/useErrorRetry";

export default function ClientSegmentError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { retry, retrying } = useErrorRetry(reset);

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <UnexpectedErrorPage
      title="The client portal lost its place"
      description="This screen did not finish loading. Try again, or head back to your portal home."
      onRetry={retry}
      retrying={retrying}
      secondaryHref="/client/dashboard"
      details={error.digest ? `Reference: ${error.digest}` : undefined}
    />
  );
}
