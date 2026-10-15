/**
 * Response shapes of the Credence ID Cloud SDK endpoints this module calls.
 * Only the fields the backend reads are typed precisely; the rest pass through.
 */

export type CredenceTokens = { accessToken: string; refreshToken: string; expiresIn: number; tokenType: string };
export type CredenceSetupResponse = CredenceTokens & { customerName: string; profileName: string };

export type GetDocRequestResponse = { sessionId: string; dcRequest: { deviceRequest: string; encryptionInfo: string } };
export type DcVerifyResponse = { res: boolean; resDetails: string; cancelled?: boolean };
export type OpenId4vpInitiateResponse = { sessionId: string; payload: Record<string, unknown> };
export type W3cInitiateResponse = {
  sessionId: string;
  authorizationRequest: { client_id: string; [k: string]: unknown };
  callbackUrl: string;
  requestUri: string;
};
export type W3cVerificationDetails = {
  vpSignatureValid: boolean; vcSignatureValid: boolean; nonceMatches: boolean; audienceMatches: boolean;
  issuerTrusted: boolean; notExpired: boolean; credentialTypeMatches: boolean;
};
export type W3cResultResponse = {
  success: boolean;
  claims: Record<string, unknown> | null;
  issuer: string | null;
  issuanceDate: string | null;
  expirationDate: string | null;
  credentialType: string[] | null;
  verificationDetails: W3cVerificationDetails | null;
  error: string | null;
};
export type MdocAuthentication = {
  authenticationResult: string;
  issuerRecognized?: boolean;
  issuerSignedAuthenticated?: boolean;
  deviceSignedAuthenticated?: boolean;
  dataIntegrity?: boolean;
  msoValidity?: string;
  issuerSubjectInfo?: string;
};
export type MdocIdentity = {
  given_name?: string;
  family_name?: string;
  issuing_authority?: string;
  issuing_country?: string;
  expiry_date?: string;
  [k: string]: unknown;
};
export type MdocResDetails = {
  identity: MdocIdentity;
  authentication: MdocAuthentication;
  documents?: { docType?: string; identity: MdocIdentity; authentication: MdocAuthentication }[];
};
