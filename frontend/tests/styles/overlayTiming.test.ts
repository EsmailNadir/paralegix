import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `useMountTransition` holds an overlay mounted for a fixed number of
 * milliseconds so its exit animation can finish. That number has to match the
 * CSS, and nothing enforced it: the hook's default said 200ms while the card
 * and backdrop exits run for 100ms, so a closed dialog sat mounted and
 * invisible for an extra 100ms, holding its scroll lock and its focus trap.
 *
 * This reads both sides. Change one without the other and it fails.
 */
const root = join(__dirname, '../../src');
const CSS = readFileSync(join(root, 'styles/global.css'), 'utf8');

/** Seconds declared for an `overlay-*` animation class, in milliseconds. */
function animationMs(className: string): number {
  const rule = new RegExp(`\\.${className}\\s*\\{[^}]*animation:[^;]*?([\\d.]+)s`).exec(CSS);
  if (!rule) throw new Error(`no animation duration found for .${className}`);
  return Math.round(parseFloat(rule[1]) * 1000);
}

/** Every `useMountTransition(x, n)` duration in a file. */
function durations(file: string): number[] {
  const source = readFileSync(join(root, file), 'utf8');
  return [...source.matchAll(/useMountTransition\([^,)]+,\s*(\d+)\)/g)].map((m) => Number(m[1]));
}

describe('overlay exit timing', () => {
  const cardExit = animationMs('overlay-card-exit');
  const backdropExit = animationMs('overlay-backdrop-exit');
  const menuExit = animationMs('overlay-menu-exit');

  it('reads the durations the stylesheet actually declares', () => {
    expect(cardExit).toBe(100);
    expect(backdropExit).toBe(100);
    expect(menuExit).toBe(150);
  });

  it('keeps the hook default on the card exit, not above it', () => {
    const hook = readFileSync(join(root, 'hooks/useMountTransition.ts'), 'utf8');
    const fallback = /durationMs\s*=\s*(\d+)/.exec(hook);
    expect(fallback).not.toBeNull();
    expect(Number(fallback![1])).toBe(cardExit);
  });

  it.each([
    'components/ui/Modal.tsx',
    'components/billingComp/TimeEntryModal.tsx',
  ])('holds %s mounted for exactly the card exit', (file) => {
    const found = durations(file);
    expect(found.length).toBeGreaterThan(0);
    // Nested dialogs in the same file share the shape, so every value is a
    // card exit. A menu in one of these would be the exception to add here.
    for (const ms of found) expect(ms).toBe(cardExit);
  });

  it('holds the cookie banner mounted for exactly its slide-away', () => {
    expect(durations('components/ui/CookieNotice.tsx')).toEqual([animationMs('cookie-banner-exit')]);
  });

  it('documents the real durations in transitionClasses', () => {
    const doc = readFileSync(join(root, 'components/ui/transitionClasses.ts'), 'utf8');
    expect(doc).not.toContain('200ms');
    expect(doc).toContain(`${cardExit}ms`);
    expect(doc).toContain(`${menuExit}ms`);
  });
});
