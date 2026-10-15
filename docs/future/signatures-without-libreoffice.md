# Removing LibreOffice from the Signatures Conversion Path (Research)

::: warning INTERNAL — RESEARCH, NOT A DECISION
This is an evaluation of whether the LibreOffice dependency in `backend/Dockerfile`
can be removed without losing functionality. **The short answer is no.** There is
no free, equal-fidelity replacement that covers everything the current code does.
What follows is the evidence for that, and the two changes worth making anyway.
:::

## Summary

LibreOffice is installed into the runtime image for **one module**. Tracing every
call site shows the dependency is narrower than the install suggests. But the part
that is hardest to replace, PDF to Word, is also the part with no viable
JavaScript equivalent at any price point below a commercial SDK.

**Key takeaways:**

- **The runtime cost is process spawn, not image size.** `libreoffice-convert`
  spawns a fresh `soffice` process per conversion: hundreds of milliseconds to
  seconds, memory-hungry, and currently unbounded on the request path. Image size
  only affects cold start. If the goal is backend performance, fix the spawning,
  not the install.
- **No pure-JS path preserves fidelity.** DOCX to PDF via `mammoth` plus a
  renderer either needs Chromium, a *larger* install than LibreOffice, or loses
  tables, headers, footers, and pagination. That is unacceptable for documents
  that get signed.
- **PDF to DOCX has no open-source equivalent at all.**
- **The only true removal is a commercial SDK or a hosted API**, and the hosted
  option means privileged client documents leave our infrastructure. That is a
  confidentiality decision, not an engineering one.

## What actually depends on LibreOffice

One `require`, in `backend/src/modules/signatures/signatures.service.ts:1`:

```js
const libre = require('libreoffice-convert');
```

Five call sites reach it:

| Call site | Output format |
|---|---|
| `backend/src/modules/signatures/signatureLinks.routes.ts:272` | hardcoded `'pdf'` |
| `backend/src/modules/signatures/signing.routes.ts:813` | hardcoded `'pdf'` |
| `backend/src/modules/signatures/signatures.routes.ts:24` | hardcoded `'pdf'` (`convertDocxToPdf`) |
| `backend/src/modules/signatures/signatures.routes.ts:49` | `req.body.format`, any of 6 |
| `backend/src/modules/templates/templates.service.ts:637` | `format \|\| 'pdf'` |

Two things narrow the surface further:

1. **Templates do not need LibreOffice to fill.** `docxtemplater` is pure JS.
   LibreOffice only converts the *filled result*, and
   `backend/src/modules/templates/templates.service.ts:630`
   short-circuits `format === 'docx'` before reaching it.
2. **HTML is the default template type** (`type: d.type || 'html'`), and HTML
   templates cannot be server-filled at all today. `fillTemplate` throws
   `Only DOCX templates can be filled server-side`. So the LibreOffice path serves
   the *secondary* template format.

The frontend exposes all five output formats. See
`frontend/src/components/signaturesComp/AnnotationToolbar.tsx:33`
and `frontend/src/components/templatesComp/TemplateEditor.tsx:5893`.

### The three conversion classes

1. **DOCX to PDF.** Four of five call sites. The one that matters.
2. **DOCX to ODT, RTF, or TXT.** Exposed in the UI, almost certainly near-zero
   real usage for a legal practice. Worth measuring before defending.
3. **PDF to DOCX, DOC, ODT, RTF, or TXT.** The `--infilter=writer_pdf_import`
   path at `backend/src/modules/signatures/signatures.service.ts:48`.
   This is the hard one.

## Options evaluated

### A. Trim the apt install, keep LibreOffice

The current install is already `--no-install-recommends` with just
`libreoffice-core` and `libreoffice-writer`, which is close to minimal. Remaining
trims:

- `-o APT::Install-Suggests=0`
- Explicitly exclude any JRE. `default-jre-headless` can arrive transitively.
- Verify no `libreoffice-l10n-*` or help packages land

**Realistic saving: 10 to 20% of the layer.** Zero effect on request latency.

**Verdict:** cheap, harmless, do it. But understand it buys cold-start time, not
throughput.

### B. Pure JS: `mammoth` to HTML to a PDF renderer

Two renderer choices, both bad:

- **Puppeteer or Chromium.** Full CSS layout, good fidelity. But Chromium is
  *bigger* than `libreoffice-core` plus `libreoffice-writer`. Net loss on the
  stated goal, and it also spawns a process per render, so it does not fix the
  runtime problem either.
- **`jsPDF` or `pdfkit`.** Light and pure JS, but neither is an HTML layout
  engine. Tables, headers, footers, page numbering, and pagination degrade badly.

**Verdict:** rejected. A signature page that renders differently from the source
document is a legal problem, not a cosmetic one. This option also does not address
PDF to DOCX at all.

### C. Commercial SDK or hosted API

[Nutrient](https://www.nutrient.io/blog/how-to-convert-word-to-pdf-in-nodejs/) and
[Apryse](https://apryse.com/blog/nodejs/generate-pdf-convert-docx-to-pdf-with-nodejs-v2)
both convert Office formats in-process with no LibreOffice and no external service.
[ConvertAPI](https://www.convertapi.com/docx-to-pdf/nodejs) is a hosted equivalent.

This is the only option that genuinely removes the dependency while keeping
fidelity across all formats.

**Two blockers:**

1. **Cost.** All three are commercially licensed. Pricing is per-seat or
   per-conversion and needs a real quote against expected volume before this is
   comparable to "free plus 300MB of image."
2. **Confidentiality, the serious one.** A hosted API means client documents, many
   of them privileged, leave our infrastructure and land on a third party's
   servers. For a legal practice-management product that requires, at minimum, a
   DPA, a subprocessor disclosure, and quite possibly per-firm consent. **The
   in-process SDKs (Nutrient, Apryse) do not have this problem**, since they run
   locally. If this option is pursued, it should be an in-process SDK, not a
   hosted API.

**Verdict:** the only real removal. Gate it on a cost quote and a decision about
in-process versus hosted. Do not adopt a hosted converter without a privilege
review.

### D. Keep LibreOffice, run it as a persistent server (recommended)

`libreoffice-convert` spawns `soffice` per call. LibreOffice can instead run once
as a listening server (`soffice --headless --accept=socket,...`, which is what
`unoserver` wraps) and accept conversions over a socket.

This changes nothing about the image, and everything about the runtime. The
per-call cost drops from "boot an office suite" to "send bytes to a warm process."

**Verdict:** the highest-value change in this document for *performance*, which is
the actual goal. See also the unbounded-spawn issue in
[Backend Performance Investigation](/future/backend-performance-investigation).

### E. Drop the rare formats

Removing ODT, RTF, TXT, and the PDF-to-Word reverse path would shrink the UI
surface, but PDF output still requires LibreOffice, so the install stays. **Only
worth doing as UI cleanup**, not as a dependency reduction. Measure usage first.

### F. Render PDF directly from the template model

For the templates path only, generate PDF from the template definition instead of
round-tripping through DOCX. `pdf-lib` is already a dependency and already used
heavily in signatures. See `backend/src/modules/signatures/signingFieldValues.ts`
and `backend/src/modules/signatures/certificatePage.ts`.

This does nothing for user-uploaded documents in the signing flow, which is the
larger traffic source. **Verdict:** a possible later refinement, not a solution.

## Recommendation

**Do now:**

1. **Option D.** A persistent `soffice` process instead of per-call spawn. This is
   where the runtime cost actually is.
2. **Option A.** Trim the apt install. Small, safe, five minutes.

**Decide deliberately:**

3. **Option C with an in-process SDK** is the only path that truly removes the
   dependency. It needs a cost quote. Do not use a hosted API for privileged
   documents without legal review.

**Do not do:**

4. **Option B.** Chromium is bigger than what it replaces, and the lightweight
   renderers lose fidelity that matters for signed documents.

## Open questions

- What is the actual usage split across the six output formats? Nothing is
  instrumented, so the claim that ODT, RTF, and TXT are unused is an assumption.
- How often is the PDF-to-Word reverse path used? It is the single hardest
  capability to replace. If it is near-zero, option C gets much cheaper.
- What does an in-process SDK licence cost at our volume?
