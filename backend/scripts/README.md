# backend/scripts

Occasional-run operational, maintenance, and dev tooling. These are **not** part
of the app runtime or the test suite — run them by hand with `npx tsx scripts/<name>.ts`
from the `backend/` directory. They load `backend/.env`.

Schema definition and lifecycle tooling lives separately in `backend/db/`
(`schema.sql`, `migrations/`, `apply-schema.ts`, `run-sql.ts`, `seed/`).

**Connection:** every script that reaches Postgres honors `DB_TARGET`
(local/staging/prod): the ones that import the shared pool (`../src/shared/database/db`)
through it, and `verify.ts`, `counts.ts`, `backfill-trust-snapshots.ts` and
`validate-trust-book-balance.ts` through `resolveDbUrl()`, printing the target first.
TLS is used only for a hosted (Supabase) database.

## Maintenance / repair
| Script | What it does |
|---|---|
| `gc-template-assets.ts` | List and optionally delete orphaned template objects under `lawfirmids/{firm}/templates/` with no live template row. |
| `backfill-trust-snapshots.ts` | Recompute and repair the running-balance snapshots on `trust_transactions` / `trust_accounts`. |
| `validate-trust-book-balance.ts` | Inspect and validate the `trust_accounts_book_balance_nonneg` constraint; `--fix` clears negative-balance test accounts. |
| `resync-builtin-roles.ts` | Re-sync every firm's built-in role permissions to the current canonical definitions in `src/modules/lawfirms/roles/permissions.ts`. Re-run whenever permissions change. |

## Diagnostics
| Script | What it does |
|---|---|
| `verify.ts` | Quick schema sanity check against the database. |
| `counts.ts` | Print row counts for every public table. |
| `report-stripe-trust-deposits.ts` | Remediation report listing trust deposits that settled into a firm's operating Stripe account before per-trust-account routing existed. |
| `stress-test/` | Load test for staging: N firm users across everyday screens, e-signatures and templates. `npm run stress:setup`, `stress:run`, `stress:teardown`; see its README. |

## Setup / one-time
| Script | What it does |
|---|---|
| `generate-signing-cert.ts` | Generate a self-signed `.p12` certificate for PDF digital signing. |
| `set-gcs-cors.ts` | Configure CORS on a GCS bucket for direct browser uploads and ranged reads. Takes `--target staging` or `--target prod`, which picks the bucket and its origins together; `--print` shows the live config without changing it. |
| `harden-connect-payouts.ts` | Backfill payout hardening (payout-schedule delay + `debit_negative_balances`) onto Stripe Connect accounts created before hardening was applied at onboarding. |

## Billing
| Script | What it does |
|---|---|
| `reconcile-stripe-payments.ts` | Reconcile Stripe payments against invoice records. Also wired to `npm run stripe:reconcile`. |
| `verify-stripe-prices.ts` | Check the six `STRIPE_*_PRICE_ID` values against the plan table (`PLAN_TIERS` pricing): amount, currency, interval, archived, and one ID reused for two slots. Read-only; exits 1 on a mismatch. Run it for each environment before a deploy that changes the IDs. |
| `bill-accrued-trust-fees.ts` | Bill trust deposit ACH processing fees that accrued but were never charged. Safe to re-run; intended to run on a schedule. |

## Build
| Script | What it does |
|---|---|
| `copy-template-fonts.ts` | Copy the Document Overlay editor's bundled fonts into `dist/` after `tsc`. Run as part of `npm run build`. |

## Dev / test helpers
| Script | What it does |
|---|---|
| `dump-route-manifest.ts` | Print every route the Express app registers, as a stable manifest. Dump it before and after a route refactor and diff the two: a handler dropped from a middleware chain, or a path that gained a segment, is invisible to a service-level test and obvious here. |
| `make-verified-user.ts` | Create or update a Firebase Auth user with `emailVerified=true` so it passes the verification gates. Usage: `npx tsx scripts/make-verified-user.ts <email> <password> [displayName]`. |

## run-signing-benchmark.sh

Measures the signing lifecycle under a real 512 MiB limit. Needs Podman and
`openssl`, and pulls `fsouza/fake-gcs-server`.

```bash
scripts/run-signing-benchmark.sh 100 500
BENCHMARK_CONCURRENCY=6 scripts/run-signing-benchmark.sh 100
```

One JSON line per size. `cgroupPeakBytes` is the container's own high-water
mark and `baseline` is what the process costs before any signing happens, so
the memory the work actually adds is the difference. `BENCHMARK_CONCURRENCY`
runs that many operations at once, which is how the per-instance slot count in
`shared/utils/transferSlot.ts` is chosen rather than assumed. An `EXIT` line
with code 137 is the container being killed at that size.

The emulator, not this code, is what caps the fixture size: it drops the
connection partway through an upload beyond about 1 GiB and cannot compose an
object that large either.

## gcs-path-proxy.ts

Started by the benchmark runner. The storage client asks for uploads at
`/upload/storage/v1/...` and everything else at `/b/...`, while the emulator
serves only the prefixed form, so reads after a successful write answer 404.
This adds the prefix. It has no part in the product.
