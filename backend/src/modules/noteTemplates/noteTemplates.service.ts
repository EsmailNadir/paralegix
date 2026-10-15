const noteTemplatesRepo = require('./noteTemplates.repository');
const { sanitizeRichText } = require('../../shared/utils/htmlSanitizer');

/**
 * Save the current note-composer draft as a reusable firm-wide template.
 */
export async function createNoteTemplate({ lawFirmId, userId, body }: any) {
  const result = await noteTemplatesRepo.create(lawFirmId, {
    label: body.label.trim(),
    noteType: body.noteType || 'general',
    subject: body.subject || '',
    contentHtml: sanitizeRichText(body.contentHtml || ''),
    createdBy: userId,
  });

  return { message: 'Note template created successfully', noteTemplate: result };
}

/** List a firm's custom note templates (built-ins are a static frontend list). */
export async function listNoteTemplates({ lawFirmId }: any) {
  const noteTemplates = await noteTemplatesRepo.listOrdered(lawFirmId);
  return { noteTemplates };
}
