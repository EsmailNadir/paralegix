/**
 * Readable names for the checks Credence reports: the mdoc (Apple Wallet)
 * checks and the W3C OpenID4VP ones. A key not listed here is spelled out from
 * its camelCase so a new check still reads as words rather than a raw key.
 */
const CHECK_LABELS: Record<string, string> = {
  authenticationResult: "Authentication result",
  issuerRecognized: "Issuer recognized",
  issuerSignedAuthenticated: "Issuer signature valid",
  deviceSignedAuthenticated: "Device signature valid",
  dataIntegrity: "Data integrity",
  msoValidity: "Document validity",
  vpSignatureValid: "Presentation signature valid",
  vcSignatureValid: "Credential signature valid",
  nonceMatches: "Request matches",
  audienceMatches: "Audience matches",
  issuerTrusted: "Issuer trusted",
  notExpired: "Not expired",
  credentialTypeMatches: "Credential type matches",
};

export function identityCheckLabel(key: string): string {
  if (CHECK_LABELS[key]) return CHECK_LABELS[key];
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
