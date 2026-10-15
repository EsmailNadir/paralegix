import type { SignatureField } from '@/types/signature';

/**
 * Template fields that land on a page the current document does not have.
 *
 * A template saved against a five-page engagement letter and reused on a two-page
 * one keeps fields on pages three to five. The paged viewer could never scroll to
 * them, so they were invisible yet still sent and stamped; a continuous scroll just
 * runs out of document instead. Reported so the editor can say so rather than
 * quietly carrying them.
 *
 * A page count of 0 means the PDF has not reported yet; everything "fits" until it
 * does, so a template is never flagged mid-load.
 */
export function fieldsOutsideDocument(
  fields: SignatureField[],
  totalPages: number
): SignatureField[] {
  if (!totalPages) return [];
  return fields.filter((field) => field.page > totalPages);
}
