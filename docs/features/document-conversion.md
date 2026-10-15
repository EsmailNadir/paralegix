# Document Conversion and the Document Worker

## Summary

Document conversion turns an office document into another format, almost always DOCX (or DOC, ODT, RTF, TXT) into PDF, using LibreOffice's `soffice` binary through the `libreoffice-convert` npm package. It serves three product areas: e-signatures (a non-PDF has to become a PDF before it can be signed), templates (overlay canvases, filled output in a non-native format, DOCX previews), and the standalone "convert this file" endpoint. The conversion itself can run in one of two places: inside the API process (`local` mode, the default) or in a separate, IAM-private Cloud Run service called the document worker (`worker` mode). The API passes documents to the worker as short-lived GCS signed URLs rather than as request bodies.

## Key Takeaways

- **One switch, read per call.** `DOCUMENT_CONVERTER === 'worker'` selects the worker; any other value, including unset, runs LibreOffice in the API process (`backend/src/shared/documentConversion/converter.ts:280`, `:320`). Cloud Build writes the variable on every API deploy from `_DOCUMENT_CONVERTER`, which defaults to `local` (`backend/cloudbuild.yaml:156`, `:238`).
- **Every caller goes through `signatures.service.ts`.** It wraps the adapter in a per-instance limiter (1 conversion, 45 s queue deadline) (`backend/src/modules/signatures/signatures.service.ts:22-24`). A test fails if any other module imports the adapter (`backend/tests/config/deployBudget.test.ts:126-137`).
- **No message queue.** A conversion is a synchronous HTTP call from the API to the worker with a 55 s abort. The only "queue" is the in-process limiter. Nothing is retried.
- **Bytes move through GCS, not the API**, for the stored-object paths: the worker gets a V4 read URL for the source and a V4 write URL for `document-conversion/<uuid>/output/result.<ext>` (`converter.ts:192-217`).
- **Size caps:** 100 MiB converter ceiling (`DOCUMENT_CONVERTER_MAX_BYTES`, `converter.ts:6`, `document-worker.ts:6`). Signing keeps 100 MiB on the worker and lowers it to 25 MiB when conversion runs in the API (`signingConversionCapBytes()`, overridable with `SIGNING_UPLOAD_BUFFER_BYTES`), and that cap is enforced before any byte is read, in both modes. Measured on the worker at 1 vCPU / 1 GiB: a 92 MB image-heavy DOCX converts in 4.2 s at 564 MiB, a 500-page text DOCX in 1.5 s at 160 MiB. A refusal names the conversion as the reason and, for signing, that the same file saved as a PDF is accepted up to 500 MB.
- **Untrusted documents.** The worker has no database or app secrets. It runs only under Cloud Run IAM, with concurrency 1, and accepts only `storage.googleapis.com` URLs that expire in 120 s or less (`document-worker.ts:8-17`, `cloudbuild.yaml:177-196`).

---

## How It Works

### Entry Points

| Caller | Route / function | Adapter call | Input form |
|---|---|---|---|
| Standalone convert | `POST /api/signatures/convert/upload-init`, `POST /api/signatures/convert/run` (`signatures.routes.ts:62`, `:86`; mounted `app.ts:905`) | `convertStoredDocument` (`signatures.routes.ts:107`) | stored object, any of 6 formats |
| Signing upload (non-PDF) | `POST /api/signing/convert-upload-init`, `/convert-upload-finalize` (`signing.routes.ts:625`, `:658`) | `convertStoredDocument` (`signing.routes.ts:679`) | stored object, PDF only |
| Signing prepare | `POST /api/lawfirms/:lawFirmId/signature-links/prepare` (`signatureLinks.routes.ts:603`) and session create (`:497`), both via `preparePdfForSigning` (`:231`) | `convertStoredDocument` (`signatureLinks.routes.ts:325`) | stored firm document, PDF only |
| Overlay template upload | `POST .../templates/upload-overlay-init` and `upload-overlay-finalize` (`templates.routes.ts:125`, `:150`) | `convertStoredDocument` (`templates.service.ts:844`) | stored object, PDF only |
| Template fill | `POST .../templates/:templateId/fill` (`templates.routes.ts:278`) | `convertDocument` buffer | in-memory Buffer |
| Template preview | `GET .../templates/:templateId/preview` (`templates.routes.ts:295`) | `convertDocument` buffer | in-memory Buffer |
| Worker service | `GET /health`, `POST /internal/convert` (`backend/src/document-worker.ts:31-38`) | `convertLocally` (`document-worker.ts:55`) | signed URLs |

The service-level `convertStoredDocument` (`signatures.service.ts:47-49`) calls the adapter's `convertStoredDocumentOrDownload`, **not** the adapter's own `convertStoredDocument`. The frontend reaches the two browser-facing flows from `frontend/src/services/signatures.service.ts:438`, `:453`, `:1236`, `:1252`.

### Local vs Worker Mode

| | `local` (default) | `worker` |
|---|---|---|
| Selected when | `DOCUMENT_CONVERTER` is anything but `worker` (`converter.ts:280`) | `DOCUMENT_CONVERTER=worker` (`converter.ts:320`) |
| Where `soffice` runs | the API container, 512 MiB, concurrency 80 (`cloudbuild.yaml:161-163`) | `paralegix-document-worker`, 1 GiB, concurrency 1 (`cloudbuild.yaml:192-194`) |
| Stored-object source | downloaded into the API after a metadata size check (`converter.ts:335-339`) | never enters the API; the worker reads it by signed URL (`converter.ts:213-217`) |
| Buffer conversions (fill, preview) | converted in memory (`converter.ts:286`) | uploaded to scratch, converted, result downloaded (`converter.ts:54`, `:83`) |
| Required config | LibreOffice installed locally | `DOCUMENT_WORKER_URL`, plus an ID token from the metadata server or `DOCUMENT_WORKER_ID_TOKEN` (`converter.ts:19-37`) |

The mode is read from `process.env` on every call, not at import. Changing it only needs a new revision with the variable set, not a code change. Because the deploy step rewrites it, the change has to be made on the Cloud Build trigger (`cloudbuild.yaml:156`).

### Data Flow

Stored-object conversion in worker mode, for example `/signing/convert-upload-finalize`:

1. The browser has already PUT the source into `signing-uploads/...` through a resumable session capped at `SIGNING_UPLOAD_BUFFER_BYTES` (`signing.routes.ts:644-653`). Finalize settles it and learns its size (`:673-678`).
2. `convertStoredDocument` in the service waits for a limiter slot. If none opens within `DOC_CONVERT_QUEUE_TIMEOUT_MS` it rejects with `ConcurrencyQueueTimeoutError` (`signatures.service.ts:23-24`, `runWithConcurrency.ts:230-235`).
3. `convertStoredDocumentOrDownload` sees `worker` and calls `convertStoredDocument` (`converter.ts:320-321`). That function refuses an oversized `sourceBytes` (413 against the caller cap, 400 against the converter cap) (`:181-188`), confirms the source exists (`:206-211`), and signs a read URL for the source and a write URL for `document-conversion/<uuid>/output/result.<ext>`, both valid for 90 s (`:213-217`).
4. It POSTs a JSON command to `${DOCUMENT_WORKER_URL}/internal/convert`. The request carries a Google ID token for `DOCUMENT_WORKER_AUDIENCE` (or the URL) from the metadata server, plus an `X-Conversion-Id` header, and is aborted after 55 s (`converter.ts:219-243`, `:29-37`).
5. The worker validates the command (step list under Key Logic), fetches the source, runs `convertLocally`, checks the output size, and PUTs it to the write URL (`document-worker.ts:44-58`). It answers `200 {conversionId}`, or `422` on any failure (`:62-69`).
6. The API does not trust the 200 by itself: it reads the output's metadata and rejects a missing, empty, or oversized object (`converter.ts:253-257`). It then returns `{ objectPath, size, contentType, generation, cleanup }` (`:262-268`).
7. The caller copies the output server side, pinned to that generation, to its own path. It then calls `cleanup()`, which deletes only the output prefix (`signing.routes.ts:692-708`, `converter.ts:198-203`). Signing then re-admits the PDF through the same structural checks as a direct PDF upload (`signing.routes.ts:709-719`).

**Local mode, same call:** `convertStoredDocumentOrDownload` logs a warning. It then reads the object's metadata size and refuses anything over the cap before downloading, downloads the source into the API process, runs `convertLocally`, and writes the result to the same `document-conversion/<uuid>/output/` shape. That way callers never branch on mode (`converter.ts:324-365`).

**Buffer conversion (`convertDocument`)**, used by fill and preview: local mode spawns `soffice` directly. Worker mode (`convertWithWorker`) first uploads the whole buffer to `document-conversion/<uuid>/input/<safeName>`, then runs the same worker round-trip, downloads the result into memory, and deletes the whole `<uuid>/` prefix in `finally` (`converter.ts:39-93`).

### Data Model

There are no database tables. The only persisted state is GCS scratch objects in `GCS_BUCKET` (default `lawfirms`, `converter.ts:11-13`):

| Path | Written by | Removed by |
|---|---|---|
| `document-conversion/<uuid>/input/<safeName>` | buffer worker path (`converter.ts:47`, `:54`) | whole-prefix delete in `finally` (`converter.ts:89`) |
| `document-conversion/<uuid>/output/result.<ext>` | worker PUT, or local fallback save (`converter.ts:193`, `:347`) | the caller's `cleanup()`, or `cleanup()` on failure (`converter.ts:270`) |
| `document-conversion/callers/<uid>/<uuid>/source` | `/signatures/convert/upload-init` (`signatures.routes.ts:41`, `:70`) | best-effort delete in `/convert/run`'s `finally` (`signatures.routes.ts:152`) |

Types: `FORMAT_MAP` and `OutputFormat` (`contract.ts:1-10`), `StoredConversionInput` (`converter.ts:95-107`), `StoredConversionResult` (`converter.ts:122-137`).

### Key Logic & Rules

**Converter contract (`contract.ts`).** `getOutputFormat` accepts only `pdf, docx, doc, odt, rtf, txt` and throws 400 otherwise (`contract.ts:12-20`). `conversionError` passes through any error that already has a `statusCode`. It maps `Could not find soffice binary` to 503 `CONVERSION_UNAVAILABLE` and everything else to 422 `CONVERSION_FAILED`, with a generic message that never leaks provider text (`contract.ts:22-36`).

**Local adapter (`localConverter.ts`).** This calls `libre.convertWithOptions` with the sanitized filename. A `.pdf` input gets `--infilter=writer_pdf_import` so LibreOffice opens it in Writer (`localConverter.ts:14-21`). The library writes the input to a temp dir and runs `soffice --headless --convert-to` with a fresh `-env:UserInstallation` profile per call. It removes both temp dirs afterwards (`node_modules/libreoffice-convert/index.js:16-17`, `:52-64`, `:83-86`).

**Caps and timeouts.**

| Limit | Value | Where |
|---|---|---|
| Converter ceiling (API and worker) | 100 MiB, `DOCUMENT_CONVERTER_MAX_BYTES` | `converter.ts:6`, `document-worker.ts:6` |
| Caller cap (signing) | 100 MiB on the worker, 25 MiB in the API (`signingConversionCapBytes()`, override `SIGNING_UPLOAD_BUFFER_BYTES`), 413 `FILE_TOO_LARGE` / `SIGNING_CONVERSION_TOO_LARGE` / `CONVERSION_TOO_LARGE` | `signing.validation.ts:197-198`, `signatureLinks.routes.ts:318-331`, `converter.ts:110-120` |
| Standalone convert upload | 100 MiB `CONVERT_MAX_BYTES` | `signatures.routes.ts:30`, `:73` |
| Template fill read | 25 MiB `TEMPLATE_MAX_BYTES` | `templates.service.ts:1462`, `:1481` |
| API concurrency per instance | 1, `DOC_CONVERT_CONCURRENCY` | `signatures.service.ts:22` |
| Queue deadline | 45 s, `DOC_CONVERT_QUEUE_TIMEOUT_MS` | `signatures.service.ts:23` |
| Worker call abort | 55 s, `DOCUMENT_WORKER_TIMEOUT_MS` | `converter.ts:7`, `:62` |
| Signed URL TTL | 90 s, `DOCUMENT_WORKER_URL_TTL_MS` (the worker refuses more than 120 s) | `converter.ts:8`, `document-worker.ts:13` |
| Worker command body | 32 KiB | `document-worker.ts:5`, `:24` |
| Worker service | concurrency 1, 1 GiB, 120 s timeout, max 2 instances | `cloudbuild.yaml:190-195`, `:237` |
| Rate limit | 30 per 15 min per user, `CONVERT_RATE_LIMIT_MAX` | `rateLimiters.ts:247-253` |

The rate limiter guards `/signatures/convert/*` and `/signing/convert-upload-*` (`signatures.routes.ts:64`, `:88`, `signing.routes.ts:631`, `:663`). It does not guard `/signature-links/prepare` or the template routes.

**Worker command validation** (`document-worker.ts:44-49`). The `X-Conversion-Id` header must be a 36-character hex UUID and match the body. Both URLs must be `https://storage.googleapis.com` with `0 < X-Goog-Expires <= 120`. `inputFilename` must already be sanitized to `[a-zA-Z0-9._-]`. `maxBytes` must be an integer from 1 to the worker's own ceiling. The format must pass `getOutputFormat`. Input and output are each rejected when they are empty or larger than `maxBytes` (`:54`, `:56`).

**Failure handling and retries.** Nothing retries. The worker answers 422 when the document itself cannot be converted, 503 when it cannot reach storage or LibreOffice, and 400 for a malformed command (`workerConvert.ts`). The API maps 422 to `CONVERSION_FAILED` ("could not be converted, it may be corrupt, password-protected, or in an unsupported format") and anything else to 503 `CONVERSION_UNAVAILABLE` ("temporarily unavailable"), through `workerConversionError` (`contract.ts`). Network errors and aborts go through `conversionError` and surface as 422 (`:274`). Template callers rewrap failures as 502 `TEMPLATE_OVERLAY_CONVERSION_FAILED` or `TEMPLATE_PREVIEW_CONVERSION_FAILED` (`templates.service.ts:894-901`, `:1567-1572`). The only retry anywhere is inside `libreoffice-convert`, which re-reads the output file up to 3 times, 200 ms apart (`index.js:74-77`). A queue timeout carries no `statusCode` and is not passed through `conversionError`, because the limiter sits outside the adapter (`runWithConcurrency.ts:35-45`, `signatures.service.ts:35`).

**Security.** The API authenticates the user and checks paths before it mints a command. Examples: `/convert/run` refuses any path outside the caller's `document-conversion/callers/<uid>/` prefix (`signatures.routes.ts:91-95`), and signing finalize requires the firm's `signing-uploads` prefix (`signing.routes.ts:669-671`). The worker is deployed with `--no-allow-unauthenticated` and its own service account, and it holds no database or application secrets (`cloudbuild.yaml:177-189`). The worker does no authentication of its own; it relies on Cloud Run IAM. Output-format and input-extension allow-lists stop arbitrary bytes from reaching LibreOffice (`signatures.validation.ts:22-23`, `:66-94`, `signing.routes.ts:620`). Sandboxing is only what the container gives: a separate Cloud Run service and a per-call LibreOffice profile. The worker process runs as the unprivileged `node` user (`Dockerfile.document-worker:37-43`), but the repo configures neither egress restrictions nor LibreOffice macro policy.

### Dependencies

- **Env (API):** `DOCUMENT_CONVERTER`, `DOCUMENT_WORKER_URL` (missing gives 503, `converter.ts:19-27`), `DOCUMENT_WORKER_AUDIENCE`, `DOCUMENT_WORKER_ID_TOKEN` (a static token that skips the metadata server, `converter.ts:30`), `DOCUMENT_WORKER_TIMEOUT_MS`, `DOCUMENT_WORKER_URL_TTL_MS`, `DOCUMENT_CONVERTER_MAX_BYTES`, `DOC_CONVERT_CONCURRENCY`, `DOC_CONVERT_QUEUE_TIMEOUT_MS`, `CONVERT_RATE_LIMIT_MAX`, `SIGNING_UPLOAD_BUFFER_BYTES`, `GCS_BUCKET`. Of these, `backend/.env.example` lists only `CONVERT_RATE_LIMIT_MAX` and `SIGNING_UPLOAD_BUFFER_BYTES` (`.env.example:165`, `:190`).
- **Env (worker):** `PORT` (default 8080) and `DOCUMENT_CONVERTER_MAX_BYTES` (`document-worker.ts:6`, `:73`).
- **Images:** both `backend/Dockerfile` and `backend/Dockerfile.document-worker` install `libreoffice-core` and `libreoffice-writer`. The API copy exists only as the rollback path (`Dockerfile:18-24`, `Dockerfile.document-worker:26-29`). The worker image installs only `libreoffice-convert` and its dependencies, from a manifest written by `scripts/write-worker-manifest.ts` (`Dockerfile.document-worker:13-22`, `:33-34`). The worker runs `node dist/document-worker.js` as the `node` user (`Dockerfile.document-worker:43`, `:46`).
- **Deploy:** one Cloud Build pipeline builds and pushes both images from the same commit and deploys both services (`cloudbuild.yaml:86-129`, `:131-196`). Cutover steps and IAM bootstrap are in `docs/dev/ops/deployment.md`. `infra/` holds only a monitoring script, with nothing specific to conversion.
- **Libraries:** `libreoffice-convert` ^1.8.1 (`backend/package.json`), Firebase Admin Storage for GCS.

### Local Development

- **Default (`local`)**: leave `DOCUMENT_CONVERTER` unset and install LibreOffice. On macOS the library looks for `/Applications/LibreOffice.app/Contents/MacOS/soffice`, and on Linux for `/usr/bin/soffice` and similar paths (`index.js:20-24`). Without it, conversions fail with 503 `CONVERSION_UNAVAILABLE`. Stored-object conversions download the source into the process and log `downloading a source into this process` (`converter.ts:328-331`).
- **Worker locally**: there is no npm script for it. Run `npm run build`, then `node dist/document-worker.js`, and set `DOCUMENT_CONVERTER=worker`, `DOCUMENT_WORKER_URL`, and `DOCUMENT_WORKER_ID_TOKEN` (any string, since the local worker checks no token). The worker only accepts real `storage.googleapis.com` signed URLs, so this needs a real GCS bucket.

### Tests

| File | Covers |
|---|---|
| `tests/shared/documentConversion.test.ts` | `getOutputFormat`, and `conversionError`'s 503 and 422 mapping without leaking provider text (run offline: `__TEST_TOKEN__=offline npx jest tests/shared/documentConversion.test.ts`, `:16`) |
| `tests/shared/convertStoredDocument.test.ts` | the source is never written or deleted, read and write URLs, a reference is returned, output cleanup on failure, a missing or empty output is refused, caps in both adapters (`:98-195`) |
| `tests/config/deployBudget.test.ts` | worker 1 GiB, concurrency 1 and private. Only two files import `localConverter`. Only `signatures.service.ts` imports the converter. The limiter defaults to 1. |
| `tests/config/wholeObjectDownloadInventory.test.ts` | `converter.ts` has exactly two `.download()` calls (`:17-21`) |
| `tests/signatures/convertRouteDirectUpload.test.ts`, `signatureLinksPrepare.test.ts` (`:214-230`), `signingUpload.test.ts`, `tests/templates/templateOverlayUpload.test.ts`, `templateRenderUrls.test.ts` | route behaviour, with the converter stubbed |

### Example

The command `convertStoredDocument` sends to the worker (`converter.ts:224-238`):

```http
POST https://<worker>/internal/convert
Authorization: Bearer <Google ID token>
X-Conversion-Id: 3f1c...-...-...
Content-Type: application/json

{"conversionId":"3f1c...","inputFilename":"Engagement_Letter.docx","outputFormat":"pdf",
 "sourceUrl":"https://storage.googleapis.com/lawfirms/signing-uploads/...?X-Goog-Expires=90&...",
 "outputUrl":"https://storage.googleapis.com/lawfirms/document-conversion/3f1c.../output/result.pdf?X-Goog-Expires=90&...",
 "maxBytes":26214400}
```

The worker answers `200 {"conversionId":"3f1c..."}` or `422 {"error":"Document conversion failed."}`.

---

## What Can Be Improved

- **Nothing sweeps `document-conversion/`.** Two comments say "the sweeper collects the prefix" (`signatures.routes.ts:153`, `templates.service.ts:913`). But the only reference to the prefix outside the converter is `signatures.routes.ts:41`, and `files.sweeper.ts` never mentions it. The repo also defines no GCS lifecycle rule (`infra/` holds only monitoring config); confirm on the bucket itself before acting, since a rule can exist outside the repo. If none exists, an instance killed mid-conversion, or a failed best-effort delete, leaves billed scratch objects forever. Add a housekeeping sweep or a lifecycle rule for that prefix.
- **"Bad file" and "try again" are kept apart end to end.** The worker answers 422 only when the document itself fails to convert and 503 when it cannot reach storage or LibreOffice (`workerConvert.ts`). On the API side, a worker that cannot be reached, or that passes the 55-second deadline, is 503 `CONVERSION_UNAVAILABLE` rather than a failed conversion (`converter.ts`), because nothing is known about the document.
- **Prepare copies an unpinned output.** `signatureLinks.routes.ts:339-351` copies `converted.objectPath` without `sourceGeneration: converted.generation`, unlike `signing.routes.ts:695` and `templates.service.ts:908`, even though `StoredConversionResult.generation` exists for exactly this (`converter.ts:126-134`).
- **No time bound on `soffice`.** `localConverter.ts:17-21` passes no timeout, and `libreoffice-convert` has none. In local mode a hung conversion holds the API's only limiter slot until the 3600 s request timeout (`cloudbuild.yaml:169`). The worker is bounded only by Cloud Run's 120 s.
- **The worker reads the whole source before checking its size** (`document-worker.ts:52-54`). Checking `Content-Length` first would reject oversized inputs without buffering them.
- **No tests for the worker or the buffer worker path.** Nothing exercises `document-worker.ts`'s validation or `convertWithWorker` (`converter.ts:39-93`). The only test that names the worker file is `deployBudget.test.ts`. Command validation is the worker's entire security boundary.
- **Worker mode config is undocumented in `.env.example`.** None of the `DOCUMENT_*` or `DOC_CONVERT_*` variables appear there. And if `DOCUMENT_WORKER_URL_TTL_MS` is raised above 120000, every command is refused by `document-worker.ts:13`.
- **Queue timeouts reach the client unnormalized.** `ConcurrencyQueueTimeoutError` has no `statusCode` (`runWithConcurrency.ts:35-45`), so a saturated converter surfaces through the generic error path instead of as a 503 with a retry hint.
- **Hardening the worker container.** The worker already runs as a non-root user. Consider disabling LibreOffice macros explicitly and restricting worker egress to GCS.
- **Open question:** whether production has cut over to `worker`. The repo default is `local` (`cloudbuild.yaml:238`), and `docs/future/tech-debt.md` (Files and signing) records production as not yet cut over.
