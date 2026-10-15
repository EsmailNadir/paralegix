import BaseApiService from './base.service';

export interface ConsentResponse { message: string; consentVersion: string; }
export interface EraseResponse { message: string; erasedAt?: string; }
export interface EraseClientResponse { message: string; clientId: string; }

/** Data-subject consent, export, and erasure requests. */
class PrivacyService extends BaseApiService {
  private clientBase(lawFirmId: string, clientId: string): string {
    return this.url('lawfirms', lawFirmId, 'clients', clientId);
  }

  acceptTerms(version?: string): Promise<ConsentResponse> {
    return this.request(this.url('privacy', 'accept-terms'), {
      method: 'POST', body: version ? { version } : {}, errorMessage: 'Failed to record consent',
    });
  }

  exportMyData(): Promise<Record<string, unknown>> {
    return this.dedupedGet(this.url('privacy', 'me', 'export'), { errorMessage: 'Failed to export personal data' });
  }

  eraseMyAccount(): Promise<EraseResponse> {
    return this.request(this.url('privacy', 'me'), { method: 'DELETE', errorMessage: 'Failed to erase account' });
  }

  exportClientData(lawFirmId: string, clientId: string): Promise<Record<string, unknown>> {
    return this.dedupedGet(`${this.clientBase(lawFirmId, clientId)}/data-export`, {
      errorMessage: 'Failed to export client data',
    });
  }

  eraseClient(lawFirmId: string, clientId: string): Promise<EraseClientResponse> {
    return this.request(`${this.clientBase(lawFirmId, clientId)}/erase`, {
      method: 'POST', body: {}, errorMessage: 'Failed to erase client',
    });
  }
}

const privacyService = new PrivacyService();
export default privacyService;
