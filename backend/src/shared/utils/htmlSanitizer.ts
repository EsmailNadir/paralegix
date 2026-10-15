const sanitizeHtml = require('sanitize-html');

/**
 * Server-side rich-text sanitizer for note/template HTML before it is persisted.
 *
 * The stored value is the real security boundary: a client can reach the API
 * directly (bypassing the editor) and POST a note whose `contentHtml` carries
 * `<img src=x onerror=...>` or `<script>`, which would otherwise execute in any
 * viewer's browser (stored XSS). We keep the formatting the editors produce
 * (headings, lists, tables, links, images, basic inline styling) but strip
 * scripts, event handlers, and dangerous URL schemes.
 */
const ALLOWED_TAGS = sanitizeHtml.defaults.allowedTags.concat([
  'img', 'h1', 'h2', 'u', 's', 'sup', 'sub', 'span', 'mark',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'col', 'colgroup', 'caption',
  // The editor's checklist (TipTap TaskList/TaskItem) renders as
  // <ul data-type="taskList"><li data-checked="..."><label><input type="checkbox">...
  // Without `input`/`label` allowed (and the `data-type`/`data-checked` attributes
  // below), the checkbox is stripped on save and a checklist silently reverts to a
  // plain bulleted list.
  'input', 'label',
]);

// Formatting tags a template legitimately contains. Mirrors the note allow-list
// and adds the structural blocks (figure/figcaption, address, pre, code) rich
// templates use. Script/iframe/style/form-family tags are intentionally absent.
const TEMPLATE_ALLOWED_TAGS = ALLOWED_TAGS.concat([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'figure', 'figcaption', 'address', 'pre', 'code', 'small', 'abbr', 'time',
]);

export function sanitizeRichText(html: unknown): string {
  // A non-string now yields '' rather than being returned untouched. Every
  // caller passes a string or undefined (both already produced ''), so this is
  // behaviour-preserving in practice and closes a hole where a sanitizer could
  // hand back an unsanitized non-string.
  if (typeof html !== 'string' || html.length === 0) return '';
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      '*': ['style', 'class'],
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
      col: ['span'],
      colgroup: ['span'],
      ul: ['data-type'],
      // TipTap's TaskItem stamps `data-type="taskItem"` on the <li> itself
      // (not just `data-checked`) — its own parser matches task items on
      // `li[data-type="taskItem"]`, so dropping this attribute meant a saved
      // checklist item couldn't be recognized as one on reload and silently
      // fell back to a plain list item, losing its checked state.
      li: ['data-checked', 'data-type'],
      // No `value`/`name`/`autofocus`/event-handler attributes: `checked` and a
      // forced `type="checkbox"` (below) are the only state a checklist needs,
      // and `autofocus` combined with an `on*` handler is a classic <input> XSS
      // vector, so neither is ever allowed through.
      input: ['type', 'checked'],
    },
    // http(s)/mailto/tel for links; data: only for inline images (cannot execute).
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    // Drop disallowed tags entirely (don't leave their text content as a stray
    // fragment) for the few clearly-dangerous ones.
    nonTextTags: ['style', 'script', 'textarea', 'noscript', 'iframe', 'object', 'embed'],
    // `input` is only ever a checklist checkbox here — pin its type so the
    // allow-listed `input` tag can't be repurposed as `type="image"` (a `src`/
    // `onerror` vector) or any other input variant.
    transformTags: {
      input: (tagName: string, attribs: Record<string, string>) => ({
        tagName,
        attribs: { ...attribs, type: 'checkbox' },
      }),
    },
  });
}

/**
 * Server-side sanitizer for template HTML before it is persisted to storage.
 *
 * Templates are authored by firm members but the stored HTML is the security
 * boundary: it is later rendered into same-origin blob iframes and popup
 * windows, so an injected `<script>` or `<img onerror=...>` would run with the
 * viewing member's session (stored XSS). This strips scripts, event handlers,
 * and dangerous URL schemes while preserving the rich formatting and layout the
 * template editor produces.
 *
 * Templates rely on absolute positioning (inline `style`), `.pdf-page`/`class`
 * markup, and a large family of `data-*` attributes that the fill, reflow,
 * export, and asset-normalization steps read (placeholder chips, repeaters,
 * image objects/crops, paragraph/flow ids, page metrics). `data-*` and `style`
 * cannot execute, so they are allowed on every element. The asset-normalization
 * pass runs after this and reads `data-template-object-image` /
 * `data-template-asset-id` / `src` from `<img>`, so those must survive intact.
 */
export function sanitizeTemplateHtml(html: unknown): string {
  // See sanitizeRichText: a non-string yields '' rather than passing through.
  if (typeof html !== 'string' || html.length === 0) return '';
  return sanitizeHtml(html, {
    allowedTags: TEMPLATE_ALLOWED_TAGS,
    allowedAttributes: {
      // style/class plus any data-* attribute on every element. data-* values
      // are inert (cannot trigger script execution) and the template fill,
      // reflow, and export pipelines depend on them.
      '*': ['style', 'class', 'id', 'dir', 'lang', 'data-*'],
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height', 'draggable'],
      td: ['colspan', 'rowspan', 'headers'],
      th: ['colspan', 'rowspan', 'headers', 'scope'],
      col: ['span'],
      colgroup: ['span'],
    },
    // http(s)/mailto/tel for links; images additionally allow data: for inline
    // base64 images (which the asset-normalization step uploads to GCS). The
    // img transform below further restricts img data: URLs to data:image/* so a
    // data:text/html payload cannot ride in on a src attribute.
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowProtocolRelative: false,
    transformTags: {
      img: (tagName: string, attribs: Record<string, string>) => {
        const src = attribs.src || '';
        // Allow only image data URLs; drop any other data: payload (e.g.
        // data:text/html) by removing the src while keeping the element.
        if (/^data:/i.test(src) && !/^data:image\//i.test(src)) {
          const { src: _dropped, ...rest } = attribs;
          return { tagName, attribs: rest };
        }
        return { tagName, attribs };
      },
    },
    // Drop these tags and their contents outright. style is intentionally NOT
    // allowed as an element (only the inline style attribute is) so a
    // `<style>` block cannot smuggle in `@import`/expression payloads.
    nonTextTags: ['style', 'script', 'textarea', 'noscript', 'iframe', 'object', 'embed', 'form'],
  });
}
