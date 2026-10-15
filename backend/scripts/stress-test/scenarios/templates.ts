import { requireOk, StepFailed } from '../client';
import { DOCX_TYPE, SAMPLE_HTML } from '../fixtures';
import type { Vu } from '../vu';

const base = (vu: Vu) => `/api/lawfirms/${vu.lawFirmId}/templates`;

/** Each user owns one DOCX and one HTML template, created on first use. */
export async function ensureTemplates(vu: Vu, docx: Buffer): Promise<void> {
  if (!vu.state.docxTemplateId) {
    const fileName = `stress-${vu.index}.docx`;
    const init = requireOk(
      await vu.api.call('templates.docxInit', 'POST', `${base(vu)}/upload-docx-init`, { fileName, contentType: DOCX_TYPE, size: docx.length }),
      'templates.docxInit',
    );
    requireOk(await vu.api.upload('templates.docxPut', init.uploadUrl, docx, DOCX_TYPE), 'templates.docxPut');
    const created = requireOk(
      await vu.api.call('templates.docxFinalize', 'POST', `${base(vu)}/upload-docx-finalize`, {
        fileName,
        objectPath: init.objectPath,
        name: `Stress letter ${vu.index}`,
      }),
      'templates.docxFinalize',
    );
    vu.state.docxTemplateId = created.templateId;
  }
  if (!vu.state.htmlTemplateId) {
    const created = requireOk(
      await vu.api.call('templates.htmlCreate', 'POST', base(vu), { name: `Stress HTML ${vu.index}`, html: SAMPLE_HTML, fields: [] }),
      'templates.htmlCreate',
    );
    vu.state.htmlTemplateId = created.templateId;
  }
}

/** DOCX fill to PDF: docxtemplater on the API, then LibreOffice on the document worker. */
export async function fillDocxToPdf(vu: Vu): Promise<void> {
  if (!vu.state.docxTemplateId) throw new StepFailed('templates.fillPdf skipped: no DOCX template');
  requireOk(
    await vu.api.call('templates.fillPdf', 'POST', `${base(vu)}/${vu.state.docxTemplateId}/fill`, {
      values: { client_name: 'Stress Client', matter_name: 'Stress Matter' },
      format: 'pdf',
    }),
    'templates.fillPdf',
  );
}

/** HTML export to PDF: Chromium on the document worker. */
export async function exportHtmlPdf(vu: Vu): Promise<void> {
  if (!vu.state.htmlTemplateId) throw new StepFailed('templates.exportPdf skipped: no HTML template');
  requireOk(
    await vu.api.call('templates.exportPdf', 'POST', `${base(vu)}/${vu.state.htmlTemplateId}/export-pdf`, {
      html: SAMPLE_HTML,
      fileName: 'stress.pdf',
    }),
    'templates.exportPdf',
  );
}
