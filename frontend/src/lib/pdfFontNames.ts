/**
 * Reading the font name a PDF reports for a run of text.
 *
 * A PDF names the font of a text run with its PostScript name, usually carrying
 * a six-letter subset prefix: `ABCDEE+Calibri-BoldItalic`. Weight and slant are
 * encoded nowhere else, so anything that wants them has to parse that name.
 * Both the PDF-to-HTML import and the overlay editor's font sampler do, which
 * is why these live here rather than in either of them.
 */

/**
 * A font name reduced to its family, as CSS would name it: subset prefix
 * dropped, only the first family of a list kept, separators turned into
 * spaces. `ABCDEE+PT_Sans-Bold, serif` becomes `PT Sans Bold`.
 */
export function normalizePdfFontName(fontFamily?: string): string {
  return (fontFamily ?? "")
    .trim()
    .replace(/^[A-Z]{6}\+/, "")
    .split(",")[0]
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isBoldByName(str: string): boolean {
  return /bold|black|heavy|demi/i.test(str.replace(/^[A-Z]{6}\+/, ""));
}

export function isItalicByName(str: string): boolean {
  return /italic|oblique|slanted/i.test(str.replace(/^[A-Z]{6}\+/, ""));
}
