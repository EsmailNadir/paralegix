/**
 * Small, real PDFs for tests that go through the admission boundary.
 *
 * Admission reads structure: the cross-reference table, the trailer, the
 * catalog and the page tree. So a fixture cannot be a `%PDF` header in front of
 * filler any more. A header alone used to be enough because nothing parsed it,
 * and a test built that way now passes or fails for reasons unrelated to what
 * it is about.
 *
 * These are built by hand rather than through a library on purpose. Every
 * offset in the cross-reference is computed from the bytes actually emitted, so
 * a fixture is either a document a parser accepts or it is obviously broken.
 * Options exist for the shapes admission REFUSES, which cannot be produced by a
 * writer that only emits valid documents.
 */

/** One numbered object: its body, and its stream payload when it has one. */
interface ObjectSpec {
  n: number;
  body: string;
  payload?: string;
}

export interface MinimalPdfOptions {
  /** How many pages the document has. */
  pages?: number;
  /** Add an AcroForm with one text field that has NO appearance. */
  acroForm?: boolean;
  /**
   * Add an AcroForm whose text field carries a normal appearance showing its
   * value, which is the shape flattening can actually prove and place.
   */
  flattenableForm?: boolean;
  /** Give the AcroForm a `/DA`, which is what an unowned field falls back to. */
  formDefaultAppearance?: boolean;
  /** `/SigFlags`, which bit 1 of marks an existing signature field. */
  sigFlags?: number;
  /** Add `/XFA` to the AcroForm, which admission refuses. */
  xfa?: boolean;
  /** Add `/Encrypt` to the trailer, which admission refuses. */
  encrypted?: boolean;
  /**
   * Padding after `%%EOF`, to reach a wanted byte length.
   *
   * Trailing bytes make a file LARGE but not readable: a reader finds the
   * cross-reference from the tail, and this pushes `startxref` out of the tail
   * window. Use it for a test about a size ceiling, which refuses before
   * parsing, and `fillerBytes` for a test that has to open the document.
   */
  padToBytes?: number;
  /**
   * A large content stream on the first page, so the document is genuinely big
   * AND still opens. This is what a scanned page is: a lot of bytes inside one
   * object, with a small structure around it.
   */
  fillerBytes?: number;
  /**
   * Write the cross-reference as an uncompressed xref STREAM (PDF 1.5) rather
   * than a classic table. Modern Word and Adobe exports look like this, and an
   * incremental update has to answer one in kind or Apple CoreGraphics blanks
   * the original pages.
   */
  xrefStream?: boolean;
}

/** The value the flattenable field shows, so a test can look for it. */
export const FORM_FIELD_VALUE = 'Jane Roe';

/**
 * An xref stream covering objects 0 to `highest`, plus itself as `highest + 1`.
 *
 * Uncompressed, with `/W [1 4 2]`: each entry is a type byte, a four-byte
 * offset and a two-byte generation. The trailer entries move into the stream's
 * own dictionary, which is where an xref-stream document keeps them.
 */
function xrefStreamSection(offsets: Map<number, number>, highest: number, xrefAt: number, trailerEntries: string[]) {
  const streamNumber = highest + 1;
  const entryWidth = 7;
  const payload = Buffer.alloc((streamNumber + 1) * entryWidth, 0);
  const writeEntry = (n: number, type: number, offset: number, generation: number) => {
    payload[n * entryWidth] = type;
    payload.writeUInt32BE(offset, n * entryWidth + 1);
    payload.writeUInt16BE(generation, n * entryWidth + 5);
  };
  writeEntry(0, 0, 0, 65535);
  for (let n = 1; n <= highest; n += 1) {
    if (offsets.has(n)) writeEntry(n, 1, offsets.get(n)!, 0);
    else writeEntry(n, 0, 0, 65535);
  }
  writeEntry(streamNumber, 1, xrefAt, 0);
  const dictionary = `<< /Type /XRef /Size ${streamNumber + 1} /W [1 4 2] ${trailerEntries.join(' ')} /Length ${payload.length} >>`;
  return Buffer.concat([
    Buffer.from(`${streamNumber} 0 obj\n${dictionary}\nstream\n`, 'latin1'),
    payload,
    Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`, 'latin1'),
  ]);
}

/** Assemble numbered objects into a document, classic xref unless asked for a stream. */
function assemble(
  objects: ObjectSpec[], trailerEntries: string[], padToBytes?: number, xrefStream = false,
) {
  let out = '%PDF-1.7\n';
  const offsets = new Map<number, number>();
  for (const object of objects) {
    offsets.set(object.n, out.length);
    out += `${object.n} 0 obj\n${object.body}\n`;
    if (object.payload !== undefined) out += `stream\n${object.payload}\nendstream\n`;
    out += 'endobj\n';
  }

  const xrefAt = out.length;
  const highest = Math.max(...objects.map((o) => o.n));
  if (xrefStream) {
    return {
      bytes: Buffer.concat([
        Buffer.from(out, 'latin1'), xrefStreamSection(offsets, highest, xrefAt, trailerEntries),
      ]),
      xrefAt,
    };
  }
  out += `xref\n0 ${highest + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= highest; n += 1) {
    out += offsets.has(n)
      ? `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n`
      : '0000000000 65535 f \n';
  }
  out += `trailer\n<< /Size ${highest + 1} ${trailerEntries.join(' ')} >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  let bytes = Buffer.from(out, 'latin1');
  if (padToBytes && padToBytes > bytes.length) {
    // Trailing bytes after %%EOF. A reader finds the cross-reference from
    // `startxref`, so padding does not change what the document says.
    bytes = Buffer.concat([bytes, Buffer.alloc(padToBytes - bytes.length, 0x20)]);
  }
  return { bytes, xrefAt };
}

/**
 * A document, plus where its cross-reference starts.
 *
 * The xref offset is returned because an incremental update needs it for
 * `/Prev`, and recomputing it from the bytes is the kind of duplication that
 * drifts.
 */
export function minimalPdf(options: MinimalPdfOptions = {}): { bytes: Buffer; xrefAt: number } {
  const pageCount = Math.max(1, options.pages ?? 1);
  const wantsForm = !!(options.acroForm || options.xfa || options.flattenableForm);

  // 1 is the catalog and 2 the root Pages node. Pages follow, then the form.
  const firstPage = 3;
  const kids: string[] = [];
  for (let i = 0; i < pageCount; i += 1) kids.push(`${firstPage + i} 0 R`);
  const acroFormNumber = firstPage + pageCount;
  const fieldNumber = acroFormNumber + 1;
  const appearanceNumber = fieldNumber + 1;
  const fontNumber = appearanceNumber + 1;
  const fillerNumber = fontNumber + 1;

  const catalogEntries = ['/Type /Catalog', '/Pages 2 0 R'];
  if (wantsForm) catalogEntries.push(`/AcroForm ${acroFormNumber} 0 R`);

  const objects: ObjectSpec[] = [
    { n: 1, body: `<< ${catalogEntries.join(' ')} >>` },
    { n: 2, body: `<< /Type /Pages /Count ${pageCount} /Kids [${kids.join(' ')}] /MediaBox [0 0 612 792] >>` },
  ];
  for (let i = 0; i < pageCount; i += 1) {
    // The widget lives on the FIRST page only, which is what a flattening test
    // needs: the pages that carry nothing must come through untouched.
    const annots = options.flattenableForm && i === 0 ? ` /Annots [${fieldNumber} 0 R]` : '';
    const contents = options.fillerBytes && i === 0 ? ` /Contents ${fillerNumber} 0 R` : '';
    objects.push({ n: firstPage + i, body: `<< /Type /Page /Parent 2 0 R${annots}${contents} >>` });
  }

  if (wantsForm) {
    const formEntries = [`/Fields [${fieldNumber} 0 R]`];
    // The default appearance every field without its own falls back to. Real
    // forms carry one; it is optional here so the fixtures that predate it keep
    // the bytes their assertions were written against.
    if (options.formDefaultAppearance) formEntries.push('/DA (/Helv 0 Tf 0 g)');
    if (options.sigFlags !== undefined) formEntries.push(`/SigFlags ${options.sigFlags}`);
    if (options.xfa) formEntries.push(`/XFA [(preamble) ${appearanceNumber} 0 R]`);
    objects.push({ n: acroFormNumber, body: `<< ${formEntries.join(' ')} >>` });

    if (options.flattenableForm) {
      // A merged field and widget, which is how a one-widget field is usually
      // written. The appearance SHOWS the value, because flattening refuses an
      // appearance it cannot prove displays what the field says.
      objects.push({
        n: fieldNumber,
        body: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (Full name) '
          + `/V (${FORM_FIELD_VALUE}) /Rect [72 700 300 730] /P ${firstPage} 0 R `
          + `/AP << /N ${appearanceNumber} 0 R >> >>`,
      });
      const payload = `BT /F1 12 Tf 2 8 Td (${FORM_FIELD_VALUE}) Tj ET`;
      objects.push({
        n: appearanceNumber,
        body: '<< /Type /XObject /Subtype /Form /BBox [0 0 228 30] '
          + `/Resources << /Font << /F1 ${fontNumber} 0 R >> >> /Length ${payload.length} >>`,
        payload,
      });
      objects.push({ n: fontNumber, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' });
    } else {
      objects.push({ n: fieldNumber, body: '<< /FT /Tx /T (Full name) /V (Jane Roe) >>' });
    }
  }

  if (options.fillerBytes) {
    // A real content stream, so the page still draws. The comment operator makes
    // the filler legal PDF content rather than bytes a strict reader rejects.
    const payload = `% ${'f'.repeat(Math.max(1, options.fillerBytes - 3))}\n`;
    objects.push({ n: fillerNumber, body: `<< /Length ${payload.length} >>`, payload });
  }

  const trailer = ['/Root 1 0 R'];
  // A real encrypted document's strings and streams are encrypted too. The
  // trailer entry is what admission reads, and it is what makes the refusal
  // testable without building a document nothing here could open.
  if (options.encrypted) trailer.push('/Encrypt 99 0 R');

  return assemble(objects, trailer, options.padToBytes, options.xrefStream);
}

/** Just the bytes, for the common case. */
export function minimalPdfBytes(options: MinimalPdfOptions = {}): Buffer {
  return minimalPdf(options).bytes;
}
