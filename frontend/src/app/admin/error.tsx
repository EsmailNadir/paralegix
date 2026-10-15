"use client";

import { useEffect } from "react";
import UnexpectedErrorPage from "@/components/ui/UnexpectedErrorPage";
import { useErrorRetry } from "@/hooks/useErrorRetry";

export default function AdminSegmentError({
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
      title="The admin console ran into an error"
      description="This view did not load cleanly. Retry before making any changes."
      onRetry={retry}
      retrying={retrying}
      details={error.digest ? `Reference: ${error.digest}` : undefined}
    />
  );
}
