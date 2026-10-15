import { startAnalyticsWithConsent } from "@/lib/analytics/consent";

// Next.js runs this file in the browser before the app hydrates. Analytics
// starts here unless the visitor's region needs their consent first.
void startAnalyticsWithConsent();
