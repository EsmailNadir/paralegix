"use client";

import { useEffect } from "react";
import UnexpectedErrorPage from "@/components/ui/UnexpectedErrorPage";
import { useErrorRetry } from "@/hooks/useErrorRetry";

export default function AppError({
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
      title="This page ran into a problem"
      description="Paralegix could not finish loading this page. A retry usually clears it."
      onRetry={retry}
      retrying={retrying}
      details={error.digest ? `Reference: ${error.digest}` : undefined}
    />
  );
}
