/**
 * Preserved copies of invoices as they were actually sent to a client.
 *
 * An invoice PDF is rendered from whatever the invoice says right now. That is
 * the right behaviour for looking at an invoice: it should show the payments
 * received, the credit notes issued, the adjustments applied. What it cannot
 * answer is the other question, the one that matters in a fee dispute or a bar
 * complaint: what did the client actually receive on the day we billed them?
 *
 * Nothing preserved that. The firm's browser rendered a PDF, posted it to the
 * server to be attached to an email, and the server threw the bytes away the
 * moment the mail went out. Meanwhile the invoice stayed editable (its number,
 * date and due date can all be changed afterwards, and late fees, credit notes,
 * write-offs and payments all move the money), so a reprint months later can
 * legitimately differ from the document sitting in the client's inbox with no
 * record of the difference.
 *
 * Every send now keeps its attachment, filed by the moment it went out, so an
 * invoice sent three times has all three. They live under the firm's
 * `invoices/{invoiceId}/` archive: see shared/storage/recordArchive for why that
 * placement is protected and how it stays out of the firm's quota.
 */

const {
  archivePath,
  archivePrefix,
  putArtifact,
  getArtifact,
  listArtifacts,
  statArtifact,
  signArtifact,
} = require('../../../shared/storage/recordArchive');

const SEGMENT = 'invoices';

/**
 * File name for a copy sent at `sentAt`.
 *
 * The timestamp is in the name rather than only in object metadata so the send
 * history survives as readable filenames, and so two sends can never collide.
 * Colons are not usable in an object name, hence the flattened ISO form.
 */
export function sentCopyName(sentAt: any) {
  const stamp = new Date(sentAt).toISOString().replace(/[:.]/g, '-');
  return `sent-${stamp}.pdf`;
}

export function invoiceArchivePrefix(lawFirmId: string, invoiceId: string) {
  return archivePrefix(lawFirmId, SEGMENT, invoiceId);
}

export function invoiceArchivePath(lawFirmId: string, invoiceId: string, name: any) {
  return archivePath(lawFirmId, SEGMENT, invoiceId, name);
}

/**
 * Keep the copy that was just emailed. Best-effort: the mail has already gone
 * out, so failing the caller here would report a storage problem by making a
 * successful send look failed.
 *
 * Returns the artifact name when stored, or null when there was nothing to store
 * (a send with no attachment, e.g. a reminder rather than the invoice itself).
 */
export async function archiveSentCopy({ lawFirmId, invoiceId, pdfBuffer, sentAt, recipientEmail, sentBy }: any) {
  if (!lawFirmId || !invoiceId || !pdfBuffer?.length) return null;
  const name = sentCopyName(sentAt || new Date());
  const stored = await putArtifact(invoiceArchivePath(lawFirmId, invoiceId, name), pdfBuffer, {
    invoiceId,
    sentTo: recipientEmail || '',
    sentBy: sentBy || '',
  });
  return stored ? name : null;
}

/** Every preserved copy of one invoice, oldest send first. */
export async function listSentCopies(lawFirmId: string, invoiceId: string) {
  if (!lawFirmId || !invoiceId) return [];
  const copies = await listArtifacts(invoiceArchivePrefix(lawFirmId, invoiceId));
  return copies.map((copy: any) => ({
    name: copy.name,
    sizeBytes: copy.sizeBytes,
    sentAt: copy.createdAt,
  }));
}

/**
 * One preserved copy's bytes.
 *
 * The name is confined to the invoice's own prefix and rejected if it tries to
 * escape it, so a caller cannot read another record's artifacts by passing a
 * traversing name.
 */
export async function getSentCopy(lawFirmId: string, invoiceId: string, name: any) {
  const objectPath = sentCopyPath(lawFirmId, invoiceId, name);
  if (!objectPath) return null;
  return getArtifact(objectPath);
}

/**
 * The object path of one preserved copy, or null when the name is not one.
 *
 * Split out from `getSentCopy` so a caller that wants to hand the browser a
 * signed url does not have to read the bytes to find out where they are. The
 * confinement is the same and lives here rather than at each caller: the name
 * is a path segment, and unconfined it reaches another record's artifacts, or
 * another firm's.
 */
export function sentCopyPath(lawFirmId: string, invoiceId: string, name: any): string | null {
  if (!lawFirmId || !invoiceId || !name) return null;
  const value = String(name);
  if (value.includes('/') || value.includes('\\') || value.includes('..')) return null;
  return invoiceArchivePath(lawFirmId, invoiceId, value);
}

/**
 * Whether a preserved copy exists, and how large it is, without reading it.
 *
 * A metadata call rather than a download: a caller minting a signed url needs to
 * know the object is there and how big it is, and pulling the bytes to find out
 * would defeat the point of handing out a url at all.
 */
export async function statSentCopy(objectPath: string) {
  return statArtifact(objectPath);
}

/** A short-lived read url for one preserved copy. Authorize before calling. */
export async function signSentCopy(objectPath: string, fileName: string, ttlMs: number) {
  return signArtifact(objectPath, { contentType: 'application/pdf', fileName, ttlMs });
}
