import { z } from 'zod';

/** The three Credence flows. Mirrors the CHECK on client_identity_verifications.method. */
export const VERIFICATION_METHODS = ['mdoc_dcapi', 'openid4vp_dcapi', 'w3c_openid4vp'] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

/** Mirrors the CHECK on client_identity_verifications.status. */
export const VERIFICATION_STATUSES = ['pending', 'verified', 'failed', 'cancelled', 'expired'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/**
 * The wallet's response is an opaque encrypted blob. A real one is a few
 * kilobytes; the cap keeps a hostile body from being forwarded to the provider.
 */
export const MAX_WALLET_RESPONSE_CHARS = 200_000;

const firmParams = z.object({ lawFirmId: z.string().min(1) });
const verificationParams = firmParams.extend({ verificationId: z.string().min(1) });

export const startVerificationSchema = z.object({
  body: z.object({ method: z.enum(VERIFICATION_METHODS) }),
  params: firmParams,
  query: z.object({}).passthrough(),
});

export const completeVerificationSchema = z.object({
  body: z.object({ data: z.string().min(1).max(MAX_WALLET_RESPONSE_CHARS) }),
  params: verificationParams,
  query: z.object({}).passthrough(),
});

export const pollVerificationSchema = z.object({
  params: verificationParams,
  query: z.object({}).passthrough(),
});

export const portalIdentitySchema = z.object({
  params: firmParams,
  query: z.object({}).passthrough(),
});

export const firmIdentitySchema = z.object({
  params: z.object({ lawFirmId: z.string().min(1), clientId: z.string().min(1) }),
});
