import { readFileSync } from 'fs';
import { join } from 'path';
import { sourceFiles } from '../support/sourceScan';

/**
 * The number spinner is off for the whole app, from one rule.
 *
 * It used to be off per input, spelled as three Tailwind classes copied to 22
 * of the 83 number fields. The other 61 kept the spinner, so clicking into an
 * amount made the field reflow under the cursor while an identical field two
 * screens away did not. Which fields had the classes was an accident of who
 * wrote them.
 *
 * So the classes are a bug now, not a preference: a call site that spells them
 * again is restating the global rule locally, and the next one to differ starts
 * the split over. This walks the source for them and reads the rule back.
 *
 * jsdom applies no stylesheet, so the rule is read rather than rendered. It goes
 * red if the rule is deleted, renamed, or narrowed to one browser.
 */
const SRC = join(__dirname, '../../src');
const CSS = readFileSync(join(SRC, 'styles/global.css'), 'utf8');

/** The three classes the global rule replaced, in the spelling they were used. */
const LOCAL_SPINNER = /\[appearance:textfield\]|\[&::-webkit-(?:inner|outer)-spin-button\]:/g;

/** Rules whose selector targets a number input, comments stripped. */
const numberRules = [...CSS.matchAll(/([^{}]*)\{([^}]*)\}/g)]
  .map(([, selector, body]) => ({
    selector: selector.replace(/\/\*[\s\S]*?\*\//g, '').trim(),
    body,
  }))
  .filter(({ selector }) => selector.includes('input[type="number"]'));

describe('the number spinner is off app-wide, from one rule', () => {
  const files = sourceFiles(SRC);

  it('finds the source tree, so an empty pass cannot look like a clean one', () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it('has no component turning the spinner off on its own input', () => {
    const hits: string[] = [];
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(LOCAL_SPINNER)) {
        hits.push(`${file.slice(SRC.length + 1)}: ${match[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('turns it off for every number input, not for a subset', () => {
    // A selector narrowed to a class or an ancestor is the split coming back.
    const selectors = numberRules.flatMap(({ selector }) =>
      selector.split(',').map((part) => part.trim()),
    );
    expect(selectors).toEqual([
      'input[type="number"]',
      'input[type="number"]::-webkit-inner-spin-button',
      'input[type="number"]::-webkit-outer-spin-button',
    ]);
  });

  it('drops the Firefox and standard spinner', () => {
    const base = numberRules.find(({ selector }) => !selector.includes('::'));
    expect(base?.body).toMatch(/appearance:\s*textfield/);
  });

  it('drops the WebKit spinner, and the margin it reserves', () => {
    const webkit = numberRules.find(({ selector }) => selector.includes('::-webkit-'));
    expect(webkit?.body).toMatch(/appearance:\s*none/);
    // The spinner reserves its own margin, which survives `appearance: none`.
    expect(webkit?.body).toMatch(/margin:\s*0/);
  });
});
