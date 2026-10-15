/**
 * The outcome a calendar connect callback leaves on the return URL.
 *
 * After Google or Microsoft consent, the API redirects back to the page that
 * started the connect (or `/dashboard`) with `?google_connected=true` or
 * `?google_error=<code>`, and the Microsoft pair. The codes are a fixed set
 * chosen by the API; provider error text never reaches the URL.
 */
export type CalendarConnectProvider = 'google' | 'microsoft';

export interface CalendarConnectOutcome {
  provider: CalendarConnectProvider;
  connected: boolean;
  /** The error code, or null for a connect the API reported as successful. */
  code: string | null;
}

const PROVIDERS: CalendarConnectProvider[] = ['google', 'microsoft'];

export const CONNECT_OUTCOME_PARAMS = PROVIDERS.flatMap((p) => [`${p}_connected`, `${p}_error`]);

const PROVIDER_LABEL: Record<CalendarConnectProvider, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
};

export function readConnectOutcome(params: URLSearchParams): CalendarConnectOutcome | null {
  for (const provider of PROVIDERS) {
    if (params.get(`${provider}_connected`) === 'true') return { provider, connected: true, code: null };
    const code = params.get(`${provider}_error`);
    if (code) return { provider, connected: false, code };
  }
  return null;
}

/** Just the outcome parameters, as `?a=b`, for carrying them to another page. */
export function connectOutcomeQuery(params: URLSearchParams): string {
  const kept = new URLSearchParams();
  for (const key of CONNECT_OUTCOME_PARAMS) {
    const value = params.get(key);
    if (value) kept.set(key, value);
  }
  const query = kept.toString();
  return query ? `?${query}` : '';
}

const ERROR_SENTENCES: Record<string, (name: string) => string> = {
  access_denied: (name) => `${name} Calendar was not connected because access was declined.`,
  admin_consent_required: (name) =>
    `Your organization's administrator must approve Paralegix before ${name} Calendar can be connected.`,
  permission_required: (name) =>
    `${name} Calendar was not connected because calendar access was not allowed. Connect again and allow calendar access.`,
  invalid_state: (name) => `The ${name} Calendar connection could not be verified. Start the connection again from Settings.`,
  expired_state: (name) => `The ${name} Calendar connection took too long and expired. Please try again.`,
  exchange_failed: (name) => `${name} did not complete the calendar connection. Please try again.`,
  missing_refresh_token: (name) =>
    `${name} did not allow Paralegix to stay connected to your calendar. Please connect again.`,
  identity_unverified: (name) => `${name} did not confirm which account you used. Please try again.`,
};

/** One plain sentence for a connect error code; unknown codes get a generic one. */
export function connectOutcomeMessage(provider: CalendarConnectProvider, code: string): string {
  const name = PROVIDER_LABEL[provider];
  const sentence = ERROR_SENTENCES[code];
  return sentence ? sentence(name) : `${name} Calendar could not be connected. Please try again.`;
}

/** Shown after a connect the API reported as done but the status read did not confirm. */
export function unconfirmedConnectMessage(provider: CalendarConnectProvider): string {
  return `${PROVIDER_LABEL[provider]} Calendar did not finish connecting. Please try again.`;
}

export function connectedMessage(provider: CalendarConnectProvider): string {
  return `${PROVIDER_LABEL[provider]} account connected successfully.`;
}
