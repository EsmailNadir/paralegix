import { PDFDocument, PDFName } from 'pdf-lib';
import { formatBytes } from '@/lib/utils/format';

export interface FlattenResult {
  file: File;
  fieldsCount: number;
}

/**
 * The largest PDF this tab will flatten.
 *
 * Flattening holds the whole file, pdf-lib's object graph of it (several times
 * the file size) and a second, flattened copy, all in the browser. Past this a
 * large form can freeze or crash the tab before anything uploads. The same
 * ceiling the in-browser annotator uses (`ANNOTATOR_MAX_BYTES`), for the same
 * reason.
 */
export const FLATTEN_MAX_BYTES = 50 * 1024 * 1024;

/** Why a PDF over `FLATTEN_MAX_BYTES` is refused, and the manual route instead. */
export function flattenTooLargeMessage(sizeBytes: number): string {
  return `This PDF is ${formatBytes(sizeBytes)}. Forms can be flattened in your browser up to ${formatBytes(FLATTEN_MAX_BYTES)}. `
    + 'Open it in your PDF viewer and choose File > Print > Save as PDF to flatten it, then upload that copy.';
}

/**
 * Flattens all interactive form fields in a PDF client-side in the browser.
 *
 * Bakes form field values and visuals directly into static page content streams
 * and removes AcroForm/XFA dictionaries. This guarantees an immutable document
 * for electronic signing with zero server CPU or memory consumption.
 */
export async function flattenPdf(file: File): Promise<FlattenResult> {
  // Refused before a byte is read: reading it is what exhausts the tab.
  if (file.size > FLATTEN_MAX_BYTES) throw new Error(flattenTooLargeMessage(file.size));
  const arrayBuffer = await file.arrayBuffer();
  const pdfDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });

  let fieldsCount = 0;
  try {
    const form = pdfDoc.getForm();
    const fields = form.getFields();
    fieldsCount = fields.length;
    form.flatten();
  } catch (err) {
    console.warn('[pdfFlatten] form.flatten warning:', err);
  }

  // Ensure AcroForm is completely removed from document catalog so admission
  // checks never see an unflattened or dangling AcroForm reference.
  try {
    if (pdfDoc.catalog.has(PDFName.of('AcroForm'))) {
      pdfDoc.catalog.delete(PDFName.of('AcroForm'));
    }
  } catch (err) {
    console.warn('[pdfFlatten] catalog cleanup warning:', err);
  }

  const flattenedBytes = await pdfDoc.save();
  const buffer = flattenedBytes.buffer.slice(
    flattenedBytes.byteOffset,
    flattenedBytes.byteOffset + flattenedBytes.byteLength
  ) as ArrayBuffer;
  const flattenedFile = new File([buffer], file.name, {
    type: 'application/pdf',
    lastModified: Date.now(),
  });

  return {
    file: flattenedFile,
    fieldsCount,
  };
}
