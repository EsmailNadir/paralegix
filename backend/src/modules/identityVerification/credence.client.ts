/**
 * Server-side client for the Credence ID Cloud SDK.
 *
 * The license key never leaves the backend: the browser talks to our routes,
 * and these functions talk to Credence. `Origin` is sent on every call so the
 * provider's registered-domain check is explicit rather than inferred.
 *
 * The access token is cached per process and shared between concurrent callers
 * (one in-flight acquisition at a time). A token within a minute of expiry is
 * refreshed; a failed refresh falls back to a fresh `/v1/setup`.
 */
import { AppError } from '../../shared/errors/AppError';
import type {
  CredenceSetupResponse,
  CredenceTokens,
  DcVerifyResponse,
  GetDocRequestResponse,
  OpenId4vpInitiateResponse,
  W3cInitiateResponse,
  W3cResultResponse,
} from './credence.types';

type Config = { baseUrl: string; licenseKey: string; profileId: string; origin: string };

function readEnv() {
  const { CREDENCE_BASE_URL, CREDENCE_LICENSE_KEY, CREDENCE_PROFILE_ID, CREDENCE_ORIGIN } = process.env;
  return { CREDENCE_BASE_URL, CREDENCE_LICENSE_KEY, CREDENCE_PROFILE_ID, CREDENCE_ORIGIN };
}

/** Whether all four CREDENCE_* settings are present. Never throws. */
export function isCredenceConfigured(): boolean {
  return Object.values(readEnv()).every((value) => Boolean(value));
}

function readConfig(): Config {
  const { CREDENCE_BASE_URL, CREDENCE_LICENSE_KEY, CREDENCE_PROFILE_ID, CREDENCE_ORIGIN } = readEnv();
  if (!CREDENCE_BASE_URL || !CREDENCE_LICENSE_KEY || !CREDENCE_PROFILE_ID || !CREDENCE_ORIGIN) {
    throw new AppError('Identity verification is not configured.', 503, 'IDENTITY_VERIFICATION_UNCONFIGURED');
  }
  return {
    baseUrl: CREDENCE_BASE_URL.replace(/\/+$/, ''),
    licenseKey: CREDENCE_LICENSE_KEY,
    profileId: CREDENCE_PROFILE_ID,
    origin: CREDENCE_ORIGIN,
  };
}

type Cached = { accessToken: string; refreshToken: string; accessExpiresAt: number; refreshExpiresAt: number };
let cached: Cached | null = null;
let inflight: Promise<string> | null = null;
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SKEW_MS = 60_000;
const TIMEOUT_MS = 15_000;

async function call<T>(
  path: string,
  init: { body?: unknown; token?: string; allow202?: boolean } = {},
): Promise<{ status: number; data: T }> {
  const cfg = readConfig();
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: cfg.origin,
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
    body: JSON.stringify(init.body ?? {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 202 && init.allow202) return { status: 202, data: null as T };
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Logged for us with the license key redacted; the caller gets generic copy
    // and never the provider body.
    const logged = text.slice(0, 500).split(cfg.licenseKey).join('[license]');
    console.error(`credence ${path} failed: ${res.status} ${logged}`);
    if (res.status === 403 && text.includes('DOMAIN_MISMATCH')) {
      throw new AppError('Identity verification is misconfigured for this site.', 503, 'IDENTITY_PROVIDER_DOMAIN');
    }
    throw new AppError('The identity provider is unavailable. Please try again.', 502, 'IDENTITY_PROVIDER_ERROR');
  }
  return { status: res.status, data: (await res.json()) as T };
}

function store(t: CredenceTokens): string {
  const now = Date.now();
  cached = {
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    accessExpiresAt: now + t.expiresIn * 1000,
    refreshExpiresAt: now + REFRESH_TTL_MS,
  };
  return t.accessToken;
}

async function acquireToken(): Promise<string> {
  const now = Date.now();
  if (cached && cached.accessExpiresAt - now > SKEW_MS) return cached.accessToken;
  if (cached && cached.refreshExpiresAt - now > SKEW_MS) {
    try {
      const { data } = await call<CredenceTokens>('/v1/refresh', { body: { refreshToken: cached.refreshToken } });
      return store(data);
    } catch {
      // A refused refresh is recoverable: set up a new session below.
      cached = null;
    }
  }
  const cfg = readConfig();
  const { data } = await call<CredenceSetupResponse>('/v1/setup', {
    body: { licenseKey: cfg.licenseKey, profileId: cfg.profileId },
  });
  return store(data);
}

async function token(): Promise<string> {
  if (!inflight) inflight = acquireToken().finally(() => { inflight = null; });
  return inflight;
}

/** Flow A: an ISO mdoc request for the Digital Credentials API. */
export async function getDocRequest(): Promise<GetDocRequestResponse> {
  return (await call<GetDocRequestResponse>('/v1/getDocRequest', { token: await token() })).data;
}

/** Flow A: verify the wallet's response to `getDocRequest`. */
export async function verifyDocRequest(sessionId: string, data: string): Promise<DcVerifyResponse> {
  return (await call<DcVerifyResponse>('/v1/verifyDocRequest', { token: await token(), body: { sessionId, data } })).data;
}

/** Flow B: an OpenID4VP request for the Digital Credentials API. */
export async function initiateOpenId4vp(): Promise<OpenId4vpInitiateResponse> {
  return (await call<OpenId4vpInitiateResponse>('/dcapi/openid4vp/v1/initiate', { token: await token() })).data;
}

/** Flow B: verify the wallet's response to `initiateOpenId4vp`. */
export async function validateOpenId4vp(sessionId: string, data: string): Promise<DcVerifyResponse> {
  return (await call<DcVerifyResponse>('/dcapi/openid4vp/v1/validate', { token: await token(), body: { sessionId, data } })).data;
}

/** Flow D: a W3C OpenID4VP request the wallet app opens from a link or QR code. */
export async function initiateW3c(): Promise<W3cInitiateResponse> {
  return (await call<W3cInitiateResponse>('/w3c/openid4vp/v1/initiate', { token: await token() })).data;
}

/** Flow D: the wallet's answer, or null while it has not answered yet (HTTP 202). */
export async function pollW3c(sessionId: string): Promise<W3cResultResponse | null> {
  const r = await call<W3cResultResponse>('/w3c/openid4vp/v1/validate', {
    token: await token(),
    body: { sessionId },
    allow202: true,
  });
  return r.status === 202 ? null : r.data;
}

/** Test support: forget the cached token so each spec starts cold. */
export function __resetCredenceTokenCache(): void {
  cached = null;
  inflight = null;
}
