import BaseApiService from './base.service';
import type { PracticeArea } from '@/types';

export interface PracticeAreaListResponse { practiceAreas: PracticeArea[]; }
export interface CreatePracticeAreaResponse { message: string; practiceArea: PracticeArea; }
export interface DeletePracticeAreaResponse { message: string; }
export interface UpdatePracticeAreaResponse { message: string; }

class PracticeAreaService extends BaseApiService {
  private endpoint(lawFirmId: string, practiceAreaId?: string): string {
    return practiceAreaId
      ? this.url('lawfirms', lawFirmId, 'practice-areas', practiceAreaId)
      : this.url('lawfirms', lawFirmId, 'practice-areas');
  }

  createPracticeArea(lawFirmId: string, name: string): Promise<CreatePracticeAreaResponse> {
    return this.request(this.endpoint(lawFirmId), {
      method: 'POST', body: { name }, errorMessage: 'Failed to create practice area',
    });
  }

  listPracticeAreas(lawFirmId: string): Promise<PracticeAreaListResponse> {
    return this.dedupedGet(this.endpoint(lawFirmId), { errorMessage: 'Failed to list practice areas' });
  }

  deletePracticeArea(lawFirmId: string, practiceAreaId: string): Promise<DeletePracticeAreaResponse> {
    return this.request(this.endpoint(lawFirmId, practiceAreaId), {
      method: 'DELETE', errorMessage: 'Failed to delete practice area',
    });
  }

  updatePracticeArea(lawFirmId: string, practiceAreaId: string, name: string): Promise<UpdatePracticeAreaResponse> {
    return this.request(this.endpoint(lawFirmId, practiceAreaId), {
      method: 'PUT', body: { name }, errorMessage: 'Failed to update practice area',
    });
  }
}

const practiceAreaService = new PracticeAreaService();
export default practiceAreaService;
