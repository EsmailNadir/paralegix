import { disableAnalytics, enableAnalytics, initAnalytics } from "./analytics";
import { regionForTimeZone, type ConsentRegion } from "./consentRegion";

/**
 * Whether product analytics may start in this browser.
 *
 * Visitors in the EU, EEA, UK, Switzerland and Canada choose first: analytics
 * starts only after they accept. Everyone else sees a notice and analytics
 * starts on load. Anyone, anywhere, can decline from Cookie settings, and a decline is
 * honoured in every region.
 */

export type ConsentChoice = "granted" | "denied";

const CHOICE_KEY = "paralegix_analytics_consent";
// When the choice was made. A choice older than a year is forgotten, so the
// visitor is asked again, as EU regulators recommend.
const CHOICE_AT_KEY = "paralegix_analytics_consent_at";
const CHOICE_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
// Per session, not per browser: someone who travels is asked by where they are now.
const REGION_KEY = "paralegix_consent_region";

/** Fired to reopen the banner as an accept/decline choice. */
export const COOKIE_SETTINGS_EVENT = "paralegix:cookie-settings";

function read(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

function write(storage: () => Storage, key: string, value: string): void {
  try {
    storage().setItem(key, value);
  } catch {
    // Storage unavailable (private mode, blocked): the choice lasts this page only.
  }
}

function remove(storage: () => Storage, key: string): void {
  try {
    storage().removeItem(key);
  } catch {
    // Storage unavailable: nothing was stored.
  }
}

export function getConsentChoice(): ConsentChoice | null {
  const value = read(() => localStorage, CHOICE_KEY);
  if (value !== "granted" && value !== "denied") return null;

  const madeAt = Number(read(() => localStorage, CHOICE_AT_KEY));
  if (!madeAt) {
    // Saved before choices were dated: date it now, so it expires a year from now.
    write(() => localStorage, CHOICE_AT_KEY, String(Date.now()));
    return value;
  }
  if (Date.now() - madeAt > CHOICE_LIFETIME_MS) {
    remove(() => localStorage, CHOICE_KEY);
    remove(() => localStorage, CHOICE_AT_KEY);
    return null;
  }
  return value;
}

function saveChoice(choice: ConsentChoice): void {
  write(() => localStorage, CHOICE_KEY, choice);
  write(() => localStorage, CHOICE_AT_KEY, String(Date.now()));
}

export function getCachedConsentRegion(): ConsentRegion | null {
  const value = read(() => sessionStorage, REGION_KEY);
  return value === "required" || value === "notice" ? value : null;
}

let regionRequest: Promise<ConsentRegion> | null = null;

/** Where the visitor is, from Vercel's IP country, falling back to the time zone. */
export function resolveConsentRegion(): Promise<ConsentRegion> {
  const cached = getCachedConsentRegion();
  if (cached) return Promise.resolve(cached);
  if (!regionRequest) {
    regionRequest = fetch("/api/consent-region", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => body?.region ?? null)
      .catch(() => null)
      .then((region) => {
        const resolved: ConsentRegion =
          region === "required" || region === "notice"
            ? region
            : regionForTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
        write(() => sessionStorage, REGION_KEY, resolved);
        return resolved;
      });
  }
  return regionRequest;
}

/** Called once as the app loads: starts analytics now, later, or never. */
export async function startAnalyticsWithConsent(): Promise<void> {
  const choice = getConsentChoice();
  if (choice === "denied") return;
  if (choice === "granted") {
    initAnalytics();
    return;
  }
  const region = await resolveConsentRegion();
  // The visitor may have chosen while the lookup was in flight; their choice wins.
  if (getConsentChoice()) return;
  if (region === "notice") initAnalytics();
}

export function acceptAnalytics(): void {
  saveChoice("granted");
  enableAnalytics();
}

export function declineAnalytics(): void {
  saveChoice("denied");
  disableAnalytics();
}

export function openCookieSettings(): void {
  window.dispatchEvent(new Event(COOKIE_SETTINGS_EVENT));
}
