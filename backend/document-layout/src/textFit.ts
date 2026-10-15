export interface FitTextResult {
  lines: string[];
  fontSize: number;
  lineHeight: number;
}

const LINE_HEIGHT_RATIO = 1.15;
const ELLIPSIS = '…';

/**
 * Wraps `text` to a font size and set of lines that provably fit `boxWidth` x
 * `boxHeight`: every returned line measures within the box's width at the
 * chosen font size, and the line count fits its height (shrinking the font
 * first, then truncating the last line with an ellipsis if even the smallest
 * readable size still can't fit everything). Used to size a signer's typed
 * value onto its field both in the on-screen preview and in the stamped PDF,
 * so a long answer degrades gracefully instead of spilling past the field.
 *
 * Shared by the browser preview and authoritative PDF stamp.
 */
export function fitTextToBox(
  text: string,
  boxWidth: number,
  boxHeight: number,
  maxFontSize: number,
  measure: (text: string, fontSize: number) => number,
  minFontSize = 5,
): FitTextResult {
  const availableWidth = Math.max(1, boxWidth - 8);
  const startSize = Math.max(minFontSize, maxFontSize);

  let lines = [text];
  let fontSize = minFontSize;

  for (fontSize = startSize; fontSize >= minFontSize; fontSize -= 1) {
    lines = wrapLines(text, fontSize, availableWidth, measure);
    const totalHeight = lines.length * fontSize * LINE_HEIGHT_RATIO;
    if (totalHeight <= boxHeight || fontSize === minFontSize) break;
  }

  const lineHeight = fontSize * LINE_HEIGHT_RATIO;
  const maxLines = Math.max(1, Math.floor(boxHeight / lineHeight));
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[lines.length - 1] = truncateWithEllipsis(lines[lines.length - 1], fontSize, availableWidth, measure);
  }

  return { lines, fontSize, lineHeight };
}

/** Greedy word-wrap; a single word wider than `availableWidth` on its own is broken at the character level so no line can ever exceed it. */
function wrapLines(
  text: string,
  fontSize: number,
  availableWidth: number,
  measure: (text: string, fontSize: number) => number,
): string[] {
  const lines: string[] = [];

  for (const paragraph of text.split(/\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }

    let current = '';
    for (const word of words) {
      const withWord = current ? `${current} ${word}` : word;
      if (measure(withWord, fontSize) <= availableWidth) {
        current = withWord;
        continue;
      }

      if (current) lines.push(current);
      current = '';

      if (measure(word, fontSize) <= availableWidth) {
        current = word;
        continue;
      }

      // The word alone is wider than the box: hard-break it by character.
      let piece = '';
      for (const char of word) {
        const withChar = piece + char;
        if (!piece || measure(withChar, fontSize) <= availableWidth) {
          piece = withChar;
        } else {
          lines.push(piece);
          piece = char;
        }
      }
      current = piece;
    }
    if (current) lines.push(current);
  }

  return lines;
}

function truncateWithEllipsis(
  line: string,
  fontSize: number,
  availableWidth: number,
  measure: (text: string, fontSize: number) => number,
): string {
  if (measure(line + ELLIPSIS, fontSize) <= availableWidth) return line + ELLIPSIS;

  let truncated = line;
  while (truncated.length > 0 && measure(truncated + ELLIPSIS, fontSize) > availableWidth) {
    truncated = truncated.slice(0, -1);
  }
  return truncated ? truncated + ELLIPSIS : ELLIPSIS;
}
