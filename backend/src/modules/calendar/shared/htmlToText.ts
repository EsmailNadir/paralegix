/**
 * Turn a provider event description into the plain text Paralegix stores.
 *
 * Outlook returns every body as HTML, and Google returns HTML once a
 * description has been formatted in its web editor. What a firm needs from
 * either is the words and the links: a Teams or Zoom invite is useless without
 * the address behind "Join the meeting now". So a link keeps its target in
 * parentheses after its text (or alone, when the text is the address), block
 * elements and list items become lines, the document head, styles and scripts
 * are dropped, and every entity is decoded exactly once by the parser.
 *
 * Text that carries no markup at all is returned as written, line breaks
 * included: a description written through either API is plain text, and
 * reading it as HTML would collapse its line breaks and decode an "&amp;" the
 * author typed.
 */
import { Parser } from 'htmlparser2';

/** Elements whose content is never shown. */
const HIDDEN = new Set(['head', 'style', 'script', 'title', 'noscript', 'template', 'xml', 'object', 'iframe']);

/** Elements that start and end on a line of their own. */
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'center', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
  'html', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'tfoot', 'thead',
  'tr', 'ul', 'caption',
]);

/**
 * Markup this converter recognizes. A string with none of it is plain text.
 * Deliberately a list of real tag names rather than "anything in angle
 * brackets", so "fees < $500" and "<client name>" stay text.
 */
const KNOWN_TAG = /<\/?(?:a|abbr|b|big|blockquote|body|br|caption|center|code|dd|del|div|dl|dt|em|font|h[1-6]|head|hr|html|html-blob|i|img|ins|li|mark|meta|o:p|ol|p|pre|s|small|span|strike|strong|style|sub|sup|table|tbody|td|tfoot|th|thead|title|tr|tt|u|ul)(?:\s[^>]*)?\/?>/i;

/** Markup that defines lines itself, so a raw newline in the source is only whitespace. */
const LINE_MARKUP = /<\/?(?:br|p|div|li|ul|ol|tr|table|h[1-6]|blockquote|pre|hr|body|html)(?:\s[^>]*)?\/?>/i;

/** Schemes whose target is worth showing beside the link text. */
const SHOWN_SCHEME = /^(?:https?:|mailto:|tel:)/i;

/** True when `value` reads as HTML this converter should parse. */
function looksLikeHtml(value: string): boolean {
  return KNOWN_TAG.test(value) || /<!--[\s\S]*?-->/.test(value);
}

function normalizePlain(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The address a link's text has to equal for the target to be left out. */
function comparableAddress(value: string): string {
  return value.trim()
    .replace(/^mailto:/i, '')
    .replace(/^tel:/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

interface ListFrame { ordered: boolean; next: number }
interface LinkFrame { href: string | null; start: number }

/**
 * Convert one description to plain text. Plain text passes through with only
 * its line endings and trailing spaces normalized.
 */
export function htmlToText(input: unknown): string {
  if (input === null || input === undefined) return '';
  const source = String(input);
  if (!source.trim()) return '';
  if (!looksLikeHtml(source)) return normalizePlain(source);

  // Markup with no line structure of its own (a sentence with one link in it)
  // keeps the line breaks it was typed with.
  const keepNewlines = !LINE_MARKUP.test(source);

  let out = '';
  let hiddenDepth = 0;
  let preDepth = 0;
  const lists: ListFrame[] = [];
  const links: LinkFrame[] = [];
  let cellsInRow = 0;

  const atLineStart = () => out === '' || out.endsWith('\n');

  // Ensure the output ends with a line break, without stacking them: a block
  // inside a block is still one line, and only an explicit <br> adds a blank one.
  const endLine = () => {
    if (!atLineStart()) out += '\n';
  };

  const appendText = (raw: string) => {
    if (hiddenDepth > 0 || raw === '') return;
    if (preDepth > 0) {
      out += raw.replace(/\r\n?/g, '\n');
      return;
    }
    const pieces = keepNewlines ? raw.replace(/\r\n?/g, '\n').split('\n') : [raw];
    pieces.forEach((piece, index) => {
      if (index > 0) out += '\n';
      let text = piece.replace(/[ \t\n\r\f]+/g, ' ');
      if (atLineStart() || out.endsWith(' ')) text = text.replace(/^ +/, '');
      out += text;
    });
  };

  const parser = new Parser({
    onopentag(name, attribs) {
      const tag = name.toLowerCase();
      if (HIDDEN.has(tag)) { hiddenDepth += 1; return; }
      if (hiddenDepth > 0) return;
      if (tag === 'br') { out += '\n'; return; }
      if (tag === 'pre') preDepth += 1;
      if (tag === 'ul' || tag === 'ol') {
        endLine();
        lists.push({ ordered: tag === 'ol', next: 1 });
        return;
      }
      if (tag === 'li') {
        endLine();
        const list = lists[lists.length - 1];
        const indent = '  '.repeat(Math.max(0, lists.length - 1));
        if (list?.ordered) {
          out += `${indent}${list.next}. `;
          list.next += 1;
        } else {
          out += `${indent}- `;
        }
        return;
      }
      if (tag === 'tr') { endLine(); cellsInRow = 0; return; }
      if (tag === 'td' || tag === 'th') {
        if (cellsInRow > 0 && !atLineStart() && !out.endsWith(' ')) out += ' ';
        cellsInRow += 1;
        return;
      }
      if (tag === 'a') {
        links.push({ href: typeof attribs.href === 'string' ? attribs.href.trim() : null, start: out.length });
        return;
      }
      if (BLOCK.has(tag)) endLine();
    },
    ontext(text) {
      appendText(text);
    },
    onclosetag(name) {
      const tag = name.toLowerCase();
      if (HIDDEN.has(tag)) { hiddenDepth = Math.max(0, hiddenDepth - 1); return; }
      if (hiddenDepth > 0) return;
      if (tag === 'br') return;
      if (tag === 'pre') preDepth = Math.max(0, preDepth - 1);
      if (tag === 'ul' || tag === 'ol') {
        lists.pop();
        endLine();
        return;
      }
      if (tag === 'a') {
        const link = links.pop();
        if (!link?.href || !SHOWN_SCHEME.test(link.href)) return;
        const text = out.slice(link.start).trim();
        if (!text) {
          if (!atLineStart() && !out.endsWith(' ')) out += ' ';
          out += link.href.replace(/^mailto:/i, '');
        } else if (comparableAddress(text) !== comparableAddress(link.href)) {
          out = `${out.replace(/ +$/, '')} (${link.href})`;
        }
        return;
      }
      if (BLOCK.has(tag)) endLine();
    },
  }, { decodeEntities: true, lowerCaseTags: true, recognizeSelfClosing: true });
  parser.write(source);
  parser.end();

  return out
    .replace(/ /g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
