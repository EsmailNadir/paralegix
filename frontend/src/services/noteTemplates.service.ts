import BaseApiService from './base.service';
import type { NoteTemplateOption } from '@/types';

export interface NoteTemplateListResponse { noteTemplates: NoteTemplateOption[]; }
export interface CreateNoteTemplateResponse { message: string; noteTemplate: NoteTemplateOption; }

export interface CreateNoteTemplateInput {
  label: string;
  noteType?: string;
  subject?: string;
  contentHtml?: string;
}

class NoteTemplatesService extends BaseApiService {
  private endpoint(lawFirmId: string): string {
    return this.url('lawfirms', lawFirmId, 'note-templates');
  }

  listNoteTemplates(lawFirmId: string): Promise<NoteTemplateListResponse> {
    return this.dedupedGet(this.endpoint(lawFirmId), { errorMessage: 'Failed to list note templates' });
  }

  createNoteTemplate(lawFirmId: string, input: CreateNoteTemplateInput): Promise<CreateNoteTemplateResponse> {
    return this.request(this.endpoint(lawFirmId), {
      method: 'POST', body: input, errorMessage: 'Failed to create note template',
    });
  }
}

const noteTemplatesService = new NoteTemplatesService();
export default noteTemplatesService;
