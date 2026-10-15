import axe, { type AxeResults } from 'axe-core';

/** DOM checks supplement keyboard tests; jsdom cannot measure visual contrast or layout. */
export function scanAccessibility(container: HTMLElement): Promise<AxeResults> {
  return axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    rules: { 'color-contrast': { enabled: false } },
  });
}
