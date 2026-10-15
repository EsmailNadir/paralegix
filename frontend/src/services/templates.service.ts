import { apiFetch, publicFetch } from '@/lib/utils/fetchWithTokenRefresh';
import { REQUEST_TIMEOUT_MS } from '@/lib/constants/requestTimeouts';
import { toApiError, ApiError } from '@/lib/utils/apiErrors';
import { retryWhileBusy } from '@/lib/utils/busyRetry';
import requestDeduplicator from './requestDeduplicator';
import { authenticatedHeaders } from './base.service';
import signaturesService from '@/services/signatures.service';
import { uploadResumable, UploadCancelledError } from '@/lib/files/resumableUpload';
import type {
  Template,
  TemplateWithHtml,
  TemplateFolder,
  TemplateRepeater,
  TemplateFieldPlacement,
  TemplateFieldPlacementInput,
  TemplateOverlayRepeaterInput,
} from '@/types/template';

const API_ROOT = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
const BASE = (lawFirmId: string) =>
  `${API_ROOT}/lawfirms/${lawFirmId}/templates`;

function toPdfFileName(name: string): string {
  return /\.[^.]+$/.test(name) ? name.replace(/\.[^.]+$/, '.pdf') : `${name}.pdf`;
}

function toConvertedFileName(name: string, ext: string): string {
  return /\.[^.]+$/.test(name) ? name.replace(/\.[^.]+$/, `.${ext}`) : `${name}.${ext}`;
}

/**
 * What the person is told when an exported PDF had to go without some template
 * images. The PDF is still produced; this is the only place they learn it is
 * incomplete before they read it.
 */
export function skippedImagesNotice(count: number): string {
  return count === 1
    ? "The PDF was created, but 1 image couldn't be included. It may be too large or no longer available."
    : `The PDF was created, but ${count} images couldn't be included. They may be too large or no longer available.`;
}

/**
 * What the person is told when a filled overlay document has fields whose
 * text did not fully print. The stamp falls back to a bundled font for most
 * names, but none of them has CJK, Hebrew or Arabic, so those characters
 * come out as "?" in an otherwise complete document.
 */
export function incompleteFieldsNotice(fields: TemplateIncompleteField[]): string {
  const names = fields.map((field) => `{${field.fieldName}}`);
  const list = names.length > 1
    ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
    : names[0];
  return `The document was created, but some characters in ${list} couldn't be printed and show as "?". Check them before you send it.`;
}

/** A field whose filled text did not fully print, as a fill reports it. */
export interface TemplateIncompleteField {
  fieldName: string;
  /** The characters no font could draw; empty when the box could not be drawn at all. */
  characters: string[];
}

/**
 * What a render endpoint answers with: where the document is, and what it is.
 *
 * `url` is a storage link with a lifetime, so it is used and not stored. The
 * rest is what a caller needs without reading a byte of the document.
 */
export interface TemplateRenderLink {
  url: string;
  fileName?: string;
  contentType?: string;
  sizeBytes?: number;
  generation?: string;
  urlExpiresAt?: string;
  disposition?: 'inline' | 'attachment';
  /** Only a stamped fill reports these; see incompleteFieldsNotice. */
  incompleteFields?: TemplateIncompleteField[];
}

async function authHeaders(extra: Record<string, string> = {}) {
  return authenticatedHeaders({ 'Content-Type': 'application/json', ...extra }, { requireToken: true });
}

export const templatesService = {
  async list(lawFirmId: string): Promise<Template[]> {
    const headers = await authHeaders();
    return requestDeduplicator.execute<{ templates: Template[] }>(BASE(lawFirmId), { headers }).then(
      res => res.templates
    );
  },

  async create(
    lawFirmId: string,
    payload: { name: string; html: string; fields: string[]; repeaters?: TemplateRepeater[]; folderId?: string | null }
  ): Promise<TemplateWithHtml> {
    const res = await apiFetch(BASE(lawFirmId), {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({})) as { template: TemplateWithHtml };
    if (!res.ok) throw ApiError.fromResponse(res, body, 'Failed to save template.');
    return body.template;
  },

  async getById(lawFirmId: string, templateId: string): Promise<TemplateWithHtml> {
    const res = await apiFetch(`${BASE(lawFirmId)}/${templateId}`, {
      headers: await authHeaders(),
    });
    const body = await res.json().catch(() => ({})) as { template: TemplateWithHtml };
    if (!res.ok) throw ApiError.fromResponse(res, body, 'Failed to load template.');
    return body.template;
  },

  async update(
    lawFirmId: string,
    templateId: string,
    payload: { name: string; html: string; fields: string[]; repeaters?: TemplateRepeater[]; folderId?: string | null }
  ): Promise<TemplateWithHtml> {
    const res = await apiFetch(`${BASE(lawFirmId)}/${templateId}`, {
      method: 'PUT',
      headers: await authHeaders(),
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({})) as { template: TemplateWithHtml };
    if (!res.ok) throw ApiError.fromResponse(res, body, 'Failed to update template.');
    return body.template;
  },

  /**
   * A link to the PDF a DOCX / Document Overlay template is previewed from.
   * HTML templates are previewed from the HTML `getById` already returns.
   *
   * A LINK, not the bytes. The route used to answer with the document, so the
   * API instance held the whole render while writing it out and the tab then
   * held a second copy as a Blob. Now storage serves it, which is also what
   * lets `PdfPreview` read page ranges instead of the whole file.
   */
  async previewPdf(lawFirmId: string, templateId: string): Promise<TemplateRenderLink> {
    // Sent again while the converter or render queue is full, which the server
    // says before starting anything (`retryWhileBusy`).
    const body = await retryWhileBusy(async () => {
      const res = await apiFetch(`${BASE(lawFirmId)}/${templateId}/preview`, {
        headers: await authHeaders(),
        // A DOCX template is converted to PDF on the way out, so this is paced by
        // LibreOffice rather than by a query.
        timeoutMs: REQUEST_TIMEOUT_MS.upload,
      });
      if (!res.ok) {
        throw await toApiError(res, 'Failed to open template preview.');
      }
      return await res.json().catch(() => ({})) as
        { previewUrl?: string } & Omit<TemplateRenderLink, 'url'>;
    });
    if (!body.previewUrl) {
      throw new Error('The server did not return a preview link.');
    }
    const { previewUrl, ...rest } = body;
    return { url: previewUrl, ...rest };
  },

  async delete(lawFirmId: string, templateId: string): Promise<void> {
    const res = await apiFetch(`${BASE(lawFirmId)}/${templateId}`, {
      method: 'DELETE',
      headers: await authHeaders(),
    });
    if (!res.ok) {
      throw await toApiError(res, 'Failed to delete template.');
    }
  },

  // --- Folder methods ---

  async listFolders(lawFirmId: string): Promise<TemplateFolder[]> {
    const headers = await authHeaders();
    return requestDeduplicator
      .execute<{ folders: TemplateFolder[] }>(`${BASE(lawFirmId)}/folders`, { headers })
      .then(res => res.folders);
  },

  async createFolder(
    lawFirmId: string,
    payload: { name: string; color?: string | null; parentFolderId?: string | null }
  ): Promise<TemplateFolder> {
    const res = await apiFetch(`${BASE(lawFirmId)}/folders`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({})) as { folder: TemplateFolder };
    if (!res.ok) throw ApiError.fromResponse(res, body, 'Failed to create folder.');
    return body.folder;
  },

  async updateFolder(
    lawFirmId: string,
    folderId: string,
    payload: { name?: string; color?: string | null; parentFolderId?: string | null }
  ): Promise<TemplateFolder> {
    const res = await apiFetch(`${BASE(lawFirmId)}/folders/${folderId}`, {
      method: 'PUT',
      headers: await authHeaders(),
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({})) as { folder: TemplateFolder };
    if (!res.ok) throw ApiError.fromResponse(res, body, 'Failed to update folder.');
    return body.folder;
  },

  async deleteFolder(lawFirmId: string, folderId: string): Promise<void> {
    const res = await apiFetch(`${BASE(lawFirmId)}/folders/${folderId}`, {
      method: 'DELETE',
      headers: await authHeaders(),
    });
    if (!res.ok) {
      throw await toApiError(res, 'Failed to delete folder.');
    }
  },

  async renameTemplate(
    lawFirmId: string,
    templateId: string,
    name: string
  ): Promise<void> {
    const res = await apiFetch(`${BASE(lawFirmId)}/${templateId}`, {
      method: 'PUT',
      headers: await authHeaders(),
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      throw await toApiError(res, 'Failed to rename template.');
    }
  },

  async moveTemplateToFolder(
    lawFirmId: string,
    templateId: string,
    folderId: string | null
  ): Promise<void> {
    const res = await apiFetch(`${BASE(lawFirmId)}/${templateId}`, {
      method: 'PUT',
      headers: await authHeaders(),
      body: JSON.stringify({ folderId }),
    });
    if (!res.ok) {
      throw await toApiError(res, 'Failed to move template.');
    }
  },

  async convertToPdf(file: File): Promise<File> {
    return this.convertToFormat(file, 'pdf', 'application/pdf');
  },

  /**
   * Convert a document through the firm-side conversion endpoint.
   *
   * Delegates to `signatures.service`, which owns the three-step shape: the
   * browser PUTs to storage, the worker converts storage to storage, and the
   * browser fetches the result. Conversion used to be one multipart POST that
   * answered with the bytes, so both directions passed through a container
   * serving many callers at once.
   */
  async convertToFormat(
    file: File,
    format: 'pdf' | 'docx' | 'odt' | 'rtf' | 'txt',
    mimeType?: string
  ): Promise<File> {
    const converted = await signaturesService.convertDocument(file, format, file.name);

    const outputType = mimeType
      ?? ({
        pdf: 'application/pdf',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        odt: 'application/vnd.oasis.opendocument.text',
        rtf: 'application/rtf',
        txt: 'text/plain',
      }[format]);
    return new File(
      [converted],
      format === 'pdf' ? toPdfFileName(file.name) : toConvertedFileName(file.name, format),
      { type: outputType },
    );
  },

  // --- DOCX template methods ---

  async uploadDocxTemplate(
    lawFirmId: string,
    file: File,
    name: string,
    options: {
      folderId?: string | null;
      html?: string;
      /**
       * Stops the upload. Finalize is what creates the template row, so a
       * cancel is checked after the transfer and never reaches it. Rejects with
       * `UploadCancelledError`.
       */
      signal?: AbortSignal;
    } = {}
  ): Promise<TemplateWithHtml> {
    const { signal } = options;
    if (signal?.aborted) throw new UploadCancelledError();

    try {
      const init = await apiFetch(`${BASE(lawFirmId)}/upload-docx-init`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({
          fileName: file.name,
          contentType: file.type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size: file.size,
        }),
        signal,
        timeoutMs: REQUEST_TIMEOUT_MS.upload,
      });
      const opened = await init.json().catch(() => ({})) as { uploadUrl?: string; objectPath?: string; error?: string };
      if (!init.ok || !opened.uploadUrl || !opened.objectPath) {
        throw ApiError.fromResponse(init, opened, 'Failed to open the DOCX upload.');
      }
      if (signal?.aborted) throw new UploadCancelledError();

      await uploadResumable({
        file,
        sessionUrl: opened.uploadUrl,
        contentType: file.type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        signal,
      });

      // The last chunk can land in the same moment the user cancels, and then
      // the transfer resolves normally. Finalize would still file the template.
      if (signal?.aborted) throw new UploadCancelledError();

      const res = await apiFetch(`${BASE(lawFirmId)}/upload-docx-finalize`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({
          objectPath: opened.objectPath,
          fileName: file.name,
          name,
          ...(options.folderId ? { folderId: options.folderId } : {}),
          ...(options.html !== undefined ? { html: options.html } : {}),
        }),
        signal,
        timeoutMs: REQUEST_TIMEOUT_MS.upload,
      });
      const body = await res.json().catch(() => ({})) as { template: TemplateWithHtml; message?: string; error?: string };
      if (!res.ok) throw ApiError.fromResponse(res, body, 'Failed to upload DOCX template.');
      return body.template;
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new UploadCancelledError();
      }
      throw error;
    }
  },

  async reuploadDocxTemplate(
    lawFirmId: string,
    templateId: string,
    file: File,
    options: { name?: string; html?: string } = {}
  ): Promise<TemplateWithHtml> {
    const init = await apiFetch(`${BASE(lawFirmId)}/${templateId}/upload-docx-init`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ fileName: file.name, contentType: file.type, size: file.size }),
      timeoutMs: REQUEST_TIMEOUT_MS.upload,
    });
    const opened = await init.json().catch(() => ({})) as { uploadUrl?: string; objectPath?: string; error?: string };
    if (!init.ok || !opened.uploadUrl || !opened.objectPath) {
      throw ApiError.fromResponse(init, opened, 'Failed to open the DOCX upload.');
    }
    await uploadResumable({ file, sessionUrl: opened.uploadUrl, contentType: file.type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    const res = await apiFetch(`${BASE(lawFirmId)}/${templateId}/upload-docx-finalize`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ objectPath: opened.objectPath, fileName: file.name, ...(options.name ? { name: options.name } : {}), ...(options.html !== undefined ? { html: options.html } : {}) }),
      timeoutMs: REQUEST_TIMEOUT_MS.upload,
    });
    const body = await res.json().catch(() => ({})) as { template: TemplateWithHtml; message?: string; error?: string };
    if (!res.ok) throw ApiError.fromResponse(res, body, 'Failed to update DOCX template.');
    return body.template;
  },

  // --- Document Overlay template methods ---

  async uploadOverlay(
    lawFirmId: string,
    file: File,
    name?: string,
    folderId?: string | null,
    options?: {
      onProgress?: (progress: number) => void;
      signal?: AbortSignal;
    }
  ): Promise<{ templateId: string; template: TemplateWithHtml }> {
    const signal = options?.signal;
    if (signal?.aborted) throw new UploadCancelledError();

    try {
      const init = await apiFetch(`${BASE(lawFirmId)}/upload-overlay-init`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({
          fileName: file.name,
          contentType: file.type || 'application/octet-stream',
          size: file.size,
        }),
        signal,
        timeoutMs: REQUEST_TIMEOUT_MS.upload,
      });
      if (signal?.aborted) throw new UploadCancelledError();
      const opened = await init.json().catch(() => ({})) as { uploadUrl?: string; objectPath?: string; error?: string };
      if (!init.ok || !opened.uploadUrl || !opened.objectPath) {
        throw ApiError.fromResponse(init, opened, 'Failed to open the document upload.');
      }

      if (signal?.aborted) throw new UploadCancelledError();

      await uploadResumable({
        file,
        sessionUrl: opened.uploadUrl,
        contentType: file.type || 'application/octet-stream',
        onBytes: (persisted) => {
          if (file.size > 0 && options?.onProgress) {
            const pct = Math.min(99, Math.max(0, Math.round((persisted / file.size) * 100)));
            options.onProgress(pct);
          }
        },
        signal,
      });

      if (signal?.aborted) throw new UploadCancelledError();

      // A non-PDF is converted while finalizing. A full converter refuses as
      // busy and the server keeps the uploaded source for exactly that case, so
      // only this call is sent again; the bytes are not uploaded twice.
      const body = await retryWhileBusy(async () => {
        const res = await apiFetch(`${BASE(lawFirmId)}/upload-overlay-finalize`, {
          method: 'POST',
          headers: await authHeaders(),
          body: JSON.stringify({
            objectPath: opened.objectPath,
            fileName: file.name,
            ...(name ? { name } : {}),
            ...(folderId ? { folderId } : {}),
          }),
          signal,
          timeoutMs: REQUEST_TIMEOUT_MS.upload,
        });
        if (signal?.aborted) throw new UploadCancelledError();
        const parsed = await res.json().catch(() => ({})) as { templateId: string; template: TemplateWithHtml; message?: string; error?: string };
        if (!res.ok) throw ApiError.fromResponse(res, parsed, 'Failed to upload document.');
        return parsed;
      }, { signal });
      if (options?.onProgress) options.onProgress(100);
      return { templateId: body.templateId, template: body.template };
    } catch (error) {
      if (
        signal?.aborted ||
        (error instanceof Error && error.name === 'AbortError') ||
        error instanceof UploadCancelledError
      ) {
        throw new UploadCancelledError();
      }
      throw error;
    }
  },

  async listPlacements(lawFirmId: string, templateId: string): Promise<TemplateFieldPlacement[]> {
    const headers = await authHeaders();
    return requestDeduplicator
      .execute<{ placements: TemplateFieldPlacement[] }>(`${BASE(lawFirmId)}/${templateId}/placements`, { headers })
      .then(res => res.placements);
  },

  async savePlacements(
    lawFirmId: string,
    templateId: string,
    payload: { placements: TemplateFieldPlacementInput[]; repeaters: TemplateOverlayRepeaterInput[] }
  ): Promise<{ placements: TemplateFieldPlacement[]; repeaters: TemplateRepeater[]; fields?: string[] }> {
    const res = await apiFetch(`${BASE(lawFirmId)}/${templateId}/placements`, {
      method: 'PUT',
      headers: await authHeaders(),
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({})) as { placements: TemplateFieldPlacement[]; repeaters: TemplateRepeater[]; fields?: string[]; message?: string; error?: string };
    if (!res.ok) throw ApiError.fromResponse(res, body, 'Failed to save field placements.');
    return { placements: body.placements, repeaters: body.repeaters, fields: body.fields };
  },

  /** Uploads one image for an 'image'-type overlay placement. Uploading alone
   *  doesn't attach it to anything: the returned imageObjectPath still has to
   *  be included on that placement in the next `savePlacements` call. */
  async uploadPlacementImage(
    lawFirmId: string,
    templateId: string,
    file: File
  ): Promise<{ imageObjectPath: string; imageMimeType: string; imagePreviewUrl: string | null }> {
    const init = await apiFetch(`${BASE(lawFirmId)}/${templateId}/placement-images-init`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ fileName: file.name, contentType: file.type, size: file.size }),
      timeoutMs: REQUEST_TIMEOUT_MS.upload,
    });
    const opened = await init.json().catch(() => ({})) as { uploadUrl?: string; objectPath?: string; error?: string };
    if (!init.ok || !opened.uploadUrl || !opened.objectPath) {
      throw ApiError.fromResponse(init, opened, 'Failed to open the image upload.');
    }
    await uploadResumable({ file, sessionUrl: opened.uploadUrl, contentType: file.type });

    const res = await apiFetch(`${BASE(lawFirmId)}/${templateId}/placement-images-finalize`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ objectPath: opened.objectPath, fileName: file.name }),
      timeoutMs: REQUEST_TIMEOUT_MS.upload,
    });
    const body = await res.json().catch(() => ({})) as {
      imageObjectPath: string; imageMimeType: string; imagePreviewUrl: string | null; message?: string; error?: string;
    };
    if (!res.ok) throw ApiError.fromResponse(res, body, 'Failed to upload image.');
    return { imageObjectPath: body.imageObjectPath, imageMimeType: body.imageMimeType, imagePreviewUrl: body.imagePreviewUrl };
  },

  /**
   * Fill a DOCX / Document Overlay template and get a link to the result.
   *
   * `disposition` is the difference between the two things a caller does with
   * the render. `attachment` saves it, which is Download. `inline` shows it,
   * which is Preview: the same link with `attachment` would download the file
   * instead of displaying it in the tab that was opened for it.
   */
  async fillDocxTemplate(
    lawFirmId: string,
    templateId: string,
    values: Record<string, string>,
    repeaterValues: Record<string, Record<string, string>[]>,
    format: 'pdf' | 'docx' | 'odt' | 'rtf' | 'txt' = 'pdf',
    fileName?: string,
    disposition: 'inline' | 'attachment' = 'attachment'
  ): Promise<TemplateRenderLink> {
    // Sent again while the render queue is full, which the server says before
    // starting anything (`retryWhileBusy`).
    const body = await retryWhileBusy(async () => {
      const res = await apiFetch(`${BASE(lawFirmId)}/${templateId}/fill`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ values, repeaterValues, format, fileName, disposition }),
        // The fill itself runs LibreOffice or pdf-lib before it can answer, so
        // this is paced by the render and not by a query.
        timeoutMs: REQUEST_TIMEOUT_MS.upload,
      });
      if (!res.ok) {
        throw await toApiError(res, 'Failed to fill template.');
      }
      return await res.json().catch(() => ({})) as
        { downloadUrl?: string } & Omit<TemplateRenderLink, 'url'>;
    });
    if (!body.downloadUrl) {
      throw new Error('The server did not return a link to the filled template.');
    }
    const { downloadUrl, ...rest } = body;
    return { url: downloadUrl, ...rest };
  },

  /**
   * Render filled template HTML to a PDF.
   *
   * The API renders it with Chromium on the document worker and answers with a
   * storage link, which is read here because every caller needs the bytes: to
   * download, to save to files, or to convert to another format. `publicFetch`
   * rather than `apiFetch`: the signed link IS the authorization, and the
   * user's bearer token has no business going to the storage host.
   *
   * `skippedImages` counts template images the PDF had to go without; the
   * caller tells the person (`skippedImagesNotice`).
   */
  async renderPdf(
    lawFirmId: string,
    templateId: string,
    html: string,
    options: { fileName?: string; signal?: AbortSignal } = {}
  ): Promise<{ blob: Blob; skippedImages: number }> {
    // Sent again while the render queue is full, which the server says before
    // starting anything (`retryWhileBusy`).
    const body = await retryWhileBusy(async () => {
      const res = await apiFetch(`${BASE(lawFirmId)}/${templateId}/export-pdf`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ html, fileName: options.fileName, disposition: 'attachment' }),
        signal: options.signal,
        // Paced by a browser starting and printing on the worker, not by a query.
        timeoutMs: REQUEST_TIMEOUT_MS.upload,
      });
      if (!res.ok) {
        throw await toApiError(res, 'Failed to export the PDF.');
      }
      return await res.json().catch(() => ({})) as { downloadUrl?: string; skippedImages?: number };
    }, { signal: options.signal });
    if (!body.downloadUrl) {
      throw new Error('The server did not return a link to the PDF.');
    }
    const pdf = await publicFetch(body.downloadUrl, { timeoutMs: REQUEST_TIMEOUT_MS.upload, signal: options.signal });
    if (!pdf.ok) throw new Error('Failed to download the exported PDF.');
    return { blob: await pdf.blob(), skippedImages: Number(body.skippedImages) || 0 };
  },
};
