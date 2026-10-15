import BaseApiService from './base.service';
import type { Court } from '@/types/court';

export interface CourtListResponse {
  courts: Court[];
}

export interface CreateCourtResponse {
  message: string;
  courtId: string;
}

export interface UpdateCourtResponse {
  message: string;
  mattersUpdated: number;
}

export interface DeleteCourtResponse {
  message: string;
}

/** On update, null clears a field and an omitted field is left unchanged. */
export interface CourtUpsertData {
  name?: string;
  abbreviation?: string | null;
  city?: string | null;
  state?: string | null;
  address?: string | null;
  courtType?: string | null;
}

class CourtsService extends BaseApiService {
  constructor() {
    super('lawfirms');
  }

  async createCourt(lawFirmId: string, data: CourtUpsertData & { name: string }): Promise<CreateCourtResponse> {
    return this.request(this.url(lawFirmId, 'courts'), {
      method: 'POST',
      body: data,
      errorMessage: 'Failed to create court',
    });
  }

  async listCourts(lawFirmId: string): Promise<CourtListResponse> {
    return this.dedupedGet(this.url(lawFirmId, 'courts'), { errorMessage: 'Failed to list courts' });
  }

  async updateCourt(lawFirmId: string, courtId: string, data: CourtUpsertData): Promise<UpdateCourtResponse> {
    return this.request(this.url(lawFirmId, 'courts', courtId), {
      method: 'PUT',
      body: data,
      errorMessage: 'Failed to update court',
    });
  }

  async deleteCourt(lawFirmId: string, courtId: string): Promise<DeleteCourtResponse> {
    return this.request(this.url(lawFirmId, 'courts', courtId), {
      method: 'DELETE',
      errorMessage: 'Failed to delete court',
    });
  }
}

const courtsService = new CourtsService();
export default courtsService;
