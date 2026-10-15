import { readFileSync } from 'fs';
import { join, relative } from 'path';
import { SRC_ROOT, openingTag, sourceFiles } from '../support/sourceScan';

/**
 * Matters, clients and tasks repeatedly grow the same screens, and the copies
 * drift without any single screen looking broken: a heading class that does not
 * exist, a close button a screen reader announces as nothing, a status dot in a
 * colour the status badge next to it does not use. These guards read the source
 * the way a lint rule would and name the pattern each one forbids.
 */

const read = (file: string) => readFileSync(file, 'utf8');
const rel = (file: string) => relative(SRC_ROOT, file);
const lineOf = (source: string, index: number) => source.slice(0, index).split('\n').length;

const app = join(SRC_ROOT, 'app/lawfirm/[lawFirmId]');
const components = join(SRC_ROOT, 'components');

const DETAIL_PAGES = [
  join(app, 'matters/[matterId]/page.tsx'),
  join(app, 'tasks/[taskId]/page.tsx'),
];
const CLIENT_DETAIL = join(components, 'clientComp/ClientDetail.tsx');
const LIST_SHELLS = [
  join(components, 'matterComp/MattersGrid.tsx'),
  join(components, 'taskComp/TasksGrid.tsx'),
  join(components, 'clientComp/ClientViewGrid.tsx'),
];

/** Every screen of the three parents: their component folders and the shared tabs they render. */
const PARENT_DIRS = ['matterComp', 'taskComp', 'clientComp', 'notesComp', 'eventComp'].map((dir) => join(components, dir));
const PARENT_FILES: string[] = [
  ...PARENT_DIRS.flatMap((dir) => sourceFiles(dir, { include: /\.tsx$/ })),
  join(components, 'ui/EntityListTab.tsx'),
  ...DETAIL_PAGES,
];

describe('parent surfaces', () => {
  it('finds the files it scans', () => {
    // Guards the guard: a path mistake would otherwise pass every check vacuously.
    expect(PARENT_FILES.length).toBeGreaterThan(40);
    for (const file of [...DETAIL_PAGES, CLIENT_DETAIL, ...LIST_SHELLS]) {
      expect(read(file).length).toBeGreaterThan(0);
    }
  });

  it('uses no text size class that Tailwind does not define', () => {
    // `text-md` is not a Tailwind class, so a heading carrying it silently keeps its inherited size.
    const fake = /\btext-(md|xxs|xxl|small|medium|large|tiny)\b/g;
    const offenders = sourceFiles(SRC_ROOT, { include: /\.tsx?$/ }).flatMap((file) => {
      const source = read(file);
      return [...source.matchAll(fake)].map((m) => `${rel(file)}:${lineOf(source, m.index ?? 0)} ${m[0]}`);
    });
    expect(offenders).toEqual([]);
  });

  it('names every icon-only button', () => {
    // An icon with no text inside a bare <button> is announced as "button". Needs aria-label.
    const offenders = PARENT_FILES.flatMap((file) => {
      const source = read(file);
      return [...source.matchAll(/<button\b/g)].flatMap((match) => {
        const open = openingTag(source, match.index ?? 0);
        if (!open || open.tag.includes('aria-label') || open.tag.includes('aria-labelledby')) return [];
        const close = source.indexOf('</button>', open.end);
        if (close === -1) return [];
        const body = source.slice(open.end, close).trim();
        const iconOnly = /^<[A-Z][A-Za-z0-9]*\b[^>]*\/>$/.test(body);
        return iconOnly ? [`${rel(file)}:${lineOf(source, match.index ?? 0)}`] : [];
      });
    });
    expect(offenders).toEqual([]);
  });

  it('draws status dots from statusMeta, not a hard-coded colour', () => {
    // The status badge beside a dot uses statusMeta; a literal bg-green-500 drifts from it (green vs emerald).
    // Checked per class string so the order of the classes does not matter.
    const classStrings = /className=(?:"([^"]*)"|\{`([^`]*)`\})/g;
    const isDot = (cls: string) =>
      /\brounded-full\b/.test(cls)
      && /\bw-(?:1\.5|2|2\.5)\b/.test(cls)
      && /\bh-(?:1\.5|2|2\.5)\b/.test(cls)
      && /\bbg-(?:blue|purple|green|emerald|red|amber|orange|yellow)-[45]00\b/.test(cls);
    const offenders = PARENT_FILES.flatMap((file) => {
      const source = read(file);
      return [...source.matchAll(classStrings)]
        .filter((m) => isDot(m[1] ?? m[2] ?? ''))
        .map((m) => `${rel(file)}:${lineOf(source, m.index ?? 0)}`);
    });
    expect(offenders).toEqual([]);
  });

  it('wraps every detail page and list shell in the exemplar page wrapper', () => {
    const detailWrapper = ['p-4', 'pl-5', 'pt-10', 'md:p-6', 'md:pt-14', 'max-w-[1600px]', 'mx-auto', 'space-y-6', 'min-w-0'];
    const listWrapper = ['p-4', 'pl-5', 'md:p-6', 'max-w-[1600px]', 'mx-auto', 'space-y-6', 'min-w-0'];
    // A page returns early for its loading and error states with a plainer wrapper, so the
    // page passes when ANY of its wrappers carries every class; report the closest one.
    const wrappersOf = (file: string) =>
      [...read(file).matchAll(/<div className="min-h-screen bg-page">\s*<div className="([^"]+)"/g)]
        .map((m) => m[1].split(/\s+/));
    const closest = (file: string, need: string[]) => {
      const all = wrappersOf(file);
      return all.sort((a, b) => need.filter((c) => b.includes(c)).length - need.filter((c) => a.includes(c)).length)[0] ?? [];
    };
    const missing = [
      ...[...DETAIL_PAGES, CLIENT_DETAIL].map((file) => ({ file, need: detailWrapper })),
      ...LIST_SHELLS.map((file) => ({ file, need: listWrapper })),
    ].flatMap(({ file, need }) => {
      const have = closest(file, need);
      return have.length === 0
        ? [`${rel(file)}: no "min-h-screen bg-page" wrapper found`]
        : need.filter((cls) => !have.includes(cls)).map((cls) => `${rel(file)}: wrapper lacks ${cls}`);
    });
    expect(missing).toEqual([]);
  });

  it('builds the matter, task and client detail headers from PageHeader', () => {
    const offenders = [...DETAIL_PAGES, CLIENT_DETAIL].flatMap((file) => {
      const source = read(file);
      const problems: string[] = [];
      if (!/<PageHeader\b/.test(source)) problems.push(`${rel(file)}: does not render <PageHeader>`);
      const h1 = source.match(/<h1\b/);
      if (h1) problems.push(`${rel(file)}:${lineOf(source, h1.index ?? 0)} hand-rolls an <h1>`);
      return problems;
    });
    expect(offenders).toEqual([]);
  });

  it('does not restyle a <Button> through className', () => {
    // Layout classes (w-full, mt-4, hidden at a breakpoint) are fine; the button owns its own look.
    const restyle = /(?:^|\s)(?:[a-z]+:)*(?:p[xytblr]?-\d|text-(?:xs|sm|base|lg)|rounded(?:-\w+)?|bg-\S+|border(?:-\S+)?)(?=\s|$)/;
    const offenders = PARENT_FILES.flatMap((file) => {
      const source = read(file);
      return [...source.matchAll(/<Button\b/g)].flatMap((match) => {
        const open = openingTag(source, match.index ?? 0);
        const cls = open?.tag.match(/className="([^"]*)"/)?.[1];
        return cls && restyle.test(cls) ? [`${rel(file)}:${lineOf(source, match.index ?? 0)} className="${cls}"`] : [];
      });
    });
    expect(offenders).toEqual([]);
  });

  it('keeps inline <svg> icons from spreading', () => {
    // Ratchet: icons are lucide-react. The count only goes down; lower SVG_BUDGET when one is converted.
    const SVG_BUDGET = 13;
    const count = PARENT_FILES.reduce((n, file) => n + (read(file).match(/<svg\b/g)?.length ?? 0), 0);
    expect(count).toBeLessThanOrEqual(SVG_BUDGET);
  });

  it('writes a required marker as " *" after the label text', () => {
    const offenders = PARENT_FILES.flatMap((file) => {
      const source = read(file);
      return [...source.matchAll(/<(?:FieldLabel|label)\b[^>]*>\s*([^<{]*\S)\*\s*<\//g)]
        .map((m) => `${rel(file)}:${lineOf(source, m.index ?? 0)} "${m[1]}*"`);
    });
    expect(offenders).toEqual([]);
  });
});
