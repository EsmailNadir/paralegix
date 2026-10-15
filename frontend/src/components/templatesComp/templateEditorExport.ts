import { TEMPLATE_IMAGE_OBJECT_SELECTOR, stripTemplateImagePreviewSources } from './templateImageObjects';
import { stripZeroWidthSpaces } from './templateEditorDom';

/** Clone authoring DOM into persistent markup without mutating the live editor or its selection. */
export function buildTemplateSaveContent(editor: HTMLDivElement | null, exportHtml: string) {
  const editorClone = editor?.cloneNode(true) as HTMLDivElement | null;
  editorClone?.querySelectorAll("[data-template-text-box-control]").forEach((node) => node.remove());
  editorClone?.querySelectorAll("[data-template-image-control]").forEach((node) => node.remove());
  editorClone?.querySelectorAll("[data-template-image-layer-menu]").forEach((node) => node.remove());
  editorClone?.querySelectorAll<HTMLElement>("[data-template-text-box-id]").forEach((box) => {
    box.style.outline = "none";
    box.style.boxShadow = "none";
    box.removeAttribute("data-template-text-box-hydrated");
  });
  editorClone?.querySelectorAll<HTMLElement>(TEMPLATE_IMAGE_OBJECT_SELECTOR).forEach((object) => {
    object.style.outline = "none";
    object.style.boxShadow = "none";
    object.removeAttribute("data-template-image-hydrated");
  });
  editorClone?.querySelectorAll<HTMLElement>("[data-placeholder-chip]").forEach((chip) => {
    chip.style.outline = "none";
    chip.style.boxShadow = "none";
    chip.removeAttribute("data-placeholder-chip-selected");
    // Restore chip label to {field_name} in matter fill-preview values were applied
    const chipName = chip.getAttribute("data-placeholder-chip") ?? "";
    if (chipName) {
      const textSpan = chip.firstElementChild as HTMLElement | null;
      if (textSpan && !textSpan.hasAttribute("data-chip-remove")) {
        textSpan.textContent = `{${chipName}}`;
      }
    }
  });

  // Strip repeater visual elements and auto-prefix un-prefixed chips
  const repeaters: { name: string; fields: string[] }[] = [];
  const seenRepeaterNames = new Set<string>();
  editorClone?.querySelectorAll<HTMLElement>("[data-repeater]").forEach((p) => {
    const rName = p.getAttribute("data-repeater") ?? "";
    p.querySelector("[data-repeater-label]")?.remove();
    p.style.removeProperty("border-left");
    p.style.removeProperty("background");
    if (rName) {
      seenRepeaterNames.add(rName);
      // Auto-prefix chips inside this repeater that are missing the prefix
      p.querySelectorAll<HTMLElement>("[data-placeholder-chip]").forEach((chip) => {
        const current = chip.getAttribute("data-placeholder-chip") ?? "";
        if (current && !current.startsWith(rName + ".")) {
          const prefixed = `${rName}.${current}`;
          chip.setAttribute("data-placeholder-chip", prefixed);
          const textSpan = chip.firstElementChild as HTMLElement | null;
          if (textSpan && !textSpan.hasAttribute("data-chip-remove")) {
            textSpan.textContent = `{${prefixed}}`;
          }
        }
      });
    }
  });

  // Collect repeater fields from ALL chips that match a known repeater prefix
  for (const rName of seenRepeaterNames) {
    const rFields: string[] = [];
    editorClone?.querySelectorAll("[data-placeholder-chip]").forEach((chip) => {
      const fullName = chip.getAttribute("data-placeholder-chip") ?? "";
      if (fullName.startsWith(rName + ".")) {
        const subField = fullName.slice(rName.length + 1);
        if (subField && !rFields.includes(subField)) rFields.push(subField);
      }
    });
    repeaters.push({ name: rName, fields: rFields });
  }

  // Re-scan chip names from the clone (after auto-prefixing)
  const cloneChipNames: string[] = [];
  const cloneChipSeen = new Set<string>();
  editorClone?.querySelectorAll("[data-placeholder-chip]").forEach((chip) => {
    const n = chip.getAttribute("data-placeholder-chip") ?? "";
    if (n && !cloneChipSeen.has(n)) { cloneChipSeen.add(n); cloneChipNames.push(n); }
  });

  // Group consecutive [data-link-href] spans with the same URL into <a> tags.
  if (editorClone) {
    const linkSpans = Array.from(editorClone.querySelectorAll<HTMLElement>("[data-link-href]"));
    const processed = new Set<HTMLElement>();
    for (const span of linkSpans) {
      if (processed.has(span)) continue;
      const href = span.getAttribute("data-link-href")!;
      const group: HTMLElement[] = [span];
      processed.add(span);
      // Collect consecutive siblings with the same href
      let next = span.nextSibling;
      while (next) {
        if (next instanceof HTMLElement && next.getAttribute("data-link-href") === href) {
          group.push(next);
          processed.add(next);
          next = next.nextSibling;
        } else if (next.nodeType === Node.TEXT_NODE && next.textContent?.trim() === "") {
          // skip whitespace text nodes between link spans
          next = next.nextSibling;
        } else {
          break;
        }
      }
      const a = document.createElement("a");
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.style.textDecoration = "underline";
      a.style.color = "#2563eb";
      span.before(a);
      for (const s of group) {
        s.removeAttribute("data-link-href");
        a.appendChild(s);
      }
    }
  }

  // Strip the stashed width attribute from gap spans in the saved clone
  editorClone?.querySelectorAll<HTMLElement>("[data-pdf-gap]").forEach((gap) => {
    delete gap.dataset.pdfGapWidth;
  });

  // Strip zero-width spaces used as caret targets around chips
  if (editorClone) stripZeroWidthSpaces(editorClone);
  if (editorClone) stripTemplateImagePreviewSources(editorClone);

  const editorContent = editorClone?.innerHTML ?? "";
  // Replacer function, not a replacement string: document text containing
  // `$&`, `$'` etc. would otherwise be expanded as substitution patterns and
  // corrupt the saved HTML. And if the stored html has no <body> (the load
  // path tolerates body-less html), a plain replace would silently no-op and
  // save the OLD html - append the content instead so the session isn't lost.
  const bodyRe = /<body[^>]*>[\s\S]*<\/body>/i;
  const fullHtml = bodyRe.test(exportHtml)
    ? exportHtml.replace(bodyRe, () => `<body>${editorContent}</body>`)
    : `${exportHtml}<body>${editorContent}</body>`;
  return { html: fullHtml, fields: cloneChipNames, repeaters };
}
