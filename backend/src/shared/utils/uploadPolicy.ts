/**
 * Shared upload deny-list policy.
 *
 * Rejects clearly-executable / script file types at upload time (by mimetype OR
 * extension, so lying about one doesn't bypass when the other is dangerous).
 * This is the same policy the firm-side file routes enforce; it is shared so the
 * client portal's message-attachment uploads apply an identical bar. Active
 * content that can be a legitimate document (HTML/SVG/XML) is NOT rejected here
 * but is force-downloaded at read time via `dispositionFor` (attachmentDisposition.js).
 *
 * Native-executable magic-byte sniffing is applied when the raw file buffer is
 * available, so a renamed or mislabeled binary is caught even when the name and
 * mimetype look safe. Full AV / malware scanning is still out of scope (it needs
 * an async scanning pipeline).
 */

export const BLOCKED_UPLOAD_MIME_TYPES = new Set<string>([
  'application/x-msdownload',        // .exe/.dll
  'application/x-msdos-program',
  'application/x-dosexec',
  'application/x-executable',
  'application/vnd.microsoft.portable-executable',
  'application/x-elf',
  'application/x-mach-binary',
  'application/x-sh',
  'application/x-csh',
  'application/x-bat',
  'application/bat',
  'application/x-msi',
  'application/java-archive',        // .jar (runnable)
  'application/x-java-archive',
  'application/x-php',
  'application/x-httpd-php',
  'application/hta',
  'application/x-ms-installer',
]);

export const BLOCKED_UPLOAD_EXTENSIONS = new Set<string>([
  'exe', 'dll', 'com', 'scr', 'msi', 'msp', 'cpl',
  'bat', 'cmd', 'sh', 'bash', 'csh', 'ps1', 'psm1', 'vbs', 'vbe', 'jse',
  'wsf', 'wsh', 'hta', 'jar', 'jnlp', 'php', 'phtml', 'php3', 'php4', 'php5',
  'pht', 'asp', 'aspx', 'jsp', 'app', 'dmg', 'deb', 'rpm',
]);

/**
 * The file metadata and optional leading bytes this policy reads. Direct-upload
 * callers construct this shape after storage admission or a bounded read.
 */
export interface UploadedFile {
  mimetype?: string;
  originalname?: string;
  buffer?: Buffer;
}

/** An Error carrying the HTTP status and code the routes surface for a rejection. */
export interface UploadRejection extends Error {
  status: number;
  code: string;
}

function getExtension(name: unknown): string {
  if (typeof name !== 'string') return '';
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Inspect the leading bytes of an uploaded file and return a human label if they
 * match a known native-executable / bytecode signature, otherwise null. The name
 * and mimetype are client-supplied and trivially faked, but the magic bytes are
 * not, so this catches a renamed or mislabeled binary (e.g. evil.exe sent as
 * "resume.pdf"). Documents and images never begin with these signatures, so
 * there is no practical false-positive risk.
 */
export function findExecutableSignature(buffer: unknown): string | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  const b0 = buffer[0], b1 = buffer[1], b2 = buffer[2], b3 = buffer[3];
  // Windows PE / DOS executable (.exe, .dll, .scr): "MZ"
  if (b0 === 0x4d && b1 === 0x5a) return 'Windows executable';
  // ELF: Linux/Unix executables and shared objects: 0x7F 'E' 'L' 'F'
  if (b0 === 0x7f && b1 === 0x45 && b2 === 0x4c && b3 === 0x46) return 'Linux executable';
  // Mach-O (macOS) thin binaries in either byte order, plus universal/fat
  // binaries which share the CAFEBABE magic with Java class files. All are code.
  const magic = buffer.readUInt32BE(0);
  if (magic === 0xfeedface || magic === 0xfeedfacf
      || magic === 0xcefaedfe || magic === 0xcffaedfe
      || magic === 0xcafebabe) return 'macOS or Java executable';
  return null;
}

/**
 * Returns null if the upload is allowed, or an Error (status 415) to reject it.
 */
export function rejectUploadIfDangerous(file?: UploadedFile | null): UploadRejection | null {
  const mime = String(file?.mimetype || '').toLowerCase().split(';')[0].trim();
  const ext = getExtension(file?.originalname || '');
  if (BLOCKED_UPLOAD_MIME_TYPES.has(mime) || (ext && BLOCKED_UPLOAD_EXTENSIONS.has(ext))) {
    const err = new Error(
      `File type not allowed: "${file?.originalname || 'upload'}" `
      + `(${mime || 'unknown type'}). Executable and script files cannot be uploaded.`,
    ) as UploadRejection;
    err.status = 415;
    err.code = 'FILE_TYPE_NOT_ALLOWED';
    return err;
  }
  // Defense against a faked name/mimetype: reject if the actual bytes are an
  // executable, regardless of what the upload claims to be.
  const signature = findExecutableSignature(file?.buffer);
  if (signature) {
    const err = new Error(
      `File type not allowed: "${file?.originalname || 'upload'}" appears to be a ${signature}. `
      + 'Executable files cannot be uploaded.',
    ) as UploadRejection;
    err.status = 415;
    err.code = 'FILE_TYPE_NOT_ALLOWED';
    return err;
  }
  return null;
}

/** Throws 415 if ANY incoming file is a blocked type. Call before saving. */
export function assertUploadsAllowed(files?: Array<UploadedFile | null | undefined> | null): void {
  for (const f of files || []) {
    const err = rejectUploadIfDangerous(f);
    if (err) throw err;
  }
}
