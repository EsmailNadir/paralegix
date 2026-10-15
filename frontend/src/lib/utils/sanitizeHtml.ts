import DOMPurify from "isomorphic-dompurify";

/**
 * Sanitize rich-text/HTML before injecting it via dangerouslySetInnerHTML.
 *
 * Notes, template previews and other rich content are authored in the app but the
 * stored HTML is the security boundary (a value can reach the DB by bypassing the
 * editor and calling the API directly). DOMPurify strips <script>, event handlers
 * (onerror/onclick/...), and javascript: URLs while keeping the formatting the
 * editors produce (headings, lists, tables, links, images, basic styling).
 *
 * Uses isomorphic-dompurify so it works during SSR (jsdom) and on the client, so
 * the server-rendered markup is already clean and can't execute on first paint.
 */
export function sanitizeRichHtml(html?: string | null): string {
  if (!html) return "";
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "srcdoc"],
  });
}
