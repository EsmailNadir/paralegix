/**
 * Laying the Signature Certificate out as PDF content streams.
 *
 * The failure this suite exists for is a certificate that renders a fixed page
 * and silently loses the eleventh signer. A signing certificate that omits a
 * signer is worse than no certificate: it is a document that looks complete and
 * misstates who executed the file. So the assertions below are about the TEXT
 * landing on a page, not about a content stream being non-empty.
 *
 * Everything is read back through the real lexer, because the other half of the
 * risk is a signer name that carries `(`, `)` or `\`. Those are content-stream
 * syntax. A name that escapes its own string object turns the rest of the page
 * into operators, and user-supplied names are exactly where that arrives.
 */
import { Lexer } from '../../../src/modules/signatures/pdf/lexer';
import { readDocumentIndex } from '../../../src/modules/signatures/pdf/reader';
import { resolvePages } from '../../../src/modules/signatures/pdf/pages';
import { buildIncrementalUpdate } from '../../../src/modules/signatures/pdf/writer';
import { planAppendedPages, nextObjectNumber } from '../../../src/modules/signatures/pdf/appendPage';
import {
  planCertificateContent,
  PdfCertificateError,
  type CertificateData,
  type CertificateSigner,
  type CertificatePageGeometry,
  type CertificateContentPlan,
} from '../../../src/modules/signatures/pdf/certificateContent';
import type { PdfDict, PdfSource, PdfValue } from '../../../src/modules/signatures/pdf/types';

const signal = new AbortController().signal;

const LETTER: CertificatePageGeometry = { width: 612, height: 792, margin: 60 };

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function signer(n: number): CertificateSigner {
  const id = String(n).padStart(3, '0');
  return {
    name: `Signer-${id}-Alpha`,
    roleLabel: `Role-${id}`,
    email: `s${id}@example.test`,
    completedAt: '2026-03-28T14:15:00.000Z',
    signerIp: `10.0.0.${n}`,
    signerUserAgent: 'Chrome/120 macOS',
  };
}

function certificate(overrides: Partial<CertificateData> = {}): CertificateData {
  return {
    documentTitle: 'Engagement Letter.pdf',
    transactionId: 'sess_abc123',
    documentPageCount: 4,
    signers: [signer(1)],
    sessionCreatedAt: '2026-03-27T09:00:00.000Z',
    signedAt: '2026-03-28T14:15:00.000Z',
    originalDocumentHash: HASH_A,
    deliveryDocumentHash: HASH_B,
    consentStatement: 'I agree to sign electronically.',
    ...overrides,
  };
}

// --- reading a content stream back -------------------------------------------

type Token = { t: 'op'; v: string } | { t: 'value'; v: PdfValue };

/**
 * Tokenize a content stream with the REAL lexer.
 *
 * A content stream is postfix: operands then an operator. The lexer reads
 * operands, and an operator is a bare keyword it would refuse as a value, so the
 * two are separated here rather than by a regular expression. That matters for
 * the escaping cases: a regular expression over `(...)` cannot tell an escaped
 * parenthesis from a closing one, which is the exact bug being tested for.
 */
function tokenize(bytes: Uint8Array): Token[] {
  const lexer = new Lexer(bytes);
  const out: Token[] = [];
  for (;;) {
    lexer.skipSpace();
    if (lexer.atEnd()) break;
    const b = bytes[lexer.offset];
    if (b === 0x28 || b === 0x2f || b === 0x5b || b === 0x3c) {
      out.push({ t: 'value', v: lexer.readValue() });
      continue;
    }
    const word = lexer.peekKeyword();
    if (!word) {
      lexer.offset = lexer.offset + 1;
      continue;
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      out.push({ t: 'value', v: lexer.readValue() });
      continue;
    }
    lexer.expectKeyword(word);
    out.push({ t: 'op', v: word });
  }
  return out;
}

interface Drawn {
  text: string;
  x: number;
  y: number;
  font: string;
  size: number;
}

/** Every `Tj` on a page, with the position and font it was drawn at. */
function drawnText(bytes: Uint8Array): Drawn[] {
  const out: Drawn[] = [];
  let stack: PdfValue[] = [];
  let x = 0;
  let y = 0;
  let font = '';
  let size = 0;
  for (const token of tokenize(bytes)) {
    if (token.t === 'value') {
      stack.push(token.v);
      continue;
    }
    if (token.v === 'Tf') {
      const nameValue = stack[0];
      font = nameValue && typeof nameValue === 'object' && nameValue.kind === 'name' ? nameValue.value : '';
      size = typeof stack[1] === 'number' ? (stack[1] as number) : 0;
    } else if (token.v === 'Td') {
      x = stack[0] as number;
      y = stack[1] as number;
    } else if (token.v === 'Tj') {
      const stringValue = stack[0];
      if (!stringValue || typeof stringValue !== 'object' || stringValue.kind !== 'string') {
        throw new Error('Tj without a string operand.');
      }
      out.push({ text: Buffer.from(stringValue.bytes).toString('latin1'), x, y, font, size });
    }
    stack = [];
  }
  return out;
}

/** Every y a mark was placed at, text baselines and rule endpoints alike. */
function markedYs(bytes: Uint8Array): number[] {
  const out: number[] = [];
  let stack: PdfValue[] = [];
  for (const token of tokenize(bytes)) {
    if (token.t === 'value') {
      stack.push(token.v);
      continue;
    }
    if (token.v === 'Td' || token.v === 'm' || token.v === 'l') {
      out.push(stack[1] as number);
    }
    stack = [];
  }
  return out;
}

const pageTexts = (plan: CertificateContentPlan): string[][] =>
  plan.pages.map((page) => drawnText(page.content.streamBytes as Uint8Array).map((d) => d.text));

const allText = (plan: CertificateContentPlan): string[] => pageTexts(plan).flat();

// --- a base document to append to --------------------------------------------

function sourceOver(bytes: Buffer): PdfSource {
  return {
    ref: { objectPath: 'test.pdf', generation: '1', sizeBytes: bytes.length },
    async read(start, length) {
      if (start + length > bytes.length) throw new Error('read past the end');
      return new Uint8Array(bytes.subarray(start, start + length));
    },
    async *stream(start, end) { yield new Uint8Array(bytes.subarray(start, end)); },
    async close() {},
  };
}

/** A two-page document whose root /Pages carries the inherited geometry. */
function baseDocument() {
  let out = '%PDF-1.7\n';
  const offsets = new Map<number, number>();
  const objects: Array<[number, string]> = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] /MediaBox [0 0 612 792] /Resources << /ProcSet [/PDF] >> >>'],
    [3, '<< /Type /Page /Parent 2 0 R >>'],
    [4, '<< /Type /Page /Parent 2 0 R >>'],
  ];
  for (const [n, body] of objects) {
    offsets.set(n, out.length);
    out += `${n} 0 obj\n${body}\nendobj\n`;
  }
  const xrefAt = out.length;
  out += 'xref\n0 5\n0000000000 65535 f \n';
  for (let n = 1; n <= 4; n += 1) out += `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return { bytes: Buffer.from(out, 'latin1'), xrefAt };
}

const load = async (bytes: Buffer) => {
  const source = sourceOver(bytes);
  return { source, index: await readDocumentIndex(source, signal) };
};

// --- the layout ---------------------------------------------------------------

describe('laying out a certificate', () => {
  it('carries every field the certificate states', async () => {
    // Goes red if a section is dropped from the layout: the certificate would
    // then omit the transaction, the timeline or the integrity hashes while
    // still reporting success.
    const plan = await planCertificateContent({
      data: certificate(),
      geometry: LETTER,
      firstObjectNumber: 10,
    });
    const text = allText(plan).join('\n');

    expect(text).toContain('SIGNATURE CERTIFICATE');
    expect(text).toContain('Engagement Letter.pdf');
    expect(text).toContain('sess_abc123');
    expect(text).toContain('4 (excluding this certificate)');
    expect(text).toContain('Signer-001-Alpha');
    expect(text).toContain('Role-001');
    expect(text).toContain('s001@example.test');
    expect(text).toContain('10.0.0.1');
    expect(text).toContain('Chrome/120 macOS');
    expect(text).toContain('I agree to sign electronically.');
    // Both hashes wrap, so they are asserted by their halves being present in
    // order rather than as one run.
    expect(text.replace(/\n/g, '')).toContain(HASH_A);
    expect(text.replace(/\n/g, '')).toContain(HASH_B);
  });

  it('fits a short certificate on exactly one page', async () => {
    // Goes red if the layout paginates eagerly, which would put a footer alone
    // on a second page of every certificate ever issued.
    const plan = await planCertificateContent({
      data: certificate({ consentStatement: null }),
      geometry: LETTER,
      firstObjectNumber: 10,
    });

    expect(plan.pages).toHaveLength(1);
  });

  it('flows onto exactly three pages when the signer list is long', async () => {
    // Goes red both ways: a fixed one-page layout reports 1, and a layout that
    // breaks per section rather than per overflow reports more than 3.
    const signers = Array.from({ length: 10 }, (_, i) => signer(i + 1));
    const plan = await planCertificateContent({
      data: certificate({ signers }),
      geometry: LETTER,
      firstObjectNumber: 10,
    });

    expect(plan.pages).toHaveLength(3);
  });

  it('drops no signer from a list that overflows several pages', async () => {
    // The exact failure the pagination exists for. Goes red if any entry past
    // the first page is discarded.
    const signers = Array.from({ length: 40 }, (_, i) => signer(i + 1));
    const plan = await planCertificateContent({
      data: certificate({ signers }),
      geometry: LETTER,
      firstObjectNumber: 10,
    });
    const text = new Set(allText(plan));

    for (const s of signers) {
      expect(text.has(s.name as string)).toBe(true);
      expect(text.has(s.email as string)).toBe(true);
      expect(text.has(s.signerIp as string)).toBe(true);
    }
  });

  it('keeps one signer entry whole on a single page', async () => {
    // Goes red if a page break lands inside an entry, which produces a name at
    // the foot of one page and the IP that belongs to it at the head of the
    // next: a certificate that reads as if someone else signed from that
    // address.
    const signers = Array.from({ length: 40 }, (_, i) => signer(i + 1));
    const plan = await planCertificateContent({
      data: certificate({ signers }),
      geometry: LETTER,
      firstObjectNumber: 10,
    });
    const perPage = pageTexts(plan).map((texts) => new Set(texts));

    for (const s of signers) {
      const page = perPage.findIndex((texts) => texts.has(s.name as string));
      expect(page).toBeGreaterThanOrEqual(0);
      expect(perPage[page].has(s.roleLabel as string)).toBe(true);
      expect(perPage[page].has(s.email as string)).toBe(true);
      expect(perPage[page].has(s.signerIp as string)).toBe(true);
    }
  });

  it('places every mark inside the page margins', async () => {
    // Goes red if the cursor is allowed to run past the bottom of a page, which
    // is how content "fits" on one page by being drawn off it. A viewer shows
    // nothing and the response still says success.
    const signers = Array.from({ length: 25 }, (_, i) => signer(i + 1));
    const plan = await planCertificateContent({
      data: certificate({ signers }),
      geometry: LETTER,
      firstObjectNumber: 10,
    });

    for (const page of plan.pages) {
      const ys = markedYs(page.content.streamBytes as Uint8Array);
      expect(ys.length).toBeGreaterThan(0);
      for (const y of ys) {
        expect(y).toBeLessThanOrEqual(LETTER.height - LETTER.margin);
        expect(y).toBeGreaterThanOrEqual(LETTER.margin);
      }
    }
  });

  it('splits one entry only when the entry alone exceeds a page', async () => {
    // The stated exception. A short page cannot hold a whole signer, so the
    // choice is splitting the entry or dropping it. Goes red if the layout
    // refuses, loops, or discards the entry.
    const geometry: CertificatePageGeometry = { width: 300, height: 150, margin: 20 };
    const plan = await planCertificateContent({
      data: certificate({ signers: [signer(7)] }),
      geometry,
      firstObjectNumber: 10,
    });
    const text = new Set(allText(plan));

    expect(plan.pages.length).toBeGreaterThan(1);
    expect(text.has('Signer-007-Alpha')).toBe(true);
    expect(text.has('10.0.0.7')).toBe(true);
    for (const page of plan.pages) {
      for (const y of markedYs(page.content.streamBytes as Uint8Array)) {
        expect(y).toBeGreaterThanOrEqual(geometry.margin);
      }
    }
  });
});

describe('escaping user-supplied text', () => {
  it('round trips a name carrying parentheses and a backslash', async () => {
    // Goes red the moment a name is written into a content stream unescaped: an
    // unbalanced `)` closes the string early and the rest of the name is read
    // as operators, so the lexer either throws or returns a truncated name.
    const hostile = 'Robert (Bob) O\\Brien )) (((';
    const plan = await planCertificateContent({
      data: certificate({ signers: [{ ...signer(1), name: hostile }] }),
      geometry: LETTER,
      firstObjectNumber: 10,
    });
    const text = allText(plan);

    expect(text).toContain(hostile);
  });

  it('does not let a name inject a content-stream operator', async () => {
    // A name of `) Tj ET ... BT (` is an attempt to end the string, run
    // operators of its own choosing and reopen a string. Goes red if the raw
    // bytes ever reach the stream: the injected `Tj` would appear as its own
    // draw and the name would not appear at all.
    const injection = ') Tj ET 1 0 0 RG 0 0 m 999 999 l S BT (';
    const plan = await planCertificateContent({
      data: certificate({ signers: [{ ...signer(1), name: injection }] }),
      geometry: LETTER,
      firstObjectNumber: 10,
    });
    const draws = plan.pages.flatMap((p) => drawnText(p.content.streamBytes as Uint8Array));

    expect(draws.map((d) => d.text)).toContain(injection);
    // The injected coordinates never became a mark.
    for (const page of plan.pages) {
      expect(markedYs(page.content.streamBytes as Uint8Array)).not.toContain(999);
    }
  });
});

describe('refusing a certificate that names nobody', () => {
  it('refuses an empty signer list', async () => {
    // A Certificate of Completion is the evidence that particular people
    // executed this document. Rendered without a signer section it still says
    // the signing completed, still carries the hashes, and names nobody: it
    // looks authoritative and proves nothing. There used to be a fallback that
    // synthesised one signer from the session's top-level fields, for sessions
    // that predated participant rows. No such session exists.
    await expect(planCertificateContent({
      data: certificate({ signers: [] }),
      geometry: LETTER,
      firstObjectNumber: 10,
    })).rejects.toThrow(PdfCertificateError);
  });

  it('refuses a missing signer list', async () => {
    await expect(planCertificateContent({
      data: certificate({ signers: undefined as never }),
      geometry: LETTER,
      firstObjectNumber: 10,
    })).rejects.toThrow(PdfCertificateError);
  });
});

describe('refusing geometry the content cannot fit', () => {
  it('refuses a page with no usable height', async () => {
    await expect(planCertificateContent({
      data: certificate(),
      geometry: { width: 612, height: 120, margin: 60 },
      firstObjectNumber: 10,
    })).rejects.toThrow(PdfCertificateError);
  });

  it('refuses a page too short for a single line', async () => {
    // Refused rather than clamped. Clamping draws the certificate off the page,
    // which produces a blank certificate that still reports success.
    await expect(planCertificateContent({
      data: certificate(),
      geometry: { width: 612, height: 100, margin: 40 },
      firstObjectNumber: 10,
    })).rejects.toThrow(PdfCertificateError);
  });

  it('refuses a page too narrow for one character', async () => {
    // Character-level breaking is the last resort for a long hash. When even
    // one glyph is wider than the column there is no layout, so this refuses
    // instead of drawing text past the right margin.
    await expect(planCertificateContent({
      data: certificate(),
      geometry: { width: 80, height: 792, margin: 35 },
      firstObjectNumber: 10,
    })).rejects.toThrow(PdfCertificateError);
  });
});

describe('the appended certificate reads back', () => {
  it('keeps the base pages sized and gives the new pages their own MediaBox', async () => {
    // The round trip is what proves the append did not break the document. The
    // reader refuses a sizeless page, so a lost inherited /MediaBox shows up
    // here rather than in a viewer. A4 is used for the certificate so the two
    // geometries are distinguishable.
    const base = baseDocument();
    const { source, index } = await load(base.bytes);
    const geometry: CertificatePageGeometry = { width: 595, height: 842, margin: 50 };

    const content = await planCertificateContent({
      data: certificate({ signers: Array.from({ length: 12 }, (_, i) => signer(i + 1)) }),
      geometry,
      firstObjectNumber: nextObjectNumber(index),
    });
    expect(content.pages.length).toBeGreaterThan(1);

    const pageRefs = content.pages.map((_, i) => ({
      objectNumber: content.nextObjectNumber + i,
      generationNumber: 0,
    }));
    const appended = await planAppendedPages({
      source,
      index,
      signal,
      pageRefs,
      newPages: content.pages.map((p) => p.dictionary),
    });

    const update = buildIncrementalUpdate({
      baseSize: base.bytes.length,
      previousXrefOffset: base.xrefAt,
      objects: [
        { ref: appended.pagesRef, value: appended.pagesDictionary },
        ...appended.pages.map((p) => ({ ref: p.ref, value: p.dictionary })),
        ...content.pages.map((p) => p.content),
      ],
      trailer: index.trailer,
    });

    const composed = Buffer.concat([base.bytes, Buffer.from(update.suffix)]);
    const after = await load(composed);
    const pages = await resolvePages(after.source, after.index, signal);

    expect(pages).toHaveLength(2 + content.pages.length);
    // The two original pages still inherit their size from the copied root.
    expect(pages[0].mediaBox).toMatchObject({ x0: 0, y0: 0, x1: 612, y1: 792 });
    expect(pages[1].mediaBox).toMatchObject({ x0: 0, y0: 0, x1: 612, y1: 792 });
    // Every appended page carries the certificate geometry.
    for (const page of pages.slice(2)) {
      expect(page.mediaBox).toMatchObject({ x0: 0, y0: 0, x1: 595, y1: 842 });
    }
  });

  it('writes each certificate page a content stream whose /Length matches', async () => {
    // A /Length that disagrees with the payload is a refusal in the lexer, not
    // a hint, so this is what stands between the plan and an unreadable
    // appended revision.
    const plan = await planCertificateContent({
      data: certificate(),
      geometry: LETTER,
      firstObjectNumber: 42,
    });

    plan.pages.forEach((page, i) => {
      expect(page.content.ref).toEqual({ objectNumber: 42 + i, generationNumber: 0 });
      const dictionary = page.content.value as PdfDict;
      expect(dictionary.entries.get('Length')).toBe((page.content.streamBytes as Uint8Array).length);
      expect(page.dictionary.entries.get('Contents')).toEqual({
        kind: 'ref',
        value: { objectNumber: 42 + i, generationNumber: 0 },
      });
    });
    expect(plan.nextObjectNumber).toBe(42 + plan.pages.length);
  });

  it('gives every page the standard fonts it draws with', async () => {
    // A page that names a font its /Resources do not declare renders nothing.
    // Goes red if the resource dictionary is built for the first page only.
    const plan = await planCertificateContent({
      data: certificate({ signers: Array.from({ length: 20 }, (_, i) => signer(i + 1)) }),
      geometry: LETTER,
      firstObjectNumber: 10,
    });

    for (const page of plan.pages) {
      const resources = page.dictionary.entries.get('Resources') as PdfDict;
      const fonts = resources.entries.get('Font') as PdfDict;
      const used = new Set(drawnText(page.content.streamBytes as Uint8Array).map((d) => d.font));
      expect(used.size).toBeGreaterThan(0);
      for (const name of used) expect(fonts.entries.has(name)).toBe(true);
    }
  });
});
