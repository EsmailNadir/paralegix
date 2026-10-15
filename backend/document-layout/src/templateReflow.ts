/**
 * Browser-side reflow for filled templates.
 *
 * Self-contained function (no imports, no closures) executed in a browser
 * context: Puppeteer `page.evaluate()` for PDF export, and as an injected
 * `<script>` for preview windows.
 *
 * Fixes two issues that arise when placeholder chips are replaced with
 * variable-length text in absolutely-positioned template paragraphs:
 *
 *   1. Paragraphs that grew (longer replacement text) don't push subsequent
 *      content down, causing overlap.
 *   2. Content that crosses page boundaries is cut mid-line instead of being
 *      split at visual line boundaries and moved to the next page.
 */

export function reflowFilledTemplate() {
  const pages: HTMLElement[] = [].slice.call(document.querySelectorAll(".pdf-page"));
  if (!pages.length) return;

  // ── Helpers ──────────────────────────────────────────────────────────

  const contentTopOf = (pg: HTMLElement) => {
    const raw = parseFloat(pg.dataset.baseContentTop || "");
    return isFinite(raw) ? raw : 72;
  };

  const contentBottomOf = (pg: HTMLElement) => {
    const raw = parseFloat(pg.dataset.baseContentBottom || "");
    if (isFinite(raw) && raw > 0) return raw;
    const minH =
      parseFloat(pg.dataset.baseMinHeight || "") ||
      parseFloat(pg.style.minHeight || "") ||
      pg.offsetHeight ||
      0;
    if (minH <= 0) return 0;
    const ct = contentTopOf(pg);
    const desired = Math.min(minH - 96, minH * 0.92);
    return Math.max(ct + 240, desired);
  };

  const sortedPs = (pg: HTMLElement): HTMLElement[] =>
    ([].slice.call(pg.querySelectorAll(":scope > p")) as HTMLElement[]).sort(
      (a: HTMLElement, b: HTMLElement) =>
        parseFloat(a.style.top || "0") - parseFloat(b.style.top || "0"),
    );

  const mkPage = (src: HTMLElement) => {
    const pg = document.createElement("div");
    pg.className = src.className;
    pg.style.cssText = src.style.cssText;
    const attrs = ["baseContentTop", "baseContentBottom", "baseMinHeight"] as const;
    for (let ai = 0; ai < attrs.length; ai++) {
      const k = attrs[ai];
      if ((src as any).dataset[k]) (pg as any).dataset[k] = (src as any).dataset[k];
    }
    const bgs: HTMLElement[] = [].slice.call(
      src.querySelectorAll(
        'img.pdf-page-background, [data-template-image-pinned="true"], [data-template-image-behind-text="true"]',
      ),
    );
    for (let bi = 0; bi < bgs.length; bi++) pg.appendChild(bgs[bi].cloneNode(true));
    return pg;
  };

  // ── Text-node utilities for paragraph splitting ─────────────────────

  const rmClean = (node: Node, root: HTMLElement) => {
    let par: Node | null = node.parentNode;
    if (par) par.removeChild(node);
    while (par && par !== root && par.childNodes.length === 0) {
      const gp = par.parentNode;
      if (gp) gp.removeChild(par);
      par = gp;
    }
  };

  const collectTextNodes = (root: HTMLElement) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let n: Node | null;
    while ((n = walker.nextNode())) nodes.push(n as Text);
    return nodes;
  };

  const trimAfter = (root: HTMLElement, lim: number) => {
    const nodes = collectTextNodes(root);
    let rem = lim;
    for (let i = 0; i < nodes.length; i++) {
      const t = nodes[i];
      if (rem <= 0) {
        rmClean(t, root);
        continue;
      }
      if (rem < t.length) {
        t.data = t.data.slice(0, rem);
        rem = 0;
        continue;
      }
      rem -= t.length;
    }
  };

  const trimBefore = (root: HTMLElement, lim: number) => {
    const nodes = collectTextNodes(root);
    let rem = lim;
    for (let i = 0; i < nodes.length; i++) {
      const t = nodes[i];
      if (rem <= 0) break;
      if (rem < t.length) {
        t.data = t.data.slice(rem);
        break;
      }
      const len = t.length;
      rmClean(t, root);
      rem -= len;
    }
  };

  const wordBound = (text: string, idx: number) => {
    if (idx <= 0 || idx >= text.length) return idx;
    for (let i = Math.min(idx - 1, text.length - 1); i >= 0; i--) {
      const ch = text.charCodeAt(i);
      // space, tab, newline, CR, non-breaking space
      if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 160) return i + 1;
    }
    return idx;
  };

  const measureH = (p: HTMLElement, charLim?: number) => {
    const clone = p.cloneNode(true) as HTMLElement;
    clone.style.position = "relative";
    clone.style.top = "0";
    clone.style.left = "0";
    const w = p.style.width || p.offsetWidth + "px";
    clone.style.width = w;
    clone.style.maxWidth = w;
    clone.style.whiteSpace = "normal";
    clone.style.overflowWrap = "break-word";
    clone.style.wordBreak = "normal";
    if (typeof charLim === "number") trimAfter(clone, charLim);
    const host = document.createElement("div");
    host.className = "pdf-page"; // inherit page-level CSS context
    host.style.cssText = "position:absolute;visibility:hidden;left:-9999px;top:0;width:" + w;
    host.appendChild(clone);
    document.body.appendChild(host);
    const h = clone.offsetHeight;
    document.body.removeChild(host);
    return h;
  };

  /** Split a paragraph so the head fits within `availH` pixels. */
  const splitP = (p: HTMLElement, availH: number) => {
    const txt = p.textContent || "";
    if (txt.length < 5 || availH <= 10) return null;

    // Binary search for the character offset where measured height <= availH
    let best = 0;
    let lo = 1;
    let hi = txt.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (measureH(p, mid) <= availH) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    const si = wordBound(txt, best);
    if (si <= 0 || si >= txt.length) return null;

    const head = p.cloneNode(true) as HTMLElement;
    const tail = p.cloneNode(true) as HTMLElement;
    trimAfter(head, si);
    trimBefore(tail, si);

    if (!(head.textContent || "").trim() || !(tail.textContent || "").trim()) return null;

    // Clear stored height on clones so subsequent pages don't false-detect
    // "growth" on these freshly-split halves.
    delete head.dataset.baseHeight;
    delete tail.dataset.baseHeight;

    return { head, tail };
  };

  // ── Non-paragraph element selector ──────────────────────────────────

  const NON_P_SEL =
    ':scope > [data-template-image-object-id]:not([data-template-image-pinned="true"]):not([data-template-image-behind-text="true"]),' +
    ':scope > [data-template-text-box-id]:not([data-template-image-pinned="true"]):not([data-template-image-behind-text="true"])';

  // ── Step 0: Re-merge character-fraction splits ──────────────────────
  // buildFilledTemplateHtml splits paragraphs at page boundaries using
  // a character fraction estimate, which can split mid-line.  Re-merge
  // these pairs so the main reflow can re-split at visual line boundaries.

  for (let mi = 0; mi < pages.length - 1; mi++) {
    const mPage = pages[mi];
    const mNext = pages[mi + 1];
    const mCb = contentBottomOf(mPage);
    if (mCb <= 0) continue;

    const mPs = sortedPs(mPage);
    if (!mPs.length) continue;
    const lastP = mPs[mPs.length - 1];
    const lastPTop = parseFloat(lastP.style.top || "0");
    const lastPH = lastP.offsetHeight;
    const availBelow = mCb - (lastPTop + lastPH);

    // Only re-merge if there is at least one line of blank space below the
    // last paragraph. That suggests the character-based split was too
    // conservative and left unused room on the page.
    const fs = parseFloat(lastP.style.fontSize || "12") || 12;
    const lhRaw = parseFloat(lastP.style.lineHeight || "1.2");
    const lineH = lhRaw > 4 ? lhRaw : fs * lhRaw;
    if (availBelow < lineH * 0.8) continue;

    // Find a matching paragraph on the next page (same paragraph ID means
    // they were cloned from the same original by splitParagraphAtFraction).
    const lastPId = lastP.dataset.paragraphId || lastP.dataset.logicalParagraphId || "";
    if (!lastPId) continue;

    const nPs = sortedPs(mNext);
    let matchIdx = -1;
    for (let ni = 0; ni < nPs.length; ni++) {
      const nId = nPs[ni].dataset.paragraphId || nPs[ni].dataset.logicalParagraphId || "";
      if (nId === lastPId) {
        matchIdx = ni;
        break;
      }
    }
    if (matchIdx < 0) continue;

    const matchP = nPs[matchIdx];
    const matchH = matchP.offsetHeight;
    const matchGap = parseFloat(matchP.dataset.baseGapBefore || "0") || 0;

    // Merge: append the tail's content into the head paragraph
    lastP.appendChild(document.createTextNode(" "));
    while (matchP.firstChild) lastP.appendChild(matchP.firstChild);
    matchP.remove();

    // Clear stored height. The merged paragraph will be re-evaluated by
    // the main reflow (growth detection skips baseHeight=0, overflow
    // detection will split it correctly using the binary-search approach).
    delete lastP.dataset.baseHeight;

    // Shift remaining paragraphs on the next page up to fill the gap left
    // by the removed tail.
    const shiftUp = matchH + matchGap;
    if (shiftUp > 0) {
      const nCt = contentTopOf(mNext);
      const remaining = sortedPs(mNext);
      for (let ri = 0; ri < remaining.length; ri++) {
        const rT = parseFloat(remaining[ri].style.top || "0");
        const newT = Math.max(nCt, rT - shiftUp);
        remaining[ri].style.top = newT + "px";
        if (remaining[ri].dataset.baseTop) remaining[ri].dataset.baseTop = String(newT);
      }
    }
  }

  // ── Main reflow loop ────────────────────────────────────────────────

  let pending: HTMLElement[] = []; // overflow paragraphs from previous page

  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi];
    const ct = contentTopOf(page);
    const cb = contentBottomOf(page);

    // ─── Step 1: Receive overflow from previous page ────────────────
    if (pending.length > 0) {
      const existing = sortedPs(page);
      let overH = 0;
      for (let oi = 0; oi < pending.length; oi++) {
        const gap = oi === 0 ? 0 : parseFloat(pending[oi].dataset.baseGapBefore || "0") || 4;
        overH += gap;
        pending[oi].style.top = ct + overH + "px";
        if (pending[oi].dataset.baseTop) pending[oi].dataset.baseTop = String(ct + overH);
        page.appendChild(pending[oi]);
        overH += pending[oi].offsetHeight;
      }
      // Reposition existing content right after overflow (preserve the
      // first existing paragraph's gap, but don't blindly push everything
      // down which can create excessive spacing).
      if (existing.length > 0) {
        const firstGap = Math.min(
          parseFloat(existing[0].dataset.baseGapBefore || "0") || 4,
          20,
        );
        const desiredStart = ct + overH + firstGap;
        const currentStart = parseFloat(existing[0].style.top || "0");
        const delta = desiredStart - currentStart;
        if (Math.abs(delta) > 1) {
          for (let ei = 0; ei < existing.length; ei++) {
            const eT = parseFloat(existing[ei].style.top || "0");
            existing[ei].style.top = eT + delta + "px";
            if (existing[ei].dataset.baseTop) existing[ei].dataset.baseTop = String(eT + delta);
          }
          // Shift non-pinned images/text boxes by the same delta
          const nonPs: HTMLElement[] = [].slice.call(page.querySelectorAll(NON_P_SEL));
          for (let ni = 0; ni < nonPs.length; ni++) {
            const nT = parseFloat(nonPs[ni].style.top || "0");
            nonPs[ni].style.top = nT + delta + "px";
          }
        }
      }
      pending = [];
    }

    // ─── Step 2: Detect height growth and shift subsequent content ───
    let paras = sortedPs(page);
    if (!paras.length) continue;

    // Collect growths at their original positions before applying shifts
    const growths: { top: number; inc: number }[] = [];
    for (let gi = 0; gi < paras.length; gi++) {
      const stored = parseFloat(paras[gi].dataset.baseHeight || "0");
      const actual = paras[gi].offsetHeight;
      if (stored > 0 && actual > stored + 2) {
        growths.push({
          top: parseFloat(paras[gi].style.top || "0"),
          inc: actual - stored,
        });
        // Update stored height so this growth isn't double-counted if the
        // paragraph cascades to the next page.
        paras[gi].dataset.baseHeight = String(actual);
      }
    }

    if (growths.length > 0) {
      // Sum of height increases from all paragraphs above a given top
      const shiftFor = (origTop: number) => {
        let s = 0;
        for (let g = 0; g < growths.length; g++) {
          if (growths[g].top < origTop) s += growths[g].inc;
        }
        return s;
      };

      // Apply shifts to paragraphs
      for (let si2 = 0; si2 < paras.length; si2++) {
        const origT = parseFloat(paras[si2].style.top || "0");
        const s = shiftFor(origT);
        if (s > 0) {
          paras[si2].style.top = origT + s + "px";
          if (paras[si2].dataset.baseTop) paras[si2].dataset.baseTop = String(origT + s);
        }
      }

      // Apply shifts to non-pinned images/text boxes
      const nonP2: HTMLElement[] = [].slice.call(page.querySelectorAll(NON_P_SEL));
      for (let ni2 = 0; ni2 < nonP2.length; ni2++) {
        const elT = parseFloat(nonP2[ni2].style.top || "0");
        const es = shiftFor(elT);
        if (es > 0) nonP2[ni2].style.top = elT + es + "px";
      }
    }

    // ─── Step 3: Handle overflow past page boundary ─────────────────
    if (cb <= 0) continue;

    paras = sortedPs(page); // re-sort after shifts
    pending = [];

    // Walk backwards so DOM mutations don't shift indices
    for (let ji = paras.length - 1; ji >= 0; ji--) {
      const p = paras[ji];
      const pT = parseFloat(p.style.top || "0");
      const pH = p.offsetHeight;

      if (pT >= cb) {
        // Fully past boundary, move entire paragraph to overflow
        p.remove();
        pending.unshift(p);
      } else if (pT + pH > cb) {
        // Straddles boundary, try to split at the boundary
        const avail = cb - pT;
        const split = splitP(p, avail);
        if (split) {
          split.head.style.top = p.style.top;
          if (p.dataset.baseTop) split.head.dataset.baseTop = p.dataset.baseTop;
          page.insertBefore(split.head, p);
          p.remove();
          pending.unshift(split.tail);
        } else {
          // Can't split (e.g. not even one line fits), move whole paragraph
          p.remove();
          pending.unshift(p);
        }
      }
    }

    // Ensure a next page exists if we have overflow
    if (pending.length > 0 && pi >= pages.length - 1) {
      const np = mkPage(page);
      page.insertAdjacentElement("afterend", np);
      pages.push(np);
    }
  }

  // ── Final: drain any remaining overflow into new pages ────────────
  let safetyLimit = 50;
  while (pending.length > 0 && safetyLimit-- > 0) {
    const lastPg = pages[pages.length - 1];
    const newPg = mkPage(lastPg);
    lastPg.insertAdjacentElement("afterend", newPg);
    pages.push(newPg);

    const nct = contentTopOf(newPg);
    const ncb = contentBottomOf(newPg);
    let curTop = nct;
    const nextPending: HTMLElement[] = [];

    for (let fi = 0; fi < pending.length; fi++) {
      const op = pending[fi];
      const opGap = fi === 0 ? 0 : parseFloat(op.dataset.baseGapBefore || "0") || 4;
      curTop += opGap;
      op.style.top = curTop + "px";
      if (op.dataset.baseTop) op.dataset.baseTop = String(curTop);
      newPg.appendChild(op);
      const opH = op.offsetHeight;

      if (ncb > 0 && curTop + opH > ncb) {
        // Still overflows the new page, split if possible
        const opAvail = ncb - curTop;
        const opSplit = splitP(op, opAvail);
        if (opSplit) {
          opSplit.head.style.top = op.style.top;
          newPg.insertBefore(opSplit.head, op);
          op.remove();
          nextPending.push(opSplit.tail);
        } else {
          op.remove();
          nextPending.push(op);
        }
        // Everything after this paragraph also overflows
        for (let ri = fi + 1; ri < pending.length; ri++) nextPending.push(pending[ri]);
        break;
      }

      curTop += opH;
    }

    pending = nextPending;
  }
}
