import { apiFetch } from '@/lib/utils/fetchWithTokenRefresh';
import { toApiError } from '@/lib/utils/apiErrors';
import { authenticatedHeaders } from './base.service';
import requestDeduplicator from './requestDeduplicator';
import type {
  ClientIdentityVerification,
  PortalIdentityStatus,
  StartedVerification,
  VerificationMethod,
  VerificationResult,
} from '@/types/identityVerification';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';

/**
 * Client identity verification (Credence ID). The portal calls start, finish
 * and poll a verification for the active client record; the firm reads the
 * outcome for one client. Every Credence call is proxied by the backend, so
 * nothing here ever carries the license key or Credence's session id.
 *
 * The active client record rides in the query string, the same way every
 * other portal route receives it (`client-portal.service.ts`).
 */
class IdentityVerificationService {
  private readonly portalUrl = `${API_URL}/client-portal`;

  private withClientRecordId(url: string, clientRecordId?: string | null): string {
    if (!clientRecordId) return url;
    return `${url}?clientRecordId=${encodeURIComponent(clientRecordId)}`;
  }

  private identityUrl(lawFirmId: string, path = ''): string {
    return `${this.portalUrl}/lawfirm/${encodeURIComponent(lawFirmId)}/identity${path}`;
  }

  private async post(url: string, body: unknown, fallbackMessage: string): Promise<Response> {
    const response = await apiFetch(url, {
      method: 'POST',
      headers: await authenticatedHeaders(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw await toApiError(response, fallbackMessage);
    return response;
  }

  /** Whether verification is set up for this firm, and the client's latest result. */
  async getPortalStatus(lawFirmId: string, clientRecordId?: string | null): Promise<PortalIdentityStatus> {
    return requestDeduplicator.execute<PortalIdentityStatus>(
      this.withClientRecordId(this.identityUrl(lawFirmId), clientRecordId),
      { method: 'GET', headers: await authenticatedHeaders() },
    );
  }

  async start(lawFirmId: string, method: VerificationMethod, clientRecordId?: string | null): Promise<StartedVerification> {
    const response = await this.post(
      this.withClientRecordId(this.identityUrl(lawFirmId, '/verifications'), clientRecordId),
      { method },
      "We couldn't start identity verification",
    );
    return response.json();
  }

  /** Hand the wallet's response to the backend, which verifies it with Credence. */
  async complete(
    lawFirmId: string,
    verificationId: string,
    data: string,
    clientRecordId?: string | null,
  ): Promise<VerificationResult> {
    const response = await this.post(
      this.withClientRecordId(
        this.identityUrl(lawFirmId, `/verifications/${encodeURIComponent(verificationId)}/complete`),
        clientRecordId,
      ),
      { data },
      "We couldn't verify your ID",
    );
    const body = (await response.json()) as { result: VerificationResult };
    return body.result;
  }

  /**
   * Ask whether the wallet app has answered yet (Flow D). Null while it has
   * not: a 202, or no result in the body.
   */
  async poll(lawFirmId: string, verificationId: string, clientRecordId?: string | null): Promise<VerificationResult | null> {
    const response = await this.post(
      this.withClientRecordId(
        this.identityUrl(lawFirmId, `/verifications/${encodeURIComponent(verificationId)}/poll`),
        clientRecordId,
      ),
      undefined,
      "We couldn't check on your verification",
    );
    if (response.status === 202) return null;
    const body = (await response.json().catch(() => ({}))) as { result?: VerificationResult };
    return body.result ?? null;
  }

  /** The firm's view of one client: the last successful verification, and the last attempt. */
  async getClientVerification(lawFirmId: string, clientId: string): Promise<ClientIdentityVerification> {
    return requestDeduplicator.execute<ClientIdentityVerification>(
      `${API_URL}/lawfirms/${encodeURIComponent(lawFirmId)}/clients/${encodeURIComponent(clientId)}/identity-verification`,
      { method: 'GET', headers: await authenticatedHeaders() },
    );
  }
}

const identityVerificationService = new IdentityVerificationService();
export default identityVerificationService;
