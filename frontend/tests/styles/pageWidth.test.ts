import { readFileSync } from 'fs';
import { join, relative } from 'path';
import { sourceFiles } from '../support/sourceScan';

/**
 * Every firm and portal page caps its content at `max-w-[1600px] mx-auto`, so
 * on a wide monitor the page sits in a centred column instead of stretching
 * cards, tables and headers across the whole screen. The client portal pages
 * once shipped as a bare `<div className="p-8">`, which looked fine on a laptop
 * and spread edge to edge on a 2560px or ultrawide display.
 *
 * This scans each page's padded root wrapper (the `<div>` a `return (` opens
 * with, whose class starts with padding) and requires a max width on it.
 */
const appRoot = join(__dirname, '../../src/app');
const scannedAreas = ['client', 'lawfirm'].map((dir) => join(appRoot, dir));

// `settings/layout.tsx` already wraps every settings page in the capped column,
// so a settings page's own padded root sits inside it and needs no cap.
const cappedByLayout = join(appRoot, 'lawfirm/[lawFirmId]/settings');

function pageFiles(dir: string): string[] {
  return sourceFiles(dir, { include: /^page\.tsx$/, skipDirs: [cappedByLayout] });
}

const ROOT_WRAPPER = /return \(\s*<div className="(p[xy]?-\d[^"]*)"/g;

function paddedRoots(): { where: string; className: string }[] {
  return scannedAreas.flatMap(pageFiles).flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return [...source.matchAll(ROOT_WRAPPER)].map((match) => ({
      where: `${relative(appRoot, file)}:${source.slice(0, match.index).split('\n').length}`,
      className: match[1],
    }));
  });
}

describe('page width', () => {
  it('finds the page wrappers it scans', () => {
    // Guards the guard: a path or regex mistake would otherwise pass vacuously.
    const roots = paddedRoots();
    expect(roots.length).toBeGreaterThan(15);
    expect(roots.some((r) => r.where.startsWith('client/lawfirm/'))).toBe(true);
  });

  it('caps every padded page wrapper with a centred max width', () => {
    const uncapped = paddedRoots()
      .filter(({ className }) => !/\bmax-w-/.test(className) || !/\bmx-auto\b/.test(className))
      .map(({ where, className }) => `${where} "${className}"`);
    expect(uncapped).toEqual([]);
  });
});
