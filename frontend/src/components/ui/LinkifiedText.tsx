import type { ReactNode } from "react";

/**
 * The link look free text uses on a plain surface, matching the links in a
 * received chat message. Also the look of a link inside a sentence elsewhere,
 * underlined so it does not rely on colour alone.
 */
export const INLINE_LINK_CLASS =
  "underline underline-offset-2 text-accent-emphasis hover:text-accent-emphasis-hover dark:hover:text-accent-emphasis-hover";

// Only http(s), mailto and tel become links. Anything else (javascript:,
// data:, vbscript:) stays text, because the text can come from an external
// calendar. Group 1 and 2 are a markdown `[label](url)`; group 3 a bare URL.
const LINK_PATTERN =
  /\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)<>"]+|tel:\+?[\d\-.]+\d)\)|((?:https?:\/\/|mailto:)[^\s<>"]+|tel:\+?[\d\-().]+\d)|([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})|(?<![\w/])((?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)|\d{3})[ .-]\d{3}[ .-]\d{4}|\+\d{7,15})(?!\w)/g;

/** Sentence punctuation that follows a bare URL but is not part of it. */
function trimTrailing(url: string): string {
  let end = url.length;
  for (;;) {
    const ch = url[end - 1];
    if (!ch) break;
    if (".,;:!?'\"".includes(ch)) { end -= 1; continue; }
    if (ch === ")") {
      const body = url.slice(0, end);
      const opens = (body.match(/\(/g) || []).length;
      const closes = (body.match(/\)/g) || []).length;
      if (closes > opens) { end -= 1; continue; }
    }
    break;
  }
  return url.slice(0, end);
}

interface LinkifiedTextProps {
  text: string;
  /** Class for each link; defaults to the plain-surface link look. */
  linkClassName?: string;
}

/**
 * Free text with its http(s), mailto and tel URLs rendered as links, and
 * markdown `[label](url)` links rendered as their label. Built from React text
 * nodes, never HTML, so nothing in the text is ever interpreted as markup.
 * Whitespace is left to the caller (`whitespace-pre-wrap` on the container).
 */
export default function LinkifiedText({ text, linkClassName = INLINE_LINK_CLASS }: LinkifiedTextProps) {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  const link = (key: number, href: string, label: string) => (
    <a key={key} href={href} target="_blank" rel="noopener noreferrer" className={linkClassName}>
      {label}
    </a>
  );

  for (const match of text.matchAll(LINK_PATTERN)) {
    const start = match.index ?? 0;
    if (match[1] && match[2]) {
      if (start > lastIndex) parts.push(text.slice(lastIndex, start));
      parts.push(link(start, match[2], match[1]));
      lastIndex = start + match[0].length;
    } else if (match[3]) {
      const url = trimTrailing(match[3]);
      if (start > lastIndex) parts.push(text.slice(lastIndex, start));
      parts.push(link(start, url, url));
      lastIndex = start + url.length;
    } else if (match[4] || match[5]) {
      const label = match[4] || match[5];
      const href = match[4] ? `mailto:${label}` : `tel:${label.replace(/[^\d+]/g, '')}`;
      if (start > lastIndex) parts.push(text.slice(lastIndex, start));
      parts.push(link(start, href, label));
      lastIndex = start + label.length;
    }
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));

  return <>{parts}</>;
}
