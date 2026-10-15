import { readFileSync } from 'fs';
import { join, relative } from 'path';
import { openingTag, sourceFiles } from '../support/sourceScan';

/**
 * A `<Modal>` draws its own header bar (title and close button) unless the
 * caller passes `showClose={false}` and no `title`. A dialog that opts out of
 * the standard body with `bodyClassName={null}` and then builds its OWN header
 * must therefore also pass `showClose={false}`, or better, hand its heading to
 * `title` and drop the hand-built one.
 *
 * Forgetting that renders two headers: an empty bar holding only a close button,
 * and the dialog's real header underneath it, often with a second close button.
 * Four dialogs shipped that way (the deadline set editor, apply deadline set,
 * bulk assign and the intake form preview). This scans every `<Modal>` so the
 * next one fails here rather than on screen.
 */
const root = join(__dirname, '../../src');

function doubleHeaders(): string[] {
  const offenders: string[] = [];
  for (const file of sourceFiles(root, { include: /\.tsx$/ })) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/<Modal\b/g)) {
      const open = openingTag(source, match.index ?? 0);
      if (!open || !open.tag.includes('bodyClassName={null}')) continue;
      if (/\btitle=/.test(open.tag) || open.tag.includes('showClose={false}')) continue;
      // The dialog's own first markup: a heading inside it means a second header.
      const firstChildren = source.slice(open.end, open.end + 700);
      if (/<h[23]\b/.test(firstChildren)) {
        const line = source.slice(0, match.index).split('\n').length;
        offenders.push(`${relative(root, file)}:${line}`);
      }
    }
  }
  return offenders;
}

describe('modal headers', () => {
  it('finds the dialogs it scans', () => {
    // Guards the guard: a path or parsing mistake would otherwise pass vacuously.
    const withNullBody = sourceFiles(root, { include: /\.tsx$/ }).filter((f) => readFileSync(f, 'utf8').includes('bodyClassName={null}'));
    expect(withNullBody.length).toBeGreaterThan(20);
  });

  it('never stacks a hand-built header under the default close bar', () => {
    expect(doubleHeaders()).toEqual([]);
  });
});
