import type { NextFunction, Request, Response } from 'express';

type UploadRequest = Request;

const ALLOWED_CONVERT_MIMETYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.oasis.opendocument.text',
  'application/rtf',
  'text/plain',
  'application/octet-stream',
];

const ALLOWED_OUTPUT_FORMATS = ['pdf', 'docx', 'doc', 'odt', 'rtf', 'txt'];
const ALLOWED_CONVERT_EXTENSIONS = ['.pdf', '.docx', '.doc', '.odt', '.rtf', '.txt'];

// Responds with the standard error envelope plus a top-level `message` field:
// the frontend readers on the convert/upload endpoints read `errorData?.message`
// off the body.
function sendValidationError(req: UploadRequest, res: Response, message: string) {
  return res.status(400).json({
    error: message,
    message,
    code: 'VALIDATION_ERROR',
    requestId: req.id || null,
  });
}

/**
 * Whether a declared name and content type describe something convertible.
 *
 * The input used to arrive as multipart, so this read `req.file`. It does not
 * arrive at all any more: the browser PUTs it straight to storage and the API
 * sees only what the caller DECLARES about it, at two separate steps. Both are
 * reachable on their own, so both check.
 *
 * Either signal is enough, exactly as before: a browser that guessed
 * `application/octet-stream` for a `.docx` is the common case, and so is a name
 * with no extension carrying a correct type.
 */
function describesConvertibleInput(fileName: any, contentType: any) {
  const lowerName = String(fileName || '').toLowerCase();
  return ALLOWED_CONVERT_EXTENSIONS.some((ext) => lowerName.endsWith(ext))
    || ALLOWED_CONVERT_MIMETYPES.includes(String(contentType || ''));
}

const UNSUPPORTED_INPUT = `Unsupported input file. Supported: ${ALLOWED_CONVERT_EXTENSIONS.join(', ')}`;

/**
 * The upload step: refuse a document this endpoint could never convert before
 * a storage session is opened for it.
 *
 * Deliberately no size check here. The byte ceiling belongs to the resumable
 * session `beginDirectUpload` opens, which is what storage itself enforces
 * against what actually lands; a number in a request body is a claim, and
 * checking only the claim would be a cap a caller can simply not make.
 */
export function assertConvertibleUpload(req: UploadRequest, res: Response, next: NextFunction) {
  if (!describesConvertibleInput(req.body?.fileName, req.body?.contentType)) {
    return sendValidationError(req, res, UNSUPPORTED_INPUT);
  }
  next();
}

/**
 * The run step: refuse an output format LibreOffice is not being asked for, and
 * an input the upload step would not have accepted.
 *
 * The format is the target filter handed to the converter, which is why it is an
 * allow-list rather than a sanitize.
 */
export function assertConvertibleRun(req: UploadRequest, res: Response, next: NextFunction) {
  const format = req.body?.format || 'pdf';
  if (!ALLOWED_OUTPUT_FORMATS.includes(format)) {
    return sendValidationError(
      req,
      res,
      `Unsupported format: "${format}". Supported: ${ALLOWED_OUTPUT_FORMATS.join(', ')}`,
    );
  }

  if (!describesConvertibleInput(req.body?.fileName, req.body?.contentType)) {
    return sendValidationError(req, res, UNSUPPORTED_INPUT);
  }

  next();
}
