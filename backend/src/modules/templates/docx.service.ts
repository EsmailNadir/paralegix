// docxtemplater and pizzip are required inside the functions that use them, not
// here: only filling or inspecting a DOCX template needs them, and loading them
// at boot would cost every instance their memory whether or not it ever does.
const { ValidationError } = require('../../shared/errors/AppError');

// Guard against malformed uploads / zip bombs: a legitimate DOCX is a handful of
// small XML parts, not thousands of entries or hundreds of MB uncompressed.
const MAX_ZIP_ENTRIES = 2000;
const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024; // 200 MB

/**
 * Parse a DOCX buffer into a PizZip instance, rejecting malformed files and
 * obvious zip bombs with a clean 400 instead of a deep parser crash or a memory
 * spike.
 */
export function loadDocxZip(buffer: any) {
  const PizZip = require('pizzip');
  let zip;
  try {
    zip = new PizZip(buffer);
  } catch (err: any) {
    throw new ValidationError('Invalid DOCX file');
  }

  const files = Object.values(zip.files || {});
  if (files.length === 0 || files.length > MAX_ZIP_ENTRIES) {
    throw new ValidationError('Invalid DOCX file');
  }

  let uncompressedBytes = 0;
  for (const file of files as any[]) {
    const size = file?._data?.uncompressedSize ?? 0;
    uncompressedBytes += size;
    if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
      throw new ValidationError('Invalid DOCX file');
    }
  }

  // A real DOCX always contains the main document part.
  if (!zip.files['word/document.xml']) {
    throw new ValidationError('Invalid DOCX file');
  }

  return zip;
}

/**
 * Parse a DOCX buffer and extract all placeholder tags.
 *
 * Supports:
 *   - Simple tags: {client_name}
 *   - Loop tags:   {#items}{name}{amount}{/items}
 *
 * Returns { fields: string[], repeaters: { name: string, fields: string[] }[] }
 */
export function parseDocxPlaceholders(buffer: any) {
  const Docxtemplater = require('docxtemplater');
  const InspectModule = require('docxtemplater/js/inspect-module');
  const zip = loadDocxZip(buffer);
  const iModule = InspectModule();
  try {
    // eslint-disable-next-line no-new
    new Docxtemplater(zip, {
      modules: [iModule],
      paragraphLoop: true,
      linebreaks: true,
    });
  } catch (err: any) {
    throw new ValidationError('Invalid DOCX file');
  }

  const tags = iModule.getAllTags();
  // tags looks like: { client_name: {}, items: { name: {}, amount: {} } }

  const fields = [];
  const repeaters = [];

  for (const [key, value] of Object.entries(tags)) {
    if (value && typeof value === 'object' && Object.keys(value).length > 0) {
      repeaters.push({ name: key, fields: Object.keys(value) });
    } else {
      fields.push(key);
    }
  }

  return { fields, repeaters };
}

/**
 * Fill a DOCX template buffer with provided data and return the filled DOCX buffer.
 *
 * @param {Buffer} docxBuffer - Original template DOCX
 * @param {Record<string, string>} values - Simple field values
 * @param {Record<string, Record<string, string>[]>} repeaterValues - Loop data
 * @returns {Buffer} Filled DOCX buffer
 */
export function fillDocxTemplate(docxBuffer: any, values: any = {}, repeaterValues: any = {}) {
  const Docxtemplater = require('docxtemplater');
  const zip = loadDocxZip(docxBuffer);
  let doc;
  try {
    doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      // Docxtemplater's own default nullGetter renders the literal string
      // "undefined" for any simple tag absent from the data object (see
      // docxtemplater/js/doc-utils.js's getDefaults()). A caller filling a
      // template commonly skips an optional field, which is not an error
      // condition; without this override that produced a delivered document
      // reading e.g. "your matter number is undefined." instead of blank.
      nullGetter: () => '',
    });
  } catch (err: any) {
    throw new ValidationError('Invalid DOCX file');
  }

  // Merge simple values and repeater arrays into one data object
  const data = { ...values, ...repeaterValues };

  try {
    doc.render(data);
  } catch (err: any) {
    // docxtemplater surfaces tag problems (unclosed/unopened/duplicate tags,
    // malformed loops) as errors with structured details on `err.properties`.
    // A multi-error carries the individual errors on `err.properties.errors`,
    // each with its own `.properties`. Convert these into a clean 4xx instead
    // of letting a raw render crash escape as a 500.
    const subErrors = Array.isArray(err?.properties?.errors) ? err.properties.errors : null;
    const details = subErrors
      ? subErrors.map((e: any) => ({
          message: e?.message || e?.properties?.explanation || 'Template tag error',
          ...(e?.properties || {}),
        }))
      : [{
          message: err?.message || 'Template tag error',
          ...(err?.properties || {}),
        }];
    throw new ValidationError({
      message: 'Template could not be rendered. Check the template for invalid or unclosed tags.',
      errors: details,
    });
  }
  return doc.getZip().generate({ type: 'nodebuffer' });
}
