import { apiFetch } from '@/lib/utils/fetchWithTokenRefresh';
import { REQUEST_TIMEOUT_MS } from '@/lib/constants/requestTimeouts';
import { ApiError, readErrorBody } from '@/lib/utils/apiErrors';
import { uploadResumable } from '@/lib/files/resumableUpload';
import { authenticatedHeaders } from './base.service';
import {
  UNFILLED_FIELDS_HEADER,
  decodeUnfilledFields,
} from '@/lib/wordTemplates/unfilled-fields';
import type {
  BracketEdit,
  LeftoverClientText,
  TemplateFieldProposal,
} from '@/lib/wordTemplates/auto-bracket-types';
import type {
  WordTemplate,
  WordTemplateAsset,
  WordTemplateRepeater,
  WordTemplateWithHtml,
} from '@/types/wordTemplate';

/**
 * The Word-first template library (`/api/lawfirms/:lawFirmId/word-templates`).
 *
 * Its methods keep the `(lawFirmId, ...)` signatures of the service the ported
 * screens were written against, so the editor, the library and the fill form
 * call it the way they always did. JSON answers carry a domain-named key
 * (`{ templates }`, `{ template }`, `{ proposals }`...); fills, previews and
 * exports answer with the file itself. Refusals use the central error body
 * `{ error, code, details }`.
 */

const API_ROOT = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
const BASE = (lawFirmId: string) => `${API_ROOT}/lawfirms/${lawFirmId}/word-templates`;

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * The server's client-details check refused a .docx: it found a firm client's
 * details still in the file (`leftovers` set: ask, and retry with them
 * acknowledged) or it could not check (`leftovers` null: show the message).
 * Either way the caller stops; this is not a storage failure to carry on past.
 */
export class ClientTextCheckError extends Error {
  constructor(
    message: string,
    readonly leftovers: LeftoverClientText[] | null,
  ) {
    super(message);
    this.name = 'ClientTextCheckError';
  }
}

/** A fill returns the document plus the placeholders it could not fill. */
export type FilledTemplate = { blob: Blob; unfilledFields: string[] };

export type WordTemplateSavePayload = {
  name: string;
  html: string;
  fields?: string[];
  repeaters?: WordTemplateRepeater[];
  folderId?: string | null;
};

export type WordTemplateConvertFormat = 'pdf' | 'docx' | 'odt' | 'rtf' | 'txt';

/** Everything the server knows about a matter and client, keyed by vocabulary id. */
export type DocumentContext = {
  values: Record<string, string>;
  repeaterValues: Record<string, Record<string, string>[]>;
  billingIncomplete: boolean;
};

export type CommitRequest = {
  objectPath: string;
  fileName: string;
  name: string;
  edits: BracketEdit[];
  duplicateStrategy?: 'copy' | 'replace';
  acknowledgedLeftovers?: string[];
};

export type CommitResult =
  | { templateId: string }
  | { duplicate: { id: string; name: string } };

type UploadPurpose = 'source' | 'asset' | 'convert';

/** The editor row as the API sends it: nullable where the screens expect optional. */
type EditorTemplateWire = Omit<WordTemplateWithHtml, 'html' | 'docxStoragePath' | 'originalFileName' | 'assets'> & {
  html?: string | null;
  docxStoragePath?: string | null;
  originalFileName?: string | null;
  assets?: Array<Omit<WordTemplateAsset, 'fileName' | 'previewUrl'> & { fileName?: string | null; previewUrl?: string | null }>;
};

async function headers(extra: Record<string, string> = {}) {
  return authenticatedHeaders(extra, { requireToken: true });
}

async function jsonHeaders() {
  return headers({ 'Content-Type': 'application/json' });
}

function toTemplateWithHtml(t: EditorTemplateWire): WordTemplateWithHtml {
  return {
    ...t,
    html: t.html ?? undefined,
    docxStoragePath: t.docxStoragePath ?? undefined,
    originalFileName: t.originalFileName ?? undefined,
    assets: (t.assets ?? []).map((a) => ({
      id: a.id,
      objectPath: a.objectPath,
      mimeType: a.mimeType,
      fileName: a.fileName ?? undefined,
      previewUrl: a.previewUrl ?? undefined,
    })),
  };
}

/** What a refusal carries in `details`: the same-name template, or the client-details check. */
type RefusalDetails = {
  duplicate?: { id: string; name: string };
  clientTextRefused?: boolean;
  leftovers?: LeftoverClientText[];
};

/** The code a same-name save is refused with; the commit turns it into a choice. */
const TEMPLATE_DUPLICATE = 'TEMPLATE_DUPLICATE';

/**
 * A failed answer as an error. A refusal from the client-details check becomes
 * a ClientTextCheckError so the editor does not carry on past it; anything
 * else is an ordinary ApiError with the server's own wording, its `code` and
 * its `details`.
 */
async function failure(res: Response, fallback: string): Promise<Error> {
  const body = await readErrorBody(res);
  const apiError = ApiError.fromResponse(res, body, fallback);
  const details = (apiError.details ?? {}) as RefusalDetails;
  if (details && typeof details === 'object' && details.clientTextRefused) {
    return new ClientTextCheckError(
      apiError.message,
      Array.isArray(details.leftovers) ? details.leftovers : null,
    );
  }
  return apiError;
}

/** Reads a successful JSON answer, or throws the failure. */
async function readData<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) throw await failure(res, fallback);
  return (await res.json().catch(() => ({}))) as T;
}

async function getJson<T>(url: string, fallback: string): Promise<T> {
  const res = await apiFetch(url, { headers: await headers() });
  return readData<T>(res, fallback);
}

async function sendJson<T>(
  url: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body: unknown,
  fallback: string,
  timeoutMs?: number,
): Promise<T> {
  const res = await apiFetch(url, {
    method,
    headers: await jsonHeaders(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  return readData<T>(res, fallback);
}

/** POSTs JSON and returns the file the route answers with. */
async function postForFile(url: string, body: unknown, fallback: string): Promise<Response> {
  const res = await apiFetch(url, {
    method: 'POST',
    headers: await jsonHeaders(),
    body: JSON.stringify(body),
    timeoutMs: REQUEST_TIMEOUT_MS.upload,
  });
  if (!res.ok) throw await failure(res, fallback);
  return res;
}

async function getFile(url: string, fallback: string): Promise<Response> {
  const res = await apiFetch(url, { headers: await headers(), timeoutMs: REQUEST_TIMEOUT_MS.upload });
  if (!res.ok) throw await failure(res, fallback);
  return res;
}

/**
 * Sends a file straight to storage through a direct-upload session the API
 * opens, and returns the object path the follow-up call reads. The bytes never
 * pass through the API.
 */
async function uploadToStorage(lawFirmId: string, file: File, purpose: UploadPurpose): Promise<string> {
  const contentType = file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : DOCX_MIME);
  const opened = await sendJson<{ uploadUrl?: string; objectPath?: string; contentType?: string }>(
    `${BASE(lawFirmId)}/upload-init`,
    'POST',
    { fileName: file.name, contentType, size: file.size, purpose },
    'Failed to open the upload.',
    REQUEST_TIMEOUT_MS.upload,
  );
  if (!opened?.uploadUrl || !opened.objectPath) {
    throw new Error('The server did not open an upload.');
  }
  // The session was opened for the content type the server settled on, and the
  // storage PUT has to send that same one.
  await uploadResumable({ file, sessionUrl: opened.uploadUrl, contentType: opened.contentType || contentType });
  return opened.objectPath;
}

async function filled(res: Response): Promise<FilledTemplate> {
  return {
    blob: await res.blob(),
    unfilledFields: decodeUnfilledFields(res.headers.get(UNFILLED_FIELDS_HEADER)),
  };
}

export const wordTemplatesService = {
  async list(lawFirmId: string): Promise<WordTemplate[]> {
    const body = await getJson<{ templates?: WordTemplate[] }>(BASE(lawFirmId), 'Failed to load templates.');
    return body.templates ?? [];
  },

  async getById(lawFirmId: string, templateId: string): Promise<WordTemplateWithHtml> {
    const body = await getJson<{ template: EditorTemplateWire }>(`${BASE(lawFirmId)}/${templateId}`, 'Failed to load template.');
    return toTemplateWithHtml(body.template);
  },

  /** Fields and repeaters are re-extracted from the HTML on the server, so only the name and HTML are sent. */
  async create(lawFirmId: string, payload: WordTemplateSavePayload): Promise<WordTemplateWithHtml> {
    const body = await sendJson<{ template: EditorTemplateWire }>(
      BASE(lawFirmId), 'POST', { name: payload.name, html: payload.html }, 'Failed to save template.',
    );
    return toTemplateWithHtml(body.template);
  },

  async update(lawFirmId: string, templateId: string, payload: WordTemplateSavePayload): Promise<WordTemplateWithHtml> {
    const body = await sendJson<{ template: EditorTemplateWire }>(
      `${BASE(lawFirmId)}/${templateId}`, 'PUT', { name: payload.name, html: payload.html }, 'Failed to update template.',
    );
    return toTemplateWithHtml(body.template);
  },

  async renameTemplate(lawFirmId: string, templateId: string, name: string): Promise<WordTemplateWithHtml> {
    await sendJson(`${BASE(lawFirmId)}/${templateId}`, 'PATCH', { name }, 'Failed to rename template.');
    return this.getById(lawFirmId, templateId);
  },

  async delete(lawFirmId: string, templateId: string): Promise<void> {
    await sendJson(`${BASE(lawFirmId)}/${templateId}`, 'DELETE', undefined, 'Failed to delete template.');
  },

  /**
   * Uploads a .docx or fillable .pdf and scans it for blanks. Nothing is stored
   * as a template yet: the object path comes back with the proposals so the
   * reviewed edits can be committed against the same bytes.
   */
  async detect(
    lawFirmId: string,
    file: File,
  ): Promise<{ objectPath: string; proposals: TemplateFieldProposal[] }> {
    const objectPath = await uploadToStorage(lawFirmId, file, 'source');
    const scanned = await sendJson<{ proposals?: TemplateFieldProposal[] }>(
      `${BASE(lawFirmId)}/detect`, 'POST', { objectPath, fileName: file.name }, 'Failed to scan the document.',
      REQUEST_TIMEOUT_MS.upload,
    );
    return { objectPath, proposals: scanned?.proposals ?? [] };
  },

  /**
   * Stores the reviewed upload. A template of the same name already on file is
   * not a failure but a choice for the person (Replace, Save as a copy), so the
   * server's same-name refusal comes back as `{ duplicate }`.
   */
  async commit(lawFirmId: string, request: CommitRequest): Promise<CommitResult> {
    try {
      const body = await sendJson<{ templateId: string }>(
        `${BASE(lawFirmId)}/commit`, 'POST', request, 'Failed to save template.', REQUEST_TIMEOUT_MS.upload,
      );
      return { templateId: body.templateId };
    } catch (error) {
      if (error instanceof ApiError && error.code === TEMPLATE_DUPLICATE) {
        const duplicate = (error.details as RefusalDetails | undefined)?.duplicate;
        if (duplicate) return { duplicate };
      }
      throw error;
    }
  },

  /** The editor's no-review path: stores a .docx as a Word template and loads it. */
  async uploadDocxTemplate(
    lawFirmId: string,
    file: File,
    name: string,
    options: { folderId?: string | null; acknowledgedLeftovers?: string[] } = {},
  ): Promise<WordTemplateWithHtml> {
    const objectPath = await uploadToStorage(lawFirmId, file, 'source');
    const created = await sendJson<{ templateId: string }>(
      `${BASE(lawFirmId)}/upload-docx`,
      'POST',
      {
        objectPath,
        fileName: file.name,
        name,
        ...(options.acknowledgedLeftovers ? { acknowledgedLeftovers: options.acknowledgedLeftovers } : {}),
      },
      'Failed to upload DOCX template.',
      REQUEST_TIMEOUT_MS.upload,
    );
    return this.getById(lawFirmId, created.templateId);
  },

  /** Replaces a Word template's stored .docx in place and re-reads its placeholders. */
  async replaceDocx(
    lawFirmId: string,
    templateId: string,
    file: File,
    acknowledgedLeftovers?: string[],
  ): Promise<WordTemplateWithHtml> {
    const objectPath = await uploadToStorage(lawFirmId, file, 'source');
    await sendJson(
      `${BASE(lawFirmId)}/${templateId}/replace-source`,
      'POST',
      { objectPath, fileName: file.name, ...(acknowledgedLeftovers ? { acknowledgedLeftovers } : {}) },
      'Failed to replace the document.',
      REQUEST_TIMEOUT_MS.upload,
    );
    return this.getById(lawFirmId, templateId);
  },

  /**
   * The fields actually inside a Word template's stored file, which the fill
   * form trusts over the row's own copy. Null when the server has none to give.
   */
  async fetchFillFields(
    lawFirmId: string,
    templateId: string,
  ): Promise<{ fields: string[]; repeaters: WordTemplateRepeater[] } | null> {
    const body = await getJson<{ fillFields?: { fields: string[]; repeaters: WordTemplateRepeater[] } | null }>(
      `${BASE(lawFirmId)}/${templateId}/fields`, 'Failed to read the template fields.',
    );
    return body.fillFields ?? null;
  },

  /** The matter and client context autofill reads from. Null when neither is picked. */
  async documentContext(
    lawFirmId: string,
    { matterId, clientId }: { matterId: string | null; clientId: string | null },
  ): Promise<DocumentContext | null> {
    if (!matterId && !clientId) return null;
    const query = new URLSearchParams();
    if (matterId) query.set('matterId', matterId);
    if (clientId) query.set('clientId', clientId);
    const body = await getJson<{ context?: DocumentContext | null }>(
      `${BASE(lawFirmId)}/document-context?${query.toString()}`, "Couldn't load this matter's details.",
    );
    return body.context ?? null;
  },

  async fillDocxTemplate(
    lawFirmId: string,
    templateId: string,
    values: Record<string, string>,
    repeaterValues: Record<string, Array<Record<string, string>>>,
    format: WordTemplateConvertFormat = 'pdf',
    fileName?: string,
  ): Promise<FilledTemplate> {
    if (format !== 'docx' && format !== 'pdf') {
      throw new Error(`A Word template can be downloaded as DOCX or PDF, not ${format.toUpperCase()}.`);
    }
    const res = await postForFile(
      `${BASE(lawFirmId)}/${templateId}/fill-docx`,
      { values, repeaterValues, fileName, format },
      'Failed to fill template.',
    );
    return filled(res);
  },

  /** Fills a fillable PDF's own form fields in place and flattens them. */
  async fillPdfFormTemplate(
    lawFirmId: string,
    templateId: string,
    values: Record<string, string>,
    fileName?: string,
  ): Promise<FilledTemplate> {
    const res = await postForFile(
      `${BASE(lawFirmId)}/${templateId}/fill-pdf`,
      { values, ...(fileName ? { fileName } : {}) },
      'Failed to fill template.',
    );
    return filled(res);
  },

  /** Renders filled HTML to a downloadable file. */
  async exportHtml(lawFirmId: string, html: string, format: 'pdf' | 'docx' | 'txt'): Promise<Blob> {
    const res = await postForFile(`${BASE(lawFirmId)}/export`, { html, format }, 'Export failed.');
    return res.blob();
  },

  /** A Word template's stored .docx, for the in-browser preview. */
  async docxSource(lawFirmId: string, templateId: string): Promise<ArrayBuffer> {
    const res = await getFile(`${BASE(lawFirmId)}/${templateId}/docx-source`, "Couldn't load the document.");
    return res.arrayBuffer();
  },

  /** A Word template converted to PDF, for previewing it as it prints. */
  async previewPdf(lawFirmId: string, templateId: string): Promise<Blob> {
    const res = await getFile(`${BASE(lawFirmId)}/${templateId}/preview-pdf`, 'Failed to open template preview.');
    return res.blob();
  },

  /** Converts a .docx to PDF on the server, for the editor to rebuild as HTML. */
  async convertToPdf(lawFirmId: string, file: File): Promise<File> {
    const objectPath = await uploadToStorage(lawFirmId, file, 'convert');
    const res = await postForFile(
      `${BASE(lawFirmId)}/convert-docx-to-pdf`, { objectPath, fileName: file.name }, 'Failed to convert document to PDF.',
    );
    const blob = await res.blob();
    const pdfName = file.name.replace(/\.[^.]+$/, '') + '.pdf';
    return new File([blob], pdfName, { type: 'application/pdf' });
  },
};
