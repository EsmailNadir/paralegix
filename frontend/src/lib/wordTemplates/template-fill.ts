/**
 * Shared template-filling utilities used by both FillTemplateModal and
 * the TemplateEditor (when it is opened in "edit from fill" mode).
 */

import { injectTemplateAssetSources } from "./template-image-objects";

export type TemplateFillValues = Record<string, string>;
export type RepeaterRowValues = Record<string, string>;

const EDITOR_ZERO_WIDTH_SPACE = /\u200B/g;

// ---------------------------------------------------------------------------
// Paragraph splitting helpers (used when a repeater pushes content past the
// page boundary, we split the straddling paragraph rather than jumping the
// whole block to the next page, which would leave a large gap on page 1).
// ---------------------------------------------------------------------------

/** Return the character index of the word boundary nearest to targetIdx. */
function findWordBoundaryNear(text: string, targetIdx: number): number {
  if (targetIdx <= 0 || targetIdx >= text.length) return targetIdx;
  // Scan left for the nearest space
  let leftPos = -1;
  for (let i = targetIdx - 1; i >= 0; i--) {
    if (text[i] === " ") { leftPos = i + 1; break; }
  }
  // Scan right for the nearest space
  let rightPos = -1;
  for (let i = targetIdx; i < text.length; i++) {
    if (text[i] === " ") { rightPos = i + 1; break; }
  }
  if (leftPos < 0 && rightPos < 0) return targetIdx;
  if (leftPos < 0) return rightPos;
  if (rightPos < 0) return leftPos;
  return (targetIdx - leftPos) <= (rightPos - targetIdx) ? leftPos : rightPos;
}

function removeNodeCleanAncestors(node: Node, root: HTMLElement): void {
  let ancestor: Node | null = node.parentNode;
  ancestor?.removeChild(node);
  while (ancestor && ancestor !== root) {
    if ((ancestor as Element).childNodes.length === 0) {
      const grandparent = ancestor.parentNode;
      grandparent?.removeChild(ancestor);
      ancestor = grandparent;
    } else {
      break;
    }
  }
}

/** Collect all text nodes, then remove/truncate those past charLimit. */
function trimTextNodesAfter(root: HTMLElement, charLimit: number): void {
  const d = root.ownerDocument ?? document;
  const walker = d.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) textNodes.push(n as Text);
  let remaining = charLimit;
  for (const t of textNodes) {
    if (remaining <= 0) { removeNodeCleanAncestors(t, root); continue; }
    if (remaining < t.length) { t.data = t.data.slice(0, remaining); remaining = 0; continue; }
    remaining -= t.length;
  }
}

/** Collect all text nodes, then remove/truncate those before charLimit. */
function trimTextNodesBefore(root: HTMLElement, charLimit: number): void {
  const d = root.ownerDocument ?? document;
  const walker = d.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) textNodes.push(n as Text);
  let remaining = charLimit;
  for (const t of textNodes) {
    if (remaining <= 0) break;
    if (remaining < t.length) { t.data = t.data.slice(remaining); remaining = 0; break; }
    removeNodeCleanAncestors(t, root);
    remaining -= t.length;
  }
}

/**
 * Split a `<p>` element at approximately `fittingFraction` of its text content
 * (by character count, adjusted to a word boundary).  Returns {head, tail} clones
 * or null when splitting is not feasible.
 */
function splitParagraphAtFraction(
  el: HTMLElement,
  fittingFraction: number,
): { head: HTMLElement; tail: HTMLElement } | null {
  if (fittingFraction <= 0.05 || fittingFraction >= 1) return null;
  const fullText = el.textContent ?? "";
  if (!fullText.trim() || fullText.length < 5) return null;
  const approxIdx = Math.round(fittingFraction * fullText.length);
  const splitIdx = findWordBoundaryNear(fullText, approxIdx);
  if (splitIdx <= 0 || splitIdx >= fullText.length) return null;
  const head = el.cloneNode(true) as HTMLElement;
  const tail = el.cloneNode(true) as HTMLElement;
  trimTextNodesAfter(head, splitIdx);
  trimTextNodesBefore(tail, splitIdx);
  if (!(head.textContent ?? "").trim() || !(tail.textContent ?? "").trim()) return null;
  return { head, tail };
}

function stripEditorZeroWidthSpaces(root: ParentNode) {
  const doc = root.ownerDocument ?? document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const emptyTextNodes: Text[] = [];
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    if (!node.data.includes("\u200B")) continue;
    node.data = node.data.replace(EDITOR_ZERO_WIDTH_SPACE, "");
    if (!node.data) emptyTextNodes.push(node);
  }
  emptyTextNodes.forEach((textNode) => textNode.remove());
}

function replaceChipWithStyledText(chip: Element, text: string, doc: Document) {
  const el = chip as HTMLElement;
  const parent = el.parentNode;
  if (!parent) return;
  const span = doc.createElement("span");
  span.textContent = text;
  const fontFamily = el.style.fontFamily;
  const fontSize = el.style.fontSize;
  const fontWeight = el.style.fontWeight;
  const fontStyle = el.style.fontStyle;
  const color = el.style.color;
  if (fontFamily) span.style.fontFamily = fontFamily;
  if (fontSize) span.style.fontSize = fontSize;
  if (fontWeight && fontWeight !== "inherit") span.style.fontWeight = fontWeight;
  if (fontStyle && fontStyle !== "inherit") span.style.fontStyle = fontStyle;
  if (color && color !== "inherit") span.style.color = color;
  // insertBefore + removeChild is more reliable than replaceWith in DOMParser documents.
  parent.insertBefore(span, el);
  parent.removeChild(el);
}

export function buildFilledTemplateHtml(
  html: string,
  values: TemplateFillValues,
  repeaterRows: Record<string, RepeaterRowValues[]> = {},
): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  stripEditorZeroWidthSpaces(doc.body);

  // 1. Handle repeater blocks, clone paragraphs for each data row
  const processedRepeaters = new Set<string>();
  doc.querySelectorAll<HTMLElement>("[data-repeater]").forEach((repeaterP) => {
    const repeaterName = repeaterP.getAttribute("data-repeater") ?? "";
    if (!repeaterName || processedRepeaters.has(repeaterName)) return;
    processedRepeaters.add(repeaterName);

    const allTemplatePs = Array.from(
      doc.querySelectorAll<HTMLElement>(`[data-repeater="${repeaterName}"]`)
    );
    const rows = repeaterRows[repeaterName];
    if (!rows || rows.length === 0) {
      allTemplatePs.forEach((p) => p.remove());
      return;
    }

    // Calculate the vertical extent of the template block
    let blockTop = Infinity;
    let blockBottom = -Infinity;
    for (const p of allTemplatePs) {
      const pTop = parseFloat(p.style.top || p.dataset?.baseTop || "0");
      const rawBaseH = parseFloat(p.dataset?.baseHeight ?? "");
      const rawFontSize = parseFloat(p.style.fontSize || "12");
      const rawLineH = parseFloat(p.style.lineHeight ?? "");
      const lineHMultiplier = Number.isFinite(rawLineH) && rawLineH > 0 ? rawLineH : 1.2;
      const pHeight = (Number.isFinite(rawBaseH) && rawBaseH > 0)
        ? rawBaseH
        : (Number.isFinite(rawFontSize) && rawFontSize > 0 ? rawFontSize * lineHMultiplier : 20);
      blockTop = Math.min(blockTop, pTop);
      blockBottom = Math.max(blockBottom, pTop + pHeight);
    }
    const blockHeight = blockBottom - blockTop;

    const parent = allTemplatePs[0]?.parentNode as HTMLElement | null;
    if (!parent) return;

    // Row stride is the actual height of the repeater template block, each
    // cloned row occupies exactly this much vertical space.  Do NOT use the
    // distance to the next sibling element (that includes the gap between the
    // repeater and following content, which would incorrectly space out rows).
    let rowStride = blockHeight;
    const allSiblingPs = Array.from(parent.querySelectorAll<HTMLElement>(":scope > p"));
    if (!Number.isFinite(rowStride) || rowStride < 1) rowStride = 30;

    const insertBefore = allTemplatePs[0];
    const insertedClones: HTMLElement[] = [];

    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const rowValues = rows[rowIdx];
      for (const templateP of allTemplatePs) {
        const clone = templateP.cloneNode(true) as HTMLElement;
        clone.removeAttribute("data-repeater");
        // Each row is an independent paragraph, clear flow-group so the editor
        // does not merge sibling clones into one block during normalisation.
        delete clone.dataset.flowGroup;
        delete clone.dataset.logicalParagraphId;
        delete clone.dataset.paragraphId;
        delete clone.dataset.wrapEnabled;

        const origTop = parseFloat(clone.style.top || clone.dataset?.baseTop || "0");
        const newTop = origTop + rowIdx * rowStride;
        if (Number.isFinite(newTop)) {
          clone.style.top = `${newTop}px`;
          if (clone.dataset?.baseTop) clone.dataset.baseTop = String(newTop);
        }

        clone.querySelectorAll("[data-placeholder-chip]").forEach((chip) => {
          const fullName = chip.getAttribute("data-placeholder-chip") ?? "";
          const subField = fullName.startsWith(repeaterName + ".")
            ? fullName.slice(repeaterName.length + 1)
            : fullName;
          const val = rowValues[subField] ?? values[fullName] ?? `{${fullName}}`;
          replaceChipWithStyledText(chip, val.replace(EDITOR_ZERO_WIDTH_SPACE, ""), doc);
        });
        insertedClones.push(clone);
        parent.insertBefore(clone, insertBefore);
      }
    }

    allTemplatePs.forEach((p) => p.remove());

    const extraHeight = (rows.length - 1) * rowStride;
    if (extraHeight > 0 && Number.isFinite(extraHeight)) {
      for (const p of allSiblingPs) {
        if (allTemplatePs.includes(p)) continue;
        const pTop = parseFloat(p.style.top || "0");
        if (pTop >= blockBottom) {
          const shifted = pTop + extraHeight;
          p.style.top = `${shifted}px`;
          if (p.dataset?.baseTop) p.dataset.baseTop = String(shifted);
        }
      }
      parent.querySelectorAll<HTMLElement>(
        "[data-template-image-object-id], [data-template-text-box-id]"
      ).forEach((el) => {
        if (el.dataset.templateImagePinned === "true") return;
        if (el.dataset.templateImageBehindText === "true") return;
        const elTop = parseFloat(el.style.top || "0");
        if (elTop >= blockBottom) {
          el.style.top = `${elTop + extraHeight}px`;
        }
      });

      const originalMinHeight =
        parseFloat(parent.dataset.baseMinHeight || parent.style.minHeight || "0");
      const rawContentBottom = parseFloat(parent.dataset.baseContentBottom || "");
      const contentBottom =
        rawContentBottom > 0
          ? rawContentBottom
          : originalMinHeight > 0
            ? Math.min(originalMinHeight - 96, originalMinHeight * 0.92)
            : 0;

      let nextPage: HTMLElement | null = null;
      let sibling = parent.nextElementSibling as HTMLElement | null;
      while (sibling) {
        if (sibling.classList.contains("pdf-page")) { nextPage = sibling; break; }
        sibling = sibling.nextElementSibling as HTMLElement | null;
      }

      const allPageChildren = Array.from(
        parent.querySelectorAll<HTMLElement>(
          ":scope > p, [data-template-image-object-id], [data-template-text-box-id]"
        )
      ).filter((el) =>
        !insertedClones.includes(el) &&
        el.dataset.templateImagePinned !== "true" &&
        el.dataset.templateImageBehindText !== "true"
      );

      const elH = (el: HTMLElement) =>
        parseFloat(el.dataset?.baseHeight ?? "") ||
        parseFloat(el.style.height || "") ||
        20;

      // Fill blank space on page 1 that the repeater expansion left behind, avoiding
      // the "huge gap then paragraph starts fresh on page 2" problem.
      //
      // There are two sub-cases for a <p> that was originally on page 1
      // (preShiftTop < contentBottom) but now overflows:
      //
      //   Case A – straddles the boundary (elTop < contentBottom): the paragraph
      //            starts on page 1 but its bottom extends past it.  Split it and
      //            keep the head on page 1.
      //
      //   Case B – fully past the boundary (elTop >= contentBottom): the paragraph
      //            was pushed entirely off page 1.  If blank space remains below the
      //            repeater block, reposition the paragraph there; if it still
      //            doesn't fit entirely, split it.
      if (contentBottom > 0 && originalMinHeight > 0) {
        // ── Case A: straddling (reverse pass so splicing is safe) ──────────
        for (let ci = allPageChildren.length - 1; ci >= 0; ci--) {
          const el = allPageChildren[ci];
          if (el.tagName !== "P") continue;
          const elTop = parseFloat(el.style.top || "0");
          const height = elH(el);
          const preShiftTop = elTop - extraHeight;
          if (preShiftTop >= contentBottom) continue;          // was already off-page
          if (elTop >= contentBottom) continue;                // fully off-page (Case B)
          if (elTop + height <= contentBottom) continue;       // fits entirely: no action

          const availableH = contentBottom - elTop;
          const split = splitParagraphAtFraction(el, availableH / height);
          if (!split) continue;

          const { head, tail } = split;
          head.style.top = el.style.top;
          if (el.dataset.baseTop) head.dataset.baseTop = el.dataset.baseTop;
          head.dataset.baseHeight = String(Math.round(availableH));

          const tailH = Math.max(20, Math.round(height - availableH));
          tail.style.top = `${contentBottom + 1}px`;
          tail.dataset.baseTop = String(contentBottom + 1);
          tail.dataset.baseHeight = String(tailH);
          tail.dataset.splitTail = "1"; // prevent Case B from touching this

          el.parentNode?.insertBefore(head, el);
          el.parentNode?.insertBefore(tail, el);
          el.parentNode?.removeChild(el);
          allPageChildren.splice(ci, 1, head, tail);
        }

        // ── Case B: fully off-page (forward pass, topmost element first) ──
        // Compute the bottom edge of the repeater content after expansion.
        const repeaterEnd = blockBottom + extraHeight;
        let blankSpace = contentBottom - repeaterEnd;

        if (blankSpace >= 15) {
          for (let ci = 0; ci < allPageChildren.length && blankSpace > 0; ci++) {
            const el = allPageChildren[ci];
            if (el.tagName !== "P") continue;
            if (el.dataset.splitTail) continue;          // tail from Case A: skip
            const elTop = parseFloat(el.style.top || "0");
            if (elTop < contentBottom) continue;         // on-page or straddling: skip
            const preShiftTop = elTop - extraHeight;
            if (preShiftTop >= contentBottom) continue;  // was already off-page before shift

            const height = elH(el);
            // newTop: start right where the remaining blank space begins
            const newTop = contentBottom - blankSpace;
            const fittingFraction = blankSpace / height;

            if (blankSpace >= height) {
              // Entire paragraph fits in the blank space, just reposition it.
              el.style.top = `${newTop}px`;
              el.dataset.baseTop = String(newTop);
              blankSpace -= height;
              continue;
            }

            if (fittingFraction < 0.05) break; // barely anything fits: not worth it

            const split = splitParagraphAtFraction(el, fittingFraction);
            if (!split) break;

            const { head, tail } = split;
            head.style.top = `${newTop}px`;
            head.dataset.baseTop = String(newTop);
            head.dataset.baseHeight = String(Math.round(blankSpace));

            const tailH = Math.max(20, Math.round(height - blankSpace));
            tail.style.top = `${contentBottom + 1}px`;
            tail.dataset.baseTop = String(contentBottom + 1);
            tail.dataset.baseHeight = String(tailH);

            el.parentNode?.insertBefore(head, el);
            el.parentNode?.insertBefore(tail, el);
            el.parentNode?.removeChild(el);
            allPageChildren.splice(ci, 1, head, tail);

            blankSpace = 0; // blank space is now consumed
          }
        }
      }

      const overflowEls = contentBottom > 0 && originalMinHeight > 0
        ? allPageChildren.filter((el) => {
            const elTop = parseFloat(el.style.top || "0");
            const preShiftTop = elTop - extraHeight;
            const overflowThreshold = preShiftTop >= contentBottom ? originalMinHeight : contentBottom;
            return elTop + elH(el) > overflowThreshold;
          })
        : [];

      const pageMinH = (pg: HTMLElement) =>
        parseFloat(pg.dataset.baseMinHeight || pg.style.minHeight || "0");
      const pageCB = (pg: HTMLElement) => {
        const raw = parseFloat(pg.dataset.baseContentBottom || "");
        const h = pageMinH(pg);
        return raw > 0 ? raw : h > 0 ? Math.min(h - 96, h * 0.92) : 0;
      };
      const moveOverflow = (
        sourceEls: HTMLElement[],
        sourcePgH: number,
        destPage: HTMLElement,
      ) => {
        if (sourceEls.length === 0) return 0;
        const destContentTop = parseFloat(destPage.dataset.baseContentTop ?? "") || 72;
        const rawTops = sourceEls.map((el) => parseFloat(el.style.top || "0") - sourcePgH);
        const rawMinTop = Math.min(...rawTops);
        const topShift = destContentTop - rawMinTop;
        const overflowBottom = sourceEls.reduce((max, el) => {
          const t = parseFloat(el.style.top || "0");
          return Math.max(max, (t - sourcePgH + topShift) + elH(el));
        }, 0);
        destPage.querySelectorAll<HTMLElement>(
          ":scope > p, [data-template-image-object-id], [data-template-text-box-id]"
        ).forEach((el) => {
          if (el.dataset.templateImagePinned === "true") return;
          if (el.dataset.templateImageBehindText === "true") return;
          const t = parseFloat(el.style.top || "0");
          el.style.top = `${t + overflowBottom}px`;
          if (el.dataset?.baseTop) el.dataset.baseTop = String(t + overflowBottom);
        });
        for (const el of sourceEls) {
          const origTop2 = parseFloat(el.style.top || "0");
          const newTop2 = origTop2 - sourcePgH + topShift;
          el.style.top = `${newTop2}px`;
          if (el.dataset?.baseTop) el.dataset.baseTop = String(newTop2);
          destPage.appendChild(el);
        }
        return overflowBottom;
      };

      if (overflowEls.length > 0) {
        const createNewPage = (templatePage: HTMLElement): HTMLElement => {
          const newPage = doc.createElement("div");
          newPage.className = templatePage.className;
          newPage.style.cssText = templatePage.style.cssText;
          if (templatePage.dataset.baseContentTop) newPage.dataset.baseContentTop = templatePage.dataset.baseContentTop;
          if (templatePage.dataset.baseContentBottom) newPage.dataset.baseContentBottom = templatePage.dataset.baseContentBottom;
          if (templatePage.dataset.baseMinHeight) newPage.dataset.baseMinHeight = templatePage.dataset.baseMinHeight;
          templatePage.querySelectorAll<HTMLElement>(
            "img.pdf-page-background, [data-template-image-pinned='true'], [data-template-image-behind-text='true']"
          ).forEach((bgEl) => newPage.appendChild(bgEl.cloneNode(true)));
          return newPage;
        };

        let destPage = nextPage;
        if (!destPage) {
          destPage = createNewPage(parent);
          parent.insertAdjacentElement("afterend", destPage);
        }

        const affectedPages: HTMLElement[] = [destPage];
        moveOverflow(overflowEls, originalMinHeight, destPage);

        let cascadeSource = destPage;
        for (let depth = 0; depth < 20; depth++) {
          const srcMinH = pageMinH(cascadeSource);
          const srcCB = pageCB(cascadeSource);
          if (srcMinH <= 0 || srcCB <= 0) break;

          const movable = Array.from(
            cascadeSource.querySelectorAll<HTMLElement>(
              ":scope > p, [data-template-image-object-id], [data-template-text-box-id]"
            )
          ).filter((el) =>
            el.dataset.templateImagePinned !== "true" &&
            el.dataset.templateImageBehindText !== "true"
          );
          const toMove = movable.filter((el) => {
            const t = parseFloat(el.style.top || "0");
            return t + elH(el) > srcCB;
          });
          if (toMove.length === 0) break;

          let cascadeNextPage: HTMLElement | null = null;
          let sib = cascadeSource.nextElementSibling as HTMLElement | null;
          while (sib) {
            if (sib.classList.contains("pdf-page")) { cascadeNextPage = sib; break; }
            sib = sib.nextElementSibling as HTMLElement | null;
          }
          if (!cascadeNextPage) {
            cascadeNextPage = createNewPage(cascadeSource);
            cascadeSource.insertAdjacentElement("afterend", cascadeNextPage);
          }

          affectedPages.push(cascadeNextPage);
          moveOverflow(toMove, srcMinH, cascadeNextPage);
          cascadeSource = cascadeNextPage;
        }

        for (const pg of affectedPages) {
          const origMinH = pageMinH(pg);
          if (origMinH > 0) pg.style.minHeight = `${origMinH}px`;
        }
      }
    }
  });

  // 2. Replace remaining (non-repeater) placeholder chips. A field with no
  // value prints as a gap, as it does in a Word template (the docx fill's
  // nullGetter returns ""), never as its literal {tag}.
  doc.querySelectorAll("[data-placeholder-chip]").forEach((chip) => {
    const name = chip.getAttribute("data-placeholder-chip") ?? "";
    const replacementText = (values[name] ?? "").replace(EDITOR_ZERO_WIDTH_SPACE, "");
    replaceChipWithStyledText(chip, replacementText, doc);
  });

  // 3. Final cleanup, remove × buttons / labels, then unwrap any chips still present
  doc.querySelectorAll("[data-chip-remove]").forEach((el) => el.remove());
  doc.querySelectorAll("[data-repeater-label]").forEach((el) => el.remove());
  doc.querySelectorAll<HTMLElement>("[data-placeholder-chip]").forEach((chip) => {
    const chipParent = chip.parentNode;
    if (!chipParent) return;
    const span = doc.createElement("span");
    const labelChild = Array.from(chip.children).find(
      (c) => !c.hasAttribute("data-chip-remove")
    ) as HTMLElement | undefined;
    span.textContent = labelChild?.textContent ?? chip.textContent ?? "";
    if (chip.style.fontFamily) span.style.fontFamily = chip.style.fontFamily;
    if (chip.style.fontSize) span.style.fontSize = chip.style.fontSize;
    chipParent.insertBefore(span, chip);
    chipParent.removeChild(chip);
  });

  doc.body.normalize();
  stripEditorZeroWidthSpaces(doc.body);

  return doc.documentElement.outerHTML;
}

export async function buildHydratedFilledTemplateHtml(
  html: string,
  values: TemplateFillValues,
  repeaterRows: Record<string, RepeaterRowValues[]>,
  assetDataUrls: Record<string, string> = {},
): Promise<string> {
  const filledHtml = buildFilledTemplateHtml(html, values, repeaterRows);
  if (Object.keys(assetDataUrls).length === 0) return filledHtml;
  return injectTemplateAssetSources(filledHtml, assetDataUrls);
}
