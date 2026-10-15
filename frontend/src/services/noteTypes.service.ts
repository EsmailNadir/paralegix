import BaseApiService from './base.service';
import type { NoteTypeOption } from '@/types';

export interface NoteTypeListResponse { noteTypes: NoteTypeOption[]; }
export interface CreateNoteTypeResponse { message: string; noteType: NoteTypeOption; }
export interface UpdateNoteTypeColorResponse { message: string; noteType: NoteTypeOption; }

class NoteTypesService extends BaseApiService {
  private endpoint(lawFirmId: string): string {
    return this.url('lawfirms', lawFirmId, 'note-types');
  }

  listNoteTypes(lawFirmId: string): Promise<NoteTypeListResponse> {
    return this.dedupedGet(this.endpoint(lawFirmId), { errorMessage: 'Failed to list note types' });
  }

  createNoteType(lawFirmId: string, label: string): Promise<CreateNoteTypeResponse> {
    return this.request(this.endpoint(lawFirmId), {
      method: 'POST', body: { label }, errorMessage: 'Failed to create note type',
    });
  }

  /** `value` may be a firm-custom type's slug or a built-in type's slug. */
  updateNoteTypeColor(lawFirmId: string, value: string, color: string): Promise<UpdateNoteTypeColorResponse> {
    return this.request(`${this.endpoint(lawFirmId)}/${encodeURIComponent(value)}/color`, {
      method: 'PATCH', body: { color }, errorMessage: 'Failed to update note type color',
    });
  }
}

const noteTypesService = new NoteTypesService();
export default noteTypesService;
