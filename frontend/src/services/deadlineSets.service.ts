import BaseApiService from './base.service';
import type {
  DeadlineSet,
  CreateDeadlineSetRequest,
  UpdateDeadlineSetRequest,
  ApplyDeadlineSetResponse,
} from '@/types/deadlineSet';

class DeadlineSetsService extends BaseApiService {
  constructor() {
    super('lawfirms');
  }

  private setsUrl(lawFirmId: string, templateId?: string): string {
    return templateId
      ? this.url(lawFirmId, 'deadline-sets', templateId)
      : this.url(lawFirmId, 'deadline-sets');
  }

  list(lawFirmId: string): Promise<{ deadlineSets: DeadlineSet[] }> {
    return this.dedupedGet(this.setsUrl(lawFirmId), { errorMessage: 'Failed to load deadline sets' });
  }

  create(lawFirmId: string, payload: CreateDeadlineSetRequest): Promise<{ message: string; deadlineSetId: string; deadlineSet: DeadlineSet }> {
    return this.request(this.setsUrl(lawFirmId), {
      method: 'POST', body: payload, errorMessage: 'Failed to create deadline set',
    });
  }

  update(lawFirmId: string, templateId: string, payload: UpdateDeadlineSetRequest): Promise<{ message: string; deadlineSet: DeadlineSet }> {
    return this.request(this.setsUrl(lawFirmId, templateId), {
      method: 'PUT', body: payload, errorMessage: 'Failed to update deadline set',
    });
  }

  remove(lawFirmId: string, templateId: string): Promise<{ message: string; deadlineSetId: string }> {
    return this.request(this.setsUrl(lawFirmId, templateId), {
      method: 'DELETE', errorMessage: 'Failed to delete deadline set',
    });
  }

  apply(lawFirmId: string, matterId: string, templateId: string, anchorDate: string): Promise<ApplyDeadlineSetResponse> {
    return this.request(this.url(lawFirmId, 'matters', matterId, 'deadline-sets', templateId, 'apply'), {
      method: 'POST', body: { anchorDate }, errorMessage: 'Failed to apply deadline set',
    });
  }
}

const deadlineSetsService = new DeadlineSetsService();
export default deadlineSetsService;
