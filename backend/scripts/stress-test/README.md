# Stress test

Drives N firm users (default 10) against the staging API, across the everyday screens plus
e-signatures and templates. Reports latency, errors and how the document worker held up.

Plain TypeScript run with `tsx`, using Node's built-in `fetch`. Nothing to install.

## Commands

Run from `backend/`.

```bash
DB_TARGET=staging npm run stress:setup -- --users 10   # create the firm and users (once)
npm run stress:run                                      # 10 users, realistic, 5 minutes
npm run stress:run -- --profile docs-burst --rounds 3   # every user hits the document worker at once
npm run stress:teardown                                 # delete the Firebase identities
```

**`stress:run` flags:**
- `--users N` (1 to 50)
- `--duration SECONDS` (realistic profile)
- `--rounds N` (docs-burst)
- `--target URL`, or the `STRESS_TARGET` env var

**Allowed targets:** only `https://api-staging.paralegix.com`, `localhost` and `127.0.0.1`. Any other
host, including production, is refused.

**What setup creates:**
- One comped firm, "Stress Test Firm <runId>", with no plan limits.
- An owner plus Attorney members.
- Every address is on the reserved `.test` TLD, so nothing can be emailed to them.
- The account list is written to `.state.json`, which is gitignored.

**What teardown removes:** the Firebase identities only, because Firebase is shared across
environments. The firm and its rows stay in the staging database, which is disposable.

**Tokens:** `run` signs users in with Admin custom tokens. It needs `TEST_FIREBASE_API_KEY` in
`backend/.env` and the Firebase Admin credentials (`serviceAccountKey.json`).

## Profiles

**`realistic`.** Users arrive one per second, then loop with a 2 to 6 second pause between
screens. Each loop picks one flow:

| Share | Flow |
| --- | --- |
| 65% | Dashboard, matters, tasks, time, invoices, clients, messages |
| 15% | Upload a PDF, create a copy-link signing session, sign it as the recipient, download the sealed PDF |
| 5% | Convert a DOCX for signing |
| 10% | Fill a DOCX template to PDF |
| 5% | Export an HTML template to PDF |

This pacing sends roughly 300 requests a minute for 10 users, well under the 1000-per-minute
per-IP global limit they share.

**`docs-burst`.** Every user fires the same document operation at the same instant, in waves:

1. DOCX fill to PDF (LibreOffice)
2. DOCX conversion for signing (LibreOffice)
3. HTML export (Chromium)
4. Full signing round trip

The waves repeat for `--rounds`. This is the profile that answers "is the document worker big
enough".

## Staging capacity this runs into

From `backend/cloudbuild.yaml` and the API's in-memory gates:

- **API** (`paralegix-api-staging`): max 1 instance, concurrency 80, 512Mi, min 0. The first
  request after idle includes a cold start; it is reported as `health.first`.
- **Document worker** (`paralegix-document-worker-staging`): max 2 instances, concurrency 1. At
  most two conversions or renders run at once.
- **Gates in front of the worker, per API instance:**
  - Template fill and preview: 2 at a time, 30s queue, then 503 `TEMPLATE_FILL_BUSY`.
  - HTML export: 1 at a time, 45s queue.
- **Rate limits** a bigger run will hit:

| Limit | Value | Keyed on |
| --- | --- | --- |
| Template renders | 60 per 15 min | user |
| Conversions | 30 per 15 min | user |
| Signing reads | 120/min | IP |
| Global | 1000/min | IP |

To go past them on purpose, set `RATE_LIMITS_DISABLED=true` on `paralegix-api-staging` for the
run window only, then remove it.

## Reading the report

Each run prints the report and writes it, plus the raw samples as JSON, to `reports/`
(gitignored).

**Errors.** Any response with no status (timeout, reset) or a 4xx/5xx.

**Document pipeline.** Counts across every `esign.*` and `templates.*` step:
- **Document queue busy:** a fill, conversion, or signing gate returned `TEMPLATE_FILL_BUSY`, `CONVERSION_BUSY`, or `SIGNING_BUSY`.
- **Rate limited:** a 429.
- **No response within 300s:** a document request never got a status. Document operations and storage uploads use the browser's 300-second budget; ordinary API operations keep a 60-second budget.
- **Other 5xx:** anything else server-side.

Two signs that the worker is the bottleneck:
- busy or timeout counts above zero in `docs-burst`;
- fill or export p95 several times their p50.

**Steps, slowest p95 first.** One row per call type, with p50, p95, max and a status breakdown.

**Flows that stopped early.** A flow stops at the first step that did not succeed. In a smoke run
with one user this list should be empty. Anything there is either a real failure or a harness
bug.

**The worker's side.** In the Cloud Console, open Cloud Run, then
`paralegix-document-worker-staging`, then Metrics. For the run window, check:
- instance count (does it reach 2?);
- request latency;
- container CPU and memory.
