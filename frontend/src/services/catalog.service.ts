import BaseApiService from './base.service';

export interface CatalogCourt {
  id: string;
  fullName: string;
  shortName?: string | null;
  citationAbbrev?: string | null;
  jurisdiction?: string | null;
  courtType?: string | null;
  state?: string | null;
  url?: string | null;
  inUse?: boolean;
  alreadyAdded?: boolean;
}

export interface CatalogCourtSearchResponse {
  items: CatalogCourt[];
  totalItems: number;
}

export interface UtbmsCode {
  id: string;
  code: string;
  name: string;
  codeType: 'task' | 'activity' | 'expense';
  practiceSet?: string | null;
}

export interface UtbmsListResponse {
  utbmsCodes: UtbmsCode[];
  totalItems: number;
}

export interface AdoptResponse {
  message: string;
  requested: number;
  adopted: number;
  skipped: number;
}

export interface CourtSearchParams {
  search?: string;
  state?: string;
  courtType?: string;
  jurisdiction?: string;
  limit?: number;
  offset?: number;
}

class CatalogService extends BaseApiService {
  async searchCourts(lawFirmId: string, params: CourtSearchParams = {}): Promise<CatalogCourtSearchResponse> {
    const qs = new URLSearchParams();
    if (params.search) qs.set('search', params.search);
    if (params.state) qs.set('state', params.state);
    if (params.courtType) qs.set('courtType', params.courtType);
    if (params.jurisdiction) qs.set('jurisdiction', params.jurisdiction);
    if (params.limit != null) qs.set('limit', String(params.limit));
    if (params.offset != null) qs.set('offset', String(params.offset));

    return this.dedupedGet(`${this.url('lawfirms', lawFirmId, 'catalog', 'courts')}?${qs.toString()}`, {
      errorMessage: 'Failed to search court directory',
    });
  }

  async adoptCourts(lawFirmId: string, catalogCourtIds: string[]): Promise<AdoptResponse> {
    return this.request(this.url('lawfirms', lawFirmId, 'catalog', 'courts', 'adopt'), {
      method: 'POST', body: { catalogCourtIds }, errorMessage: 'Failed to add courts',
    });
  }

  async listUtbms(lawFirmId: string, codeType?: 'task' | 'activity' | 'expense'): Promise<UtbmsListResponse> {
    const qs = new URLSearchParams();
    if (codeType) qs.set('codeType', codeType);
    return this.dedupedGet(`${this.url('lawfirms', lawFirmId, 'catalog', 'utbms')}?${qs.toString()}`, {
      errorMessage: 'Failed to load UTBMS codes',
    });
  }

  async adoptChargeCodes(lawFirmId: string, utbmsCodeIds: string[]): Promise<AdoptResponse> {
    return this.request(this.url('lawfirms', lawFirmId, 'catalog', 'charge-codes', 'adopt'), {
      method: 'POST', body: { utbmsCodeIds }, errorMessage: 'Failed to import charge codes',
    });
  }

  async adoptExpenseCategories(lawFirmId: string, utbmsCodeIds: string[]): Promise<AdoptResponse> {
    return this.request(this.url('lawfirms', lawFirmId, 'catalog', 'expense-categories', 'adopt'), {
      method: 'POST', body: { utbmsCodeIds }, errorMessage: 'Failed to import expense categories',
    });
  }
}

const catalogService = new CatalogService();
export default catalogService;
