/**
 * The stacked page a pointer event landed on, and the element to measure against.
 *
 * With every page mounted at once, the page number can no longer be read from a
 * `currentPage` prop - it has to come from where the pointer actually is. Each page
 * tags itself with `data-pdf-page`, so this is a `closest()` walk rather than
 * hit-testing rectangles.
 *
 * Returns null for a target inside an existing annotation: that is a drag of the
 * annotation, not the placement of a new field.
 */
export function pageFromPointerTarget(
  target: HTMLElement
): { pageNumber: number; element: HTMLElement } | null {
  if (target.closest('[data-annotation]')) return null;

  const element = target.closest<HTMLElement>('[data-pdf-page]');
  if (!element) return null;

  const pageNumber = Number(element.dataset.pdfPage);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) return null;

  return { pageNumber, element };
}

/**
 * The stacked page whose box contains a viewport point, if any.
 *
 * Used at the END of an overlay drag to see which page the pointer was released
 * over. `pageFromPointerTarget` cannot answer this: mid-drag the events all target
 * the dragged overlay itself, so the page has to be found by geometry. A point in
 * the gap between pages (or off the stack entirely) returns null, and the drop
 * falls back to staying on its own page.
 */
export function pageFromPoint(
  clientX: number,
  clientY: number
): { pageNumber: number; element: HTMLElement } | null {
  const pages = document.querySelectorAll<HTMLElement>('[data-pdf-page]');
  for (const element of pages) {
    const rect = element.getBoundingClientRect();
    if (
      clientX >= rect.left && clientX <= rect.right &&
      clientY >= rect.top && clientY <= rect.bottom
    ) {
      const pageNumber = Number(element.dataset.pdfPage);
      if (Number.isInteger(pageNumber) && pageNumber >= 1) return { pageNumber, element };
    }
  }
  return null;
}
