export const FORMAT_MAP = {
  pdf: { ext: 'pdf', mime: 'application/pdf' },
  docx: { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  doc: { ext: 'doc', mime: 'application/msword' },
  odt: { ext: 'odt', mime: 'application/vnd.oasis.opendocument.text' },
  rtf: { ext: 'rtf', mime: 'application/rtf' },
  txt: { ext: 'txt', mime: 'text/plain' },
} as const;

export type OutputFormat = keyof typeof FORMAT_MAP;

export function getOutputFormat(value: string): OutputFormat {
  if (value in FORMAT_MAP) return value as OutputFormat;

  const error: any = new Error(
    `Unsupported output format: "${value}". Supported: ${Object.keys(FORMAT_MAP).join(', ')}`,
  );
  error.statusCode = 400;
  throw error;
}

/** The converter could not convert THIS document; retrying the same file will not help. */
export function conversionFailed(): Error {
  const error: any = new Error(
    'This document could not be converted. It may be corrupt, password-protected, or in an unsupported format.',
  );
  error.statusCode = 422;
  error.code = 'CONVERSION_FAILED';
  return error;
}

/** The converter itself is not available right now; the same file may convert later. */
export function conversionUnavailable(): Error {
  const error: any = new Error('Document conversion is temporarily unavailable. Please try again shortly.');
  error.statusCode = 503;
  error.code = 'CONVERSION_UNAVAILABLE';
  return error;
}

/**
 * What the document worker's answer means for the person. The worker answers
 * 422 when LibreOffice fails on the document itself, so that is a failed
 * conversion; anything else is the service being down or erroring.
 */
export function workerConversionError(status: number): Error {
  return status === 422 ? conversionFailed() : conversionUnavailable();
}

export function conversionError(error: any): Error {
  if (error?.statusCode) return error;

  const raw = String(error?.message || '');
  console.error('[document-conversion] adapter failure:', raw);
  return raw.includes('Could not find soffice binary') ? conversionUnavailable() : conversionFailed();
}

/**
 * A URL the document worker may follow: a V4 signed storage URL that expires
 * within two minutes.
 *
 * The worker holds no credentials of its own, so this is its whole boundary.
 * The API mints every URL at 90 seconds; anything else, including a signed URL
 * on another host or one that lives longer, did not come from it.
 */
export function isSignedStorageUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    const expires = url.searchParams.get('X-Goog-Expires');
    return url.protocol === 'https:' && url.hostname === 'storage.googleapis.com' && !!expires && Number(expires) > 0 && Number(expires) <= 120;
  } catch {
    return false;
  }
}
