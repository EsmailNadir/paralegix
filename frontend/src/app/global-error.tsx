"use client";

import { useEffect } from "react";
import { captureAnalyticsException } from "@/lib/analytics/analytics";
import UnexpectedErrorPage from "@/components/ui/UnexpectedErrorPage";

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureAnalyticsException(error);
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <UnexpectedErrorPage
          title="Paralegix needs a fresh start"
          description="An error interrupted the app before this page could load."
          // The root layout is what failed, so re-rendering the tree in place
          // leaves the broken shell behind - reload the document instead.
          onRetry={() => window.location.reload()}
          retryLabel="Reload app shell"
          secondaryHref="/"
          details={error.digest ? `Reference: ${error.digest}` : undefined}
        />
      </body>
    </html>
  );
}
