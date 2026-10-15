# Client identity verification with Credence ID (Cloud SDK)

Branch `credence-demo` (worktree `~/paralegix-credence-demo`), cut from
`new-templates`. Staging demo only; not for production until the product owner signs off. Work stays
uncommitted. Every task ships with tests; the first test for every new route is a caller from
another firm getting 403/404.

Goal: a client opens the portal, taps "Verify my identity", presents the mobile driver's license in
their phone wallet, and the firm sees a **Verified** badge on that client's record with the checked
name, issuing state and time. No raw ID data (portrait, license number, address, birth date) is
stored.

## Architecture

```
iPhone Safari (client portal)                 Paralegix backend                         Credence Cloud SDK
  tap Verify (pointerdown prefetch) -------->  POST /identity/verifications ---------->  /v1/setup (cached token)
                                                                                     ->  /v1/getDocRequest
                                     <------  { verificationId, method, request }
  navigator.credentials.get(org-iso-mdoc)
  Apple Wallet consent sheet, Face ID
  credential.data -------------------------->  POST /identity/verifications/:id/complete -> /v1/verifyDocRequest
                                     <------  VerificationResult
Firm user: client record shows Verified badge  <- GET /lawfirms/:id/clients/:clientId/identity-verification
```

Key decisions:

- **The license key never reaches the browser.** Backend proxies all Credence calls. `Origin:
  CREDENCE_ORIGIN` is sent on every call so the registered-domain check is explicit.
- **A verification is bound to one client row and one user.** Credence's `sessionId` is stored
  against `(law_firm_id, client_id, user_id)`; `complete`/`poll` accept only the caller who started
  it, once, within 10 minutes. The browser never sees Credence's `sessionId`.
- **Data minimization.** Keep: given/family name, issuing jurisdiction, doc type, credential expiry,
  pass/fail of each check, whether the name matches the client record. Never persist, return or log:
  portrait, signature image, license number, address, birth date. Log claim KEYS only, never values.
- **Name match is a flag, not a gate.** A differing name is still `verified`, with
  `nameMatchesRecord = false`.

## Flows

| Flow | method | Credence endpoints | Wallet |
|---|---|---|---|
| A (build first) | `mdoc_dcapi` | `/v1/getDocRequest`, `/v1/verifyDocRequest` | Apple Wallet (Safari, iOS 17.4+), Chrome 141+ |
| D (fallback) | `w3c_openid4vp` | `/w3c/openid4vp/v1/initiate`, `/w3c/openid4vp/v1/validate` (202 = pending) | CA DMV Wallet, QR |
| B (optional) | `openid4vp_dcapi` | `/dcapi/openid4vp/v1/initiate`, `/dcapi/openid4vp/v1/validate` | Google Wallet, Chrome Android |

iOS: `navigator.credentials.get()` must run inside the user gesture. Start `POST
/identity/verifications` on **pointerdown**, await it on **click**.

## Env (backend, staging only, never `NEXT_PUBLIC_`)

```
CREDENCE_BASE_URL=https://credenceid.com/cloudsdkdev
CREDENCE_LICENSE_KEY=CS-...
CREDENCE_PROFILE_ID=<uuid>
CREDENCE_ORIGIN=https://staging.paralegix.com
```

Add all four, commented, to `backend/.env.example`. Missing config answers 503
`IDENTITY_VERIFICATION_UNCONFIGURED`.

## Table `client_identity_verifications` (migration via the new-migration workflow)

Columns from the spec: `id`, `law_firm_id`, `client_id`, `user_id`, `method` (`mdoc_dcapi |
openid4vp_dcapi | w3c_openid4vp`), `status` (`pending | verified | failed | cancelled | expired`,
default pending), `provider_session_id` (unique), `verified_given_name`, `verified_family_name`,
`issuer`, `doc_type`, `credential_expires_on date`, `is_name_match boolean` (named for the schema's `is_` boolean rule; the API field stays `nameMatchesRecord`), `checks jsonb not
null default '{}'`, `failure_reason`, `created_at`, `completed_at`, `expires_at` (default now() + 10
minutes). It MUST also follow `.claude/rules/backend-data-model.md` and
`tests/schema/conventions.test.ts`: `unique (law_firm_id, id)`, composite FK `(law_firm_id,
client_id) references clients (law_firm_id, id) on delete cascade`, `user_id text` real FK to
`users(id)` with an explicit on delete action (and `db:user-delete-guards` /
`findAccountActivity` if required), `updated_at` + the `set_updated_at` trigger (the row is
mutable), indexes led by `law_firm_id`, an index whose first column is every FK column.

## API contract

Portal router, mounted beside `clientPortalModuleRoutes` under `/api/client-portal`, middleware like
`backend/src/modules/clients/portal/portal.routes.ts` (`verifyToken`, `requireUserType(['client'])`,
the per-firm gate those routes use). Client resolution through `resolveClientAssociations` +
`selectActiveClientAssociation`, honouring the same active-client selector those routes accept.
Person clients only (403 for a company roster user).

| Method | Path | Body | Answer |
|---|---|---|---|
| POST | `/lawfirm/:lawFirmId/identity/verifications` | `{ method }` | 201 `{ verificationId, method, request }` |
| POST | `/lawfirm/:lawFirmId/identity/verifications/:verificationId/complete` | `{ data: string }` (max ~200 KB) | 200 `{ result: VerificationResult }` |
| POST | `/lawfirm/:lawFirmId/identity/verifications/:verificationId/poll` | none | 200 `{ result: VerificationResult }` |
| GET | `/lawfirm/:lawFirmId/identity` | none | 200 `{ configured: boolean, latest: VerificationResult \| null }` |

`request` is the Credence `dcRequest` (A), `payload` (B), or `{ walletUrl }` (D) where `walletUrl =
'openid4vp://authorize?client_id=' + encodeURIComponent(client_id) + '&request_uri=' +
encodeURIComponent(requestUri)`.

Firm route: `GET /api/lawfirms/:lawFirmId/clients/:clientId/identity-verification`, `verifyToken`,
`requirePermission('clients.view')`, `assertLawFirmMembership` first. Answer 200 `{ verified:
VerificationResult | null, latestAttempt: VerificationResult | null }`.

```ts
type VerificationStatus = 'pending' | 'verified' | 'failed' | 'cancelled' | 'expired'
type VerificationResult = {
  verificationId: string
  method: 'mdoc_dcapi' | 'openid4vp_dcapi' | 'w3c_openid4vp'
  status: VerificationStatus
  verifiedName: { given: string | null; family: string | null } | null
  issuer: string | null          // issuing jurisdiction, e.g. "California" / "US-CA"
  docType: string | null
  credentialExpiresOn: string | null  // 'YYYY-MM-DD'
  nameMatchesRecord: boolean | null
  checks: Record<string, boolean | string>
  failureReason: string | null
  createdAt: string
  completedAt: string | null
}
```

Errors: 404 for a verification that is not the caller's (never reveal other rows); 409 for one that
is not pending or has expired (expired rows are marked `expired`); 429 from the rate limiter (10
starts per user per hour, in `shared/middleware/rateLimiters.ts`); 503 unconfigured or
DOMAIN_MISMATCH; 502 provider error with generic copy (never echo the provider body or the license
key).

Completion: `cancelled` sets `cancelled`. `res === false` sets `failed` with `failure_reason` from
`authentication.authenticationResult` and stores no names. `res === true`: parse `resDetails`
(JSON string), take `documents[0] ?? top level`, store only the kept fields, compute name match
(NFKD, strip diacritics, lowercase, collapse whitespace and hyphens; given + family vs the client
record's `name`, since `clients` has a single name column), write an audit entry and emit `CLIENT_IDENTITY_VERIFIED` per
`.claude/rules/backend-events.md` so firm members get a notification. Flow D `success` requires
every boolean in `verificationDetails` to be true; those booleans are the `checks`.

### Backend as built (deviations and clarifications)

- Completing a `w3c_openid4vp` verification, or polling an `mdoc_dcapi`/`openid4vp_dcapi` one,
  answers 400. Polling a finished verification answers 409 like complete does, so the Flow D
  poller must stop on the first non-pending `result`.
- `GET /identity` is person-only too: an organization as the active client answers 403.
- `clients.view` is in every member's baseline, so the firm route admits any member of the firm;
  non-members (other firms, portal clients) get 403. Unknown or malformed `clientId` is 404.
- Validation failures (unknown `method`, `data` empty or over 200,000 chars) answer 400.
- Migration is `0049_client_identity_verifications.sql`, numbered after this branch's
  `0048_word_templates.sql`. `origin/staging` already has 0049 to 0053, so it must be renumbered
  when merged there.

## Frontend

- `src/services/identityVerification.service.ts` (the four portal calls + the firm read, transport
  like `client-portal.service.ts`; `npm run check:service-transport`).
- `src/hooks/useIdentityVerification.ts` (Flow A with pointerdown prefetch, Flow D QR + 2 s polling
  for 3 minutes; NotAllowedError means cancelled; unsupported browser).
- `src/types/digital-credentials.d.ts`.
- `src/app/client/lawfirm/[lawFirmId]/identity/page.tsx`: header "Verify your identity"; copy "Your
  attorney asks for this once. You'll share your name and the state that issued your ID. Paralegix
  doesn't keep a copy of your ID."; primary "Verify with my phone's wallet" when the DC API exists,
  else "Show QR code" (`qrcode` package) plus "Open wallet app" on mobile; result states verified,
  name differs (still verified, asks them to contact the firm), failed, cancelled with retry; a
  calm "not available yet" state when `configured` is false.
- Portal nav entry "Identity" and a card on the portal firm home while not verified.
- `src/components/clients/IdentityVerifiedBadge.tsx` on the firm's client detail header: green "ID
  verified Oct 14, 2026 · California" with a tooltip listing the checks, amber "Verified, name
  differs" when `nameMatchesRecord` is false, nothing when never verified. Repo date helpers.

## Docs

`docs/features/identity-verification.md` (writing-feature-docs), registered in the docs `devSidebar`
and the table in `.claude/rules/backend-module.md`.

## Appendix A: Credence client, as specified (use as the starting point)

`backend/src/modules/identityVerification/credence.types.ts`

```ts
export type CredenceTokens = { accessToken: string; refreshToken: string; expiresIn: number; tokenType: string };
export type CredenceSetupResponse = CredenceTokens & { customerName: string; profileName: string };

export type GetDocRequestResponse = { sessionId: string; dcRequest: { deviceRequest: string; encryptionInfo: string } };
export type DcVerifyResponse = { res: boolean; resDetails: string; cancelled?: boolean };
export type OpenId4vpInitiateResponse = { sessionId: string; payload: Record<string, unknown> };
export type W3cInitiateResponse = { sessionId: string; authorizationRequest: { client_id: string; [k: string]: unknown }; callbackUrl: string; requestUri: string };
export type W3cVerificationDetails = {
  vpSignatureValid: boolean; vcSignatureValid: boolean; nonceMatches: boolean; audienceMatches: boolean;
  issuerTrusted: boolean; notExpired: boolean; credentialTypeMatches: boolean;
};
export type W3cResultResponse = {
  success: boolean; claims: Record<string, unknown> | null; issuer: string | null; issuanceDate: string | null;
  expirationDate: string | null; credentialType: string[] | null; verificationDetails: W3cVerificationDetails | null; error: string | null;
};
export type MdocAuthentication = {
  authenticationResult: string; issuerRecognized?: boolean; issuerSignedAuthenticated?: boolean;
  deviceSignedAuthenticated?: boolean; dataIntegrity?: boolean; msoValidity?: string; issuerSubjectInfo?: string;
};
export type MdocResDetails = {
  identity: { given_name?: string; family_name?: string; issuing_authority?: string; issuing_country?: string; expiry_date?: string; [k: string]: unknown };
  authentication: MdocAuthentication;
  documents?: { docType?: string; identity: MdocResDetails['identity']; authentication: MdocAuthentication }[];
};
```

`backend/src/modules/identityVerification/credence.client.ts`

```ts
import type {
  CredenceSetupResponse, CredenceTokens, GetDocRequestResponse, DcVerifyResponse,
  OpenId4vpInitiateResponse, W3cInitiateResponse, W3cResultResponse,
} from './credence.types';
const { AppError } = require('../../shared/errors/AppError');

type Config = { baseUrl: string; licenseKey: string; profileId: string; origin: string };

function readConfig(): Config {
  const { CREDENCE_BASE_URL, CREDENCE_LICENSE_KEY, CREDENCE_PROFILE_ID, CREDENCE_ORIGIN } = process.env;
  if (!CREDENCE_BASE_URL || !CREDENCE_LICENSE_KEY || !CREDENCE_PROFILE_ID || !CREDENCE_ORIGIN) {
    throw new AppError('Identity verification is not configured.', 503, 'IDENTITY_VERIFICATION_UNCONFIGURED');
  }
  return { baseUrl: CREDENCE_BASE_URL.replace(/\/+$/, ''), licenseKey: CREDENCE_LICENSE_KEY, profileId: CREDENCE_PROFILE_ID, origin: CREDENCE_ORIGIN };
}

type Cached = { accessToken: string; refreshToken: string; accessExpiresAt: number; refreshExpiresAt: number };
let cached: Cached | null = null;
let inflight: Promise<string> | null = null;
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SKEW_MS = 60_000;

async function call<T>(path: string, init: { body?: unknown; token?: string; allow202?: boolean } = {}): Promise<{ status: number; data: T }> {
  const cfg = readConfig();
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: cfg.origin,
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
    body: JSON.stringify(init.body ?? {}),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 202 && init.allow202) return { status: 202, data: null as T };
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Log for us, generic copy for the user (never echo the provider body).
    console.error(`credence ${path} failed: ${res.status} ${text.slice(0, 500)}`);
    if (res.status === 403 && text.includes('DOMAIN_MISMATCH')) {
      throw new AppError('Identity verification is misconfigured for this site.', 503, 'IDENTITY_PROVIDER_DOMAIN');
    }
    throw new AppError('The identity provider is unavailable. Please try again.', 502, 'IDENTITY_PROVIDER_ERROR');
  }
  return { status: res.status, data: (await res.json()) as T };
}

function store(t: CredenceTokens): string {
  const now = Date.now();
  cached = { accessToken: t.accessToken, refreshToken: t.refreshToken, accessExpiresAt: now + t.expiresIn * 1000, refreshExpiresAt: now + REFRESH_TTL_MS };
  return t.accessToken;
}

async function acquireToken(): Promise<string> {
  const now = Date.now();
  if (cached && cached.accessExpiresAt - now > SKEW_MS) return cached.accessToken;
  if (cached && cached.refreshExpiresAt - now > SKEW_MS) {
    try {
      const { data } = await call<CredenceTokens>('/v1/refresh', { body: { refreshToken: cached.refreshToken } });
      return store(data);
    } catch { cached = null; }
  }
  const cfg = readConfig();
  const { data } = await call<CredenceSetupResponse>('/v1/setup', { body: { licenseKey: cfg.licenseKey, profileId: cfg.profileId } });
  return store(data);
}

async function token(): Promise<string> {
  if (!inflight) inflight = acquireToken().finally(() => { inflight = null; });
  return inflight;
}

export async function getDocRequest(): Promise<GetDocRequestResponse> {
  return (await call<GetDocRequestResponse>('/v1/getDocRequest', { token: await token() })).data;
}
export async function verifyDocRequest(sessionId: string, data: string): Promise<DcVerifyResponse> {
  return (await call<DcVerifyResponse>('/v1/verifyDocRequest', { token: await token(), body: { sessionId, data } })).data;
}
export async function initiateOpenId4vp(): Promise<OpenId4vpInitiateResponse> {
  return (await call<OpenId4vpInitiateResponse>('/dcapi/openid4vp/v1/initiate', { token: await token() })).data;
}
export async function validateOpenId4vp(sessionId: string, data: string): Promise<DcVerifyResponse> {
  return (await call<DcVerifyResponse>('/dcapi/openid4vp/v1/validate', { token: await token(), body: { sessionId, data } })).data;
}
export async function initiateW3c(): Promise<W3cInitiateResponse> {
  return (await call<W3cInitiateResponse>('/w3c/openid4vp/v1/initiate', { token: await token() })).data;
}
/** null while the wallet has not answered yet (HTTP 202). */
export async function pollW3c(sessionId: string): Promise<W3cResultResponse | null> {
  const r = await call<W3cResultResponse>('/w3c/openid4vp/v1/validate', { token: await token(), body: { sessionId }, allow202: true });
  return r.status === 202 ? null : r.data;
}

export function __resetCredenceTokenCache(): void { cached = null; inflight = null; }
```

Required client tests (mock `global.fetch`): setup called once for two concurrent calls; an access
token within 60 s of expiry triggers `/v1/refresh`, not `/v1/setup`; a failed refresh falls back to
`/v1/setup`; `Origin` and `Authorization` headers are sent; 403 `DOMAIN_MISMATCH` maps to
`IDENTITY_PROVIDER_DOMAIN`; the license key never appears in a thrown error message; 202 on
`pollW3c` returns `null`.

Required route/service tests (Credence client mocked): stranger from another firm: start 403,
complete 404, firm read 403 (FIRST); client B cannot complete client A's verification in the same
firm (404); completing twice 409; completing after `expires_at` 409 and the row becomes `expired`;
`res: false` stores `failed` and no names; `res: true` stores names, issuer, and
`name_matches_record` true for "José  Núñez-Díaz" vs record "Jose Nunez Diaz", false for "Jon
Smith" vs "Jane Smith"; portrait and license number in `resDetails` are NOT persisted (row and
response contain no `portrait` key and no license number value); responses never contain
`provider_session_id`.

Required hook tests (`navigator.credentials.get` mocked): success; user cancel (DOMException
NotAllowedError) is `cancelled`; unsupported browser; Flow D 202-then-200 polling.
