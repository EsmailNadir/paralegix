/**
 * Client identity verification (Credence ID). These mirror the backend's
 * portal and firm contract exactly; the browser never sees Credence's own
 * session id, the license key, or any raw ID data.
 */

export type VerificationStatus = 'pending' | 'verified' | 'failed' | 'cancelled' | 'expired';

export type VerificationMethod = 'mdoc_dcapi' | 'openid4vp_dcapi' | 'w3c_openid4vp';

export interface VerificationResult {
  verificationId: string;
  method: VerificationMethod;
  status: VerificationStatus;
  verifiedName: { given: string | null; family: string | null } | null;
  /** Issuing jurisdiction, e.g. "California" or "US-CA". */
  issuer: string | null;
  docType: string | null;
  /** Day-only 'YYYY-MM-DD'. */
  credentialExpiresOn: string | null;
  nameMatchesRecord: boolean | null;
  checks: Record<string, boolean | string>;
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
}

/**
 * What `POST .../identity/verifications` answers. `request` is the Credence
 * `dcRequest` for Flow A, the OpenID4VP payload for Flow B, or `{ walletUrl }`
 * for Flow D.
 */
export interface StartedVerification {
  verificationId: string;
  method: VerificationMethod;
  request: unknown;
}

/** `GET /client-portal/lawfirm/:lawFirmId/identity`. */
export interface PortalIdentityStatus {
  configured: boolean;
  latest: VerificationResult | null;
}

/** `GET /lawfirms/:lawFirmId/clients/:clientId/identity-verification`. */
export interface ClientIdentityVerification {
  verified: VerificationResult | null;
  latestAttempt: VerificationResult | null;
}
