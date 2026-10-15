export interface RichTextRun {
  text: string;
  bold: boolean;
  italic: boolean;
  color: string;
}

export interface RichTextBlock {
  bullet: boolean;
  runs: RichTextRun[];
}

export interface StyledSegment {
  text: string;
  bold: boolean;
  italic: boolean;
  color: string;
}

export interface StyledLine {
  segments: StyledSegment[];
}

export interface FitRichTextResult {
  lines: StyledLine[];
  fontSize: number;
  lineHeight: number;
}

type MeasureFn = (text: string, fontSize: number, bold: boolean, italic: boolean) => number;

/** A run of text that must stay together on one wrapped line except by the
 *  hard-break fallback: one or more styled fragments, since a run boundary
 *  (a bold toggle, a field chip) can fall in the middle of a word. */
type Word = { text: string; bold: boolean; italic: boolean; color: string }[];

const LINE_HEIGHT_RATIO = 1.15;
const ELLIPSIS = '…';
const BULLET_PREFIX = '•  ';

/**
 * The mixed-run counterpart of `fitTextToBox` (this directory): wraps a
 * sequence of styled paragraph blocks to a font size and set of lines that
 * provably fit `boxWidth` x `boxHeight`, same shrink-then-truncate strategy,
 * generalized so each line can carry more than one bold/italic/color run.
 *
 * Shared by the browser preview and authoritative PDF stamp.
 */
export function fitRichTextToBox(
  blocks: RichTextBlock[],
  boxWidth: number,
  boxHeight: number,
  maxFontSize: number,
  measure: MeasureFn,
  minFontSize = 5,
): FitRichTextResult {
  const availableWidth = Math.max(1, boxWidth - 8);
  const startSize = Math.max(minFontSize, maxFontSize);

  let lines: StyledLine[] = [];
  let fontSize = minFontSize;

  for (fontSize = startSize; fontSize >= minFontSize; fontSize -= 1) {
    lines = wrapRichLines(blocks, fontSize, availableWidth, measure);
    const totalHeight = lines.length * fontSize * LINE_HEIGHT_RATIO;
    if (totalHeight <= boxHeight || fontSize === minFontSize) break;
  }

  const lineHeight = fontSize * LINE_HEIGHT_RATIO;
  const maxLines = Math.max(1, Math.floor(boxHeight / lineHeight));
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[lines.length - 1] = truncateRichLineWithEllipsis(lines[lines.length - 1], fontSize, availableWidth, measure);
  }

  return { lines, fontSize, lineHeight };
}

/** Splits one block's runs into paragraphs (a literal `\n` inside a run's
 *  resolved text forces a break, e.g. a multi-line field value) of `Word`s:
 *  whitespace-delimited, but a word's own fragments can come from different
 *  runs when a style change or a field chip falls inside it. */
function tokenizeBlockWords(block: RichTextBlock): Word[][] {
  const paragraphs: Word[][] = [[]];
  let current: Word = [];

  const pushWord = () => {
    if (current.length) {
      paragraphs[paragraphs.length - 1].push(current);
      current = [];
    }
  };

  for (const run of block.runs) {
    const style = { bold: run.bold, italic: run.italic, color: run.color };
    const runParagraphs = (run.text ?? '').split('\n');
    runParagraphs.forEach((piece, i) => {
      if (i > 0) {
        pushWord();
        paragraphs.push([]);
      }
      for (const chunk of piece.split(/(\s+)/)) {
        if (chunk === '') continue;
        if (/^\s+$/.test(chunk)) {
          pushWord();
        } else {
          current.push({ text: chunk, ...style });
        }
      }
    });
  }
  pushWord();
  return paragraphs;
}

function measureWord(word: Word, fontSize: number, measure: MeasureFn): number {
  return word.reduce((total, fragment) => total + measure(fragment.text, fontSize, fragment.bold, fragment.italic), 0);
}

function flattenWordsToSegments(words: Word[]): StyledSegment[] {
  const segments: StyledSegment[] = [];
  const append = (fragment: { text: string; bold: boolean; italic: boolean; color: string }) => {
    const last = segments[segments.length - 1];
    if (last && last.bold === fragment.bold && last.italic === fragment.italic && last.color === fragment.color) {
      last.text += fragment.text;
    } else {
      segments.push({ ...fragment });
    }
  };

  words.forEach((word, wordIndex) => {
    if (wordIndex > 0) {
      const prevStyle = words[wordIndex - 1][words[wordIndex - 1].length - 1];
      append({ text: ' ', bold: prevStyle.bold, italic: prevStyle.italic, color: prevStyle.color });
    }
    for (const fragment of word) append(fragment);
  });
  return segments;
}

/** A word (possibly multiple styled fragments) too wide for `availableWidth`
 *  on its own: broken first between fragments, and only at the character
 *  level within a single fragment that's still too wide by itself. */
function hardBreakWord(word: Word, fontSize: number, availableWidth: number, measure: MeasureFn): Word[] {
  const pieces: Word[] = [];
  let current: Word = [];
  let currentWidth = 0;

  const pushCurrent = () => {
    if (current.length) {
      pieces.push(current);
      current = [];
      currentWidth = 0;
    }
  };

  for (const fragment of word) {
    const fragmentWidth = measure(fragment.text, fontSize, fragment.bold, fragment.italic);

    if (currentWidth + fragmentWidth <= availableWidth) {
      current.push(fragment);
      currentWidth += fragmentWidth;
      continue;
    }

    pushCurrent();

    if (fragmentWidth <= availableWidth) {
      current = [fragment];
      currentWidth = fragmentWidth;
      continue;
    }

    let charPiece = '';
    for (const char of fragment.text) {
      const withChar = charPiece + char;
      if (!charPiece || measure(withChar, fontSize, fragment.bold, fragment.italic) <= availableWidth) {
        charPiece = withChar;
      } else {
        pieces.push([{ ...fragment, text: charPiece }]);
        charPiece = char;
      }
    }
    if (charPiece) {
      current = [{ ...fragment, text: charPiece }];
      currentWidth = measure(charPiece, fontSize, fragment.bold, fragment.italic);
    }
  }
  pushCurrent();
  return pieces.length ? pieces : [word];
}

function wrapRichLines(blocks: RichTextBlock[], fontSize: number, availableWidth: number, measure: MeasureFn): StyledLine[] {
  const lines: StyledLine[] = [];
  const spaceWidth = measure(' ', fontSize, false, false);

  for (const block of blocks) {
    const bulletStyle = block.runs[0]
      ? { bold: block.runs[0].bold, italic: block.runs[0].italic, color: block.runs[0].color }
      : { bold: false, italic: false, color: '#000000' };

    for (const paragraphWords of tokenizeBlockWords(block)) {
      if (paragraphWords.length === 0) {
        lines.push({ segments: [] });
        continue;
      }

      // Glued to the first word (never allowed to wrap away from it) rather
      // than pushed as its own word, so a bullet never sits alone on a line
      // with its text wrapped below it.
      const words = paragraphWords.slice();
      if (block.bullet) {
        words[0] = [{ text: BULLET_PREFIX, ...bulletStyle }, ...words[0]];
      }

      let current: Word[] = [];
      let currentWidth = 0;
      const flush = () => {
        lines.push({ segments: flattenWordsToSegments(current) });
        current = [];
        currentWidth = 0;
      };

      for (const word of words) {
        const wordWidth = measureWord(word, fontSize, measure);
        const withWordWidth = currentWidth + (current.length ? spaceWidth : 0) + wordWidth;

        if (withWordWidth <= availableWidth) {
          current.push(word);
          currentWidth = withWordWidth;
          continue;
        }

        if (current.length) flush();

        if (wordWidth <= availableWidth) {
          current = [word];
          currentWidth = wordWidth;
          continue;
        }

        const pieces = hardBreakWord(word, fontSize, availableWidth, measure);
        pieces.forEach((piece, i) => {
          if (i > 0) flush();
          current = [piece];
          currentWidth = measureWord(piece, fontSize, measure);
        });
      }

      flush();
    }
  }

  return lines;
}

function truncateRichLineWithEllipsis(line: StyledLine, fontSize: number, availableWidth: number, measure: MeasureFn): StyledLine {
  const segments = line.segments.slice();

  while (segments.length > 0) {
    const last = segments[segments.length - 1];
    const prefixWidth = segments.slice(0, -1).reduce((w, s) => w + measure(s.text, fontSize, s.bold, s.italic), 0);
    const budget = Math.max(0, availableWidth - prefixWidth);

    if (measure(last.text + ELLIPSIS, fontSize, last.bold, last.italic) <= budget) {
      segments[segments.length - 1] = { ...last, text: last.text + ELLIPSIS };
      return { segments };
    }

    let truncated = last.text;
    while (truncated.length > 0 && measure(truncated + ELLIPSIS, fontSize, last.bold, last.italic) > budget) {
      truncated = truncated.slice(0, -1);
    }
    if (truncated) {
      segments[segments.length - 1] = { ...last, text: truncated + ELLIPSIS };
      return { segments };
    }
    segments.pop();
  }

  return { segments: [{ text: ELLIPSIS, bold: false, italic: false, color: '#000000' }] };
}
