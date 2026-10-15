/**
 * The W3C Digital Credentials API, as Safari (iOS 17.4+) and Chrome 141+ ship
 * it: `navigator.credentials.get({ digital: { requests: [...] } })` opens the
 * phone wallet and resolves to a `DigitalCredential`.
 *
 * TypeScript's DOM lib already declares `DigitalCredential` itself (the
 * interface and the global constructor), so the interface below only merges
 * with identical members and the constructor is not redeclared. What the lib
 * lacks is the `digital` member of `CredentialRequestOptions`, added here.
 */

interface DigitalCredential extends Credential {
  readonly data: any;
  readonly protocol: string;
}

interface DigitalCredentialGetRequest {
  /** e.g. 'org-iso-mdoc' (Apple Wallet) or 'openid4vp-v1-unsigned'. */
  protocol: string;
  /** The protocol's request object, passed through untouched. */
  data: unknown;
}

interface DigitalCredentialRequestOptions {
  requests: DigitalCredentialGetRequest[];
}

interface CredentialRequestOptions {
  digital?: DigitalCredentialRequestOptions;
}
