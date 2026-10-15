export function publicIntakeUrl(publicToken: string): string {
  const configuredOrigin =
    typeof process !== "undefined" && process.env.NEXT_PUBLIC_APP_URL
      ? process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")
      : null;
  const browserOrigin = typeof window !== "undefined" ? window.location.origin : "";

  return `${configuredOrigin || browserOrigin}/intake/${publicToken}`;
}
