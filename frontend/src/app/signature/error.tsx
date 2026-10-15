"use client";

import { useEffect } from "react";
import UnexpectedErrorPage from "@/components/ui/UnexpectedErrorPage";
import { useErrorRetry } from "@/hooks/useErrorRetry";

export default function SignatureSegmentError({
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
      title="The signing workspace could not load"
      description="Something interrupted the signing flow. Retry to resume where you left off."
      onRetry={retry}
      retrying={retrying}
      secondaryHref="/"
      details={error.digest ? `Reference: ${error.digest}` : undefined}
    />
  );
}
