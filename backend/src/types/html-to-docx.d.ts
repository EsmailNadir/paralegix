// html-to-docx ships no type declarations. Only its default export is used:
// (html, headerHtml, options) resolving to the .docx bytes.
declare module 'html-to-docx' {
  function htmlToDocx(
    htmlString: string,
    headerHTMLString?: string | null,
    documentOptions?: Record<string, unknown>,
    footerHTMLString?: string | null,
  ): Promise<Buffer | Blob>;
  export default htmlToDocx;
}
