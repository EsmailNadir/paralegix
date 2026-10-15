/**
 * Client identity verification through Credence ID.
 *
 * A portal client starts an attempt, presents the driver's license in their
 * phone wallet, and the firm sees the outcome on the client record. The design
 * rules this file enforces:
 *
 * - An attempt is bound to one client row and one portal user. Only that user
 *   may complete or poll it, once, inside its ten-minute window. Another user's
 *   attempt reads as absent (404), never as forbidden.
 * - Only the name, issuer, document type, credential expiry and check results
 *   are kept. Everything else the provider returns (portrait, signature image,
 *   license number, address, birth date) is dropped here and never stored,
 *   returned or logged.
 * - A name that differs from the client record is still verified; the
 *   mismatch is a flag for the firm, not a refusal.
 * - The provider's session id never leaves the backend.
 */
import eventBus from '../../shared/events/eventBus';
import { CLIENT_IDENTITY_VERIFIED } from '../../shared/events/eventTypes';
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../shared/errors/AppError';
import { assertLawFirmMembership } from '../../shared/utils/membership';
import { isUuid } from '../../shared/utils/isUuid';
import { rowIso } from '../../shared/utils/dateConversion';
import { recordAudit } from '../audit/audit.service';
import clientsRepo from '../clients/clients.repository';
import { getActiveClientAccessContext } from '../clients/portal/portal.service';
import * as credence from './credence.client';
import type { DcVerifyResponse, MdocAuthentication, MdocIdentity, MdocResDetails, W3cResultResponse } from './credence.types';
import * as repo from './identityVerification.repository';
import type { VerificationOutcome, VerificationRow } from './identityVerification.repository';
import type { VerificationMethod, VerificationStatus } from './identityVerification.validation';

export type VerificationResult = {
  verificationId: string;
  method: VerificationMethod;
  status: VerificationStatus;
  verifiedName: { given: string | null; family: string | null } | null;
  issuer: string | null;
  docType: string | null;
  credentialExpiresOn: string | null;
  nameMatchesRecord: boolean | null;
  checks: Record<string, boolean | string>;
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
};

type PortalCaller = { lawFirmId: string; userId: string; userData?: unknown; clientRecordId?: string };

// ── Shaping ──────────────────────────────────────────────────────────────

/** A row as the API answers it. Never carries the provider session id. */
function formatResult(row: VerificationRow): VerificationResult {
  // A pending row past its window reads as expired even before anything
  // writes that down; the next complete or poll on it records it.
  const lapsed = row.status === 'pending' && row.expiresAt instanceof Date && row.expiresAt.getTime() <= Date.now();
  const hasName = Boolean(row.verifiedGivenName || row.verifiedFamilyName);
  return {
    verificationId: row.id,
    method: row.method as VerificationMethod,
    status: (lapsed ? 'expired' : row.status) as VerificationStatus,
    verifiedName: hasName ? { given: row.verifiedGivenName ?? null, family: row.verifiedFamilyName ?? null } : null,
    issuer: row.issuer ?? null,
    docType: row.docType ?? null,
    credentialExpiresOn: row.credentialExpiresOn ?? null,
    nameMatchesRecord: row.isNameMatch ?? null,
    checks: (row.checks ?? {}) as Record<string, boolean | string>,
    failureReason: row.failureReason ?? null,
    createdAt: rowIso(row.createdAt) as string,
    completedAt: rowIso(row.completedAt),
  };
}

// ── Reading the provider's answer ────────────────────────────────────────

const MAX_TEXT = 200;

/** A trimmed, bounded string, or null for anything that is not a non-empty string. */
function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT) : null;
}

/** The `YYYY-MM-DD` day of a date or timestamp string, or null. */
function dayOnly(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return match ? match[1] : null;
}

/**
 * A name reduced for comparison: compatibility-decomposed with the accents
 * dropped, lowercased, and every run of spaces and hyphens folded to one space.
 * "José  Núñez-Díaz" and "Jose Nunez Diaz" reduce to the same string.
 */
function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[\s\-\u2010-\u2015]+/g, ' ')
    .trim();
}

/** Whether the credential's given and family name together match the record. */
function nameMatches(given: string | null, family: string | null, recordName: unknown): boolean | null {
  const record = typeof recordName === 'string' ? normalizeName(recordName) : '';
  const credentialName = normalizeName(`${given ?? ''} ${family ?? ''}`);
  if (!record || !credentialName) return null;
  return credentialName === record;
}

/** The mdoc checks the firm sees, by name. Nothing else from `authentication` is kept. */
const MDOC_CHECK_KEYS = [
  'authenticationResult',
  'issuerRecognized',
  'issuerSignedAuthenticated',
  'deviceSignedAuthenticated',
  'dataIntegrity',
  'msoValidity',
] as const;

function mdocChecks(auth: MdocAuthentication | undefined): Record<string, boolean | string> {
  const checks: Record<string, boolean | string> = {};
  if (!auth || typeof auth !== 'object') return checks;
  for (const key of MDOC_CHECK_KEYS) {
    const value = (auth as Record<string, unknown>)[key];
    if (typeof value === 'boolean') checks[key] = value;
    else if (typeof value === 'string') checks[key] = value.slice(0, MAX_TEXT);
  }
  return checks;
}

function parseResDetails(raw: unknown): MdocResDetails | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as MdocResDetails) : null;
  } catch {
    return null;
  }
}

/** Flows A and B: the Digital Credentials API answer, reduced to what is kept. */
function interpretDcAnswer(answer: DcVerifyResponse, recordName: unknown): VerificationOutcome {
  if (answer?.cancelled === true) return { status: 'cancelled' };

  const details = parseResDetails(answer?.resDetails);
  const doc: { docType?: string; identity?: MdocIdentity; authentication?: MdocAuthentication } | null =
    details?.documents?.[0] ?? details;
  const checks = mdocChecks(doc?.authentication);

  if (answer?.res !== true) {
    return {
      status: 'failed',
      checks,
      failureReason: cleanText(doc?.authentication?.authenticationResult) ?? 'Verification failed',
    };
  }

  const identity = doc?.identity;
  if (!identity || typeof identity !== 'object') {
    return { status: 'failed', checks, failureReason: 'The provider result could not be read' };
  }

  const given = cleanText(identity.given_name);
  const family = cleanText(identity.family_name);
  return {
    status: 'verified',
    verifiedGivenName: given,
    verifiedFamilyName: family,
    issuer: cleanText(identity.issuing_authority) ?? cleanText(identity.issuing_country),
    docType: cleanText(doc?.docType),
    credentialExpiresOn: dayOnly(identity.expiry_date),
    isNameMatch: nameMatches(given, family, recordName),
    checks,
  };
}

/**
 * Flow D: the W3C OpenID4VP answer. Success requires the provider's own flag
 * AND every boolean in `verificationDetails`; those booleans are the checks.
 */
function interpretW3cAnswer(answer: W3cResultResponse, recordName: unknown): VerificationOutcome {
  const checks: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(answer?.verificationDetails ?? {})) {
    if (typeof value === 'boolean') checks[key] = value;
  }
  const failing = Object.keys(checks).filter((key) => checks[key] !== true);
  if (answer?.success !== true || !Object.keys(checks).length || failing.length) {
    return {
      status: 'failed',
      checks,
      failureReason: cleanText(answer?.error)
        ?? (failing.length ? `Check failed: ${failing.join(', ')}` : 'Verification failed'),
    };
  }

  const claims = (answer.claims ?? {}) as Record<string, unknown>;
  const given = cleanText(claims.given_name);
  const family = cleanText(claims.family_name);
  const types = Array.isArray(answer.credentialType) ? answer.credentialType : [];
  return {
    status: 'verified',
    verifiedGivenName: given,
    verifiedFamilyName: family,
    issuer: cleanText(answer.issuer),
    docType: cleanText(types[types.length - 1]),
    credentialExpiresOn: dayOnly(answer.expirationDate),
    isNameMatch: nameMatches(given, family, recordName),
    checks,
  };
}

// ── Guards ───────────────────────────────────────────────────────────────

function assertConfigured(): void {
  if (!credence.isCredenceConfigured()) {
    throw new AppError('Identity verification is not configured.', 503, 'IDENTITY_VERIFICATION_UNCONFIGURED');
  }
}

/**
 * The caller's active client association in this firm, which must be a person.
 * Uses the same resolver and `clientRecordId` selector as every portal route.
 */
async function personContext({ lawFirmId, userId, userData, clientRecordId }: PortalCaller) {
  const context = await getActiveClientAccessContext({
    lawFirmId, clientUserId: userId, userData, clientRecordId,
  });
  if (context.clientType !== 'person') {
    throw new ForbiddenError('Identity verification is available to individual clients only.');
  }
  return context;
}

/** The caller's own attempt, or 404. */
async function ownVerification(lawFirmId: string, verificationId: string, userId: string): Promise<VerificationRow> {
  const row = await repo.findForUser(lawFirmId, verificationId, userId);
  if (!row) throw new NotFoundError('Verification');
  return row;
}

/** 409 unless the attempt is still pending and inside its window; records a lapse. */
async function assertOpen(row: VerificationRow): Promise<void> {
  if (row.status !== 'pending') {
    throw new ConflictError('This verification has already finished. Start a new one.');
  }
  if (await repo.expireIfDue(row.lawFirmId, row.id)) {
    throw new ConflictError('This verification has expired. Start a new one.');
  }
}

/**
 * Write the outcome once. A verified outcome is audited and announced to the
 * firm; nothing else is.
 */
async function finish(
  row: VerificationRow,
  outcome: VerificationOutcome,
  context: { clientRecord?: { name?: string | null } | null },
): Promise<{ result: VerificationResult }> {
  const finished = await repo.finishPending(row.lawFirmId, row.id, outcome);
  if (!finished) {
    if (await repo.expireIfDue(row.lawFirmId, row.id)) {
      throw new ConflictError('This verification has expired. Start a new one.');
    }
    throw new ConflictError('This verification has already finished. Start a new one.');
  }

  if (finished.status === 'verified') {
    await recordAudit({
      lawFirmId: finished.lawFirmId,
      actorUid: finished.userId,
      action: 'client.identity_verified',
      resourceType: 'client',
      resourceId: finished.clientId,
      metadata: {
        verificationId: finished.id,
        method: finished.method,
        issuer: finished.issuer,
        docType: finished.docType,
        nameMatchesRecord: finished.isNameMatch,
      },
    });
    eventBus.emit(CLIENT_IDENTITY_VERIFIED, {
      lawFirmId: finished.lawFirmId,
      clientId: finished.clientId,
      verificationId: finished.id,
      userId: finished.userId,
      clientName: context.clientRecord?.name ?? null,
      issuer: finished.issuer,
      nameMatchesRecord: finished.isNameMatch,
    });
  }

  return { result: formatResult(finished) };
}

// ── Portal ───────────────────────────────────────────────────────────────

/** Start an attempt: ask Credence for a wallet request and bind it to this client and user. */
export async function startVerification(
  { method, ...caller }: PortalCaller & { method: VerificationMethod },
): Promise<{ verificationId: string; method: VerificationMethod; request: unknown }> {
  const context = await personContext(caller);
  assertConfigured();

  let providerSessionId: string;
  let request: unknown;
  if (method === 'mdoc_dcapi') {
    const started = await credence.getDocRequest();
    providerSessionId = started.sessionId;
    request = started.dcRequest;
  } else if (method === 'openid4vp_dcapi') {
    const started = await credence.initiateOpenId4vp();
    providerSessionId = started.sessionId;
    request = started.payload;
  } else {
    const started = await credence.initiateW3c();
    providerSessionId = started.sessionId;
    request = {
      walletUrl: `openid4vp://authorize?client_id=${encodeURIComponent(started.authorizationRequest.client_id)}`
        + `&request_uri=${encodeURIComponent(started.requestUri)}`,
    };
  }
  if (typeof providerSessionId !== 'string' || !providerSessionId) {
    throw new AppError('The identity provider is unavailable. Please try again.', 502, 'IDENTITY_PROVIDER_ERROR');
  }

  const row = await repo.insertVerification(caller.lawFirmId, {
    clientId: context.clientRecordId,
    userId: caller.userId,
    method,
    providerSessionId,
  });
  return { verificationId: row.id, method, request };
}

/** Finish a Digital Credentials API attempt (flows A and B) with the wallet's response. */
export async function completeVerification(
  { verificationId, data, ...caller }: PortalCaller & { verificationId: string; data: string },
): Promise<{ result: VerificationResult }> {
  const row = await ownVerification(caller.lawFirmId, verificationId, caller.userId);
  const context = await personContext({ ...caller, clientRecordId: row.clientId });
  if (row.method === 'w3c_openid4vp') {
    throw new ValidationError('This verification finishes in the wallet app. Poll it instead.');
  }
  await assertOpen(row);
  assertConfigured();

  const answer = row.method === 'mdoc_dcapi'
    ? await credence.verifyDocRequest(row.providerSessionId, data)
    : await credence.validateOpenId4vp(row.providerSessionId, data);
  return finish(row, interpretDcAnswer(answer, context.clientRecord?.name), context);
}

/** Check a wallet-app attempt (flow D). Still pending while the wallet has not answered. */
export async function pollVerification(
  { verificationId, ...caller }: PortalCaller & { verificationId: string },
): Promise<{ result: VerificationResult }> {
  const row = await ownVerification(caller.lawFirmId, verificationId, caller.userId);
  const context = await personContext({ ...caller, clientRecordId: row.clientId });
  if (row.method !== 'w3c_openid4vp') {
    throw new ValidationError('This verification finishes in the browser. Complete it instead.');
  }
  await assertOpen(row);
  assertConfigured();

  const answer = await credence.pollW3c(row.providerSessionId);
  if (answer === null) return { result: formatResult(row) };
  return finish(row, interpretW3cAnswer(answer, context.clientRecord?.name), context);
}

/** Whether verification is available, and this client's latest attempt. */
export async function getPortalIdentity(
  caller: PortalCaller,
): Promise<{ configured: boolean; latest: VerificationResult | null }> {
  const context = await personContext(caller);
  const latest = await repo.latestForClient(caller.lawFirmId, context.clientRecordId, { userId: caller.userId });
  return { configured: credence.isCredenceConfigured(), latest: latest ? formatResult(latest) : null };
}

// ── Firm ─────────────────────────────────────────────────────────────────

/** The client's latest verified attempt and latest attempt of any status. */
export async function getClientIdentityVerification(
  { lawFirmId, userId, clientId }: { lawFirmId: string; userId: string; clientId: string },
): Promise<{ verified: VerificationResult | null; latestAttempt: VerificationResult | null }> {
  await assertLawFirmMembership(lawFirmId, userId);
  if (!isUuid(clientId)) throw new NotFoundError('Client');
  const client = await clientsRepo.findByIdRaw(lawFirmId, clientId);
  if (!client) throw new NotFoundError('Client');

  const [verified, latestAttempt] = await Promise.all([
    repo.latestForClient(lawFirmId, clientId, { status: 'verified' }),
    repo.latestForClient(lawFirmId, clientId),
  ]);
  return {
    verified: verified ? formatResult(verified) : null,
    latestAttempt: latestAttempt ? formatResult(latestAttempt) : null,
  };
}
