"use client";

import { reflowFilledTemplate } from "./template-reflow";

const TEMPLATE_PREVIEW_REFLOW_SCRIPT = `<script>window.addEventListener("load",${reflowFilledTemplate.toString()});<` + `/script>`;

const TEMPLATE_PREVIEW_STYLES = `<style>
  html, body { background: #f5f5f7 !important; margin: 0 !important; padding: 24px !important; }
  body { box-sizing: border-box; min-height: 100vh; }
  .pdf-page { margin: 0 auto 24px !important; background: #fff !important; box-shadow: 0 16px 40px rgba(15, 23, 42, 0.16) !important; }
  .pdf-page-background { display: block !important; }
  /* Match pdfToHtml layering so body text stays above watermark images (z-index:0). */
  .pdf-page p { z-index: 1 !important; }
  .pdf-page > a[href] { z-index: 1 !important; }
  .pdf-page p br,
  .pdf-page [data-template-text-box-editor] br { display: block !important; content: ""; margin-top: 0.5rem !important; }
  [data-placeholder-chip] { text-decoration: none !important; }
  img[data-template-object-image="true"] { display: block !important; max-width: none !important; }
</style>`;

function sanitizeTitle(title: string) {
  return title.replace(/[<&>"]/g, "");
}

export function injectTemplatePreviewStyles(html: string, title: string) {
  const titleTag = `<title>${sanitizeTitle(title)}</title>`;
  const headInjection = `${titleTag}${TEMPLATE_PREVIEW_STYLES}`;

  let result: string;

  if (html.includes("</head>")) {
    result = html.replace("</head>", `${headInjection}</head>`);
  } else if (html.includes("<body")) {
    result = html.replace(
      /<body([^>]*)>/i,
      `<head>${headInjection}</head><body$1>`
    );
  } else {
    result = `<!DOCTYPE html><html><head>${headInjection}</head><body>${html}</body></html>`;
  }

  // Inject reflow script before </body> so paragraphs that grew from
  // placeholder replacement are shifted and page-boundary splits are correct.
  if (result.includes("</body>")) {
    result = result.replace("</body>", `${TEMPLATE_PREVIEW_REFLOW_SCRIPT}</body>`);
  } else {
    result += TEMPLATE_PREVIEW_REFLOW_SCRIPT;
  }

  return result;
}
