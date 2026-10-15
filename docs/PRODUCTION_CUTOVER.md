# Production Cutover Plan (`staging` → `main`)

Goal: replace the old stack on `main` with the `staging` codebase. This is not a normal
merge: `staging` is a from-scratch rewrite of `main`, so "pushing to main" means a full backend, database and
frontend swap, not landing a branch.

Stack after cutover: same as staging's, see [Staging Setup](/STAGING_SETUP) for the
canonical description. This doc only covers what changes to make the target production
instead of staging.

---

## 0. Reconcile the commits that only exist on `main`

`main` received hotfixes directly after `staging` forked off. Before treating `staging`'s
tree as authoritative, confirm each one is actually subsumed:

| Main-only fix | Status |
|---|---|
| Direct-to-GCS uploads (bypass Cloud Run's 32MiB request cap) | ✅ Superseded — staging has its own resumable-upload system (`backend/src/modules/files/files.upload.routes.ts`) |
| GCS token premature-close retry + firebase-admin pin | ✅ Superseded — staging is on `firebase-admin ^14.0.0` with its own `retryOnTransient` wrapper in `files.storage.ts` |
| Chunk-load error boundary reload | ✅ Superseded by the general `useErrorRetry` hook (escalates to a full reload after a failed retry) |
| `Promise.withResolvers` polyfill for old iOS Safari / Android Chrome | ⚠️ **Not ported.** Staging jumped to `pdfjs-dist 5.4.296` / `react-pdf 10.4.1` (main was on 4.8.69 / 9.2.1). Verify on an old iOS Safari (< 17.4) or older Android Chrome device whether the signing workspace still crashes before cutover; port `frontend/src/lib/polyfills/promiseWithResolvers.ts` from `main` if it does. |
| Remaining ~6 (package-lock/dependency pin fixups, minor commits) | Almost certainly moot — staging is already on newer versions of everything those touched. Worth a final `git log staging..main` skim, not a blocker. |

---

## 1. Production data migration

There is none. The product has no users and no production data, so `main` is replaced with
this application rather than migrated onto it. The one-shot Firestore migrator that used to
live at `scripts/migrate-firestore-to-pg/` was deleted along with the rest of the old stack.

---

## 2. Database / Supabase

- Provision a genuinely separate **production Supabase project** (do not reuse staging's —
  staging is deliberately isolated, per [Staging Setup](/STAGING_SETUP)). Build it from
  `schema.sql` with `DB_TARGET=prod npx tsx backend/db/apply-schema.ts --allow-nonlocal-create`
  (`DB_TARGET=prod` resolves `DATABASE_URL_PROD`). Do **not** replay the files in
  `backend/db/migrations/`: every numbered migration is also folded into
  `backend/db/schema/*.sql`, so `schema.sql` already contains them. Instead record each one
  as applied, in order, with `DB_TARGET=prod npx tsx backend/db/run-sql.ts <file> --record-only
  --allow-prod`, so the ledger starts in step and later migrations apply normally. These are
  operator steps: the repo's agent guard (`guard-bash.js`) blocks the prod target and
  `--allow-prod`.
- Production cutover checklist inherited from the (now-superseded) multi-instance-readiness
  plan, still load-bearing:
  1. The old "re-run migrations 0139 / 0141 / 0142 as `CREATE INDEX CONCURRENTLY`" step is
     moot. Those files were deleted when the chain was collapsed into `schema.sql`, and a new
     production database gets their indexes from `schema.sql` while its tables are still
     empty, so there is no write lock to avoid. What still applies: any later migration that
     adds an index to a table holding production rows must use `create index concurrently`,
     one statement per file, applied with `run-sql.ts --non-transactional`.
  2. Re-measure **production's own** Postgres `max_connections` / connection budget rather
     than inheriting staging's numbers — don't assume the same Supabase tier.
  3. Set `MAX_INSTANCES` to production's real ceiling. `backend/cloudbuild.yaml`'s
     `_MAX_INSTANCES` is currently pinned to `1` (deliberately dialed down; see
     /dev/ops/deployment). Measure the production pooler's `pool_size`, reserve non-app
     connections, and verify `floor(POOLER_CEILING_SAFE / MAX_INSTANCES)` before raising it.
  4. The first production deploy needs a **fresh image push** — Artifact Registry's
     retention policy previously garbage-collected the old production image's digest
     (since fixed to 30 days / keep 10, but confirm before relying on an old digest).
  5. Schedule the `housekeeping` cron — it replaced `setInterval` timers that only ran
     while a single process stayed up, which no longer holds once there is more than one
     instance.
  6. Schedule the `signing-jobs` cron: every minute, 1800s attempt deadline, secret sent as
     `x-cron-secret`. Production has no such job today. Without it a seal that does not
     finish inside the signer's request never finishes. See /dev/ops/cron-jobs.
  7. Provision a production signing certificate: `SIGNING_P12_PATH` + `P12_PASSPHRASE`.
     `paralegix-api` has neither, and with `NODE_ENV=production` the backend refuses to seal
     without both, so every signing request would fail. Generate a new cert for production;
     do not copy staging's. Staging's Secret Manager setup is the model (/STAGING_SETUP).

---

## 3. GCP

- Staging and production currently share **one GCP project** (`your-gcp-project`). Separation
  today is only by Cloud Run **service name** (`paralegix-api` vs `paralegix-api-staging`)
  and `cloudbuild.yaml` substitution values, not by project. Cutover is: point the
  production Cloud Build trigger at the new codebase and redeploy the existing
  `paralegix-api` service and let the pipeline create `paralegix-document-worker`, which does
  not exist yet. No new GCP project is required. After creation, grant the production API
  runtime identity `roles/run.invoker` on only that worker before switching conversion to it.
- GCS bucket CORS is applied by `backend/scripts/set-gcs-cors.ts`, which pairs each bucket
  with its own origin list (`--target staging` / `--target prod`). The production target
  already allows `paralegix.com` / `www.paralegix.com`, so no change is needed at cutover.
  The old `backend/cors.json` was deleted: it had drifted out of step with both live
  buckets, and applying it would have stripped the headers uploads depend on.
- `GCS_BUCKET` is env-driven; just confirm the production bucket name/env vars are set on
  the Cloud Run service (they should already be, since this project runs prod today).
- Firebase Auth project is **already shared** between staging and production — no
  user-identity migration needed.

---

## 4. Stripe

Everything in code is env-driven (`STRIPE_SECRET_KEY` alone determines test vs. live mode;
no code branches on it). Swapping in live keys is not enough on its own — these need
**net-new setup in live Stripe**:

- Register the three live-mode webhook endpoints in /dev/ops/webhooks (payments, Connect,
  subscriptions) against the production API URL, on the API version `stripe.config.ts` pins,
  and set `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET` and
  `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET`.
- **Activate Connect in live mode.** Existing test-mode Express accounts do not carry over
  — every firm using trust accounts will need to redo Stripe Connect onboarding once live.
- Create live Product/Price objects for all 3 plan tiers × 2 billing periods and set the
  six `STRIPE_*_PRICE_ID` env vars — test-mode price ids are not valid in live mode.

**Read-only audit of production on 2026-09-22** (the pre-Postgres stack; nothing changed):

- `STRIPE_SECRET_KEY` is live and `STRIPE_WEBHOOK_SECRET` is set, as plain env values rather
  than Secret Manager references. Move all Stripe secrets to Secret Manager.
- Missing: `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET`, all six
  `STRIPE_*_PRICE_ID`, `STRIPE_AUTO_RECOVERY_ENABLED` (recommended `true`) and `MAX_INSTANCES`.
- Live Stripe has one endpoint, `https://api.paralegix.com/api/webhooks/stripe`, on
  `2026-02-25.clover`, with only five events (`account.updated`,
  `checkout.session.completed`, `checkout.session.expired`, `invoice.paid`, `invoice.voided`)
  and platform events only. Replace it with the three endpoints above; disable it last.
- Live Stripe has **no active prices**. Create the six, then run
  `backend/scripts/verify-stripe-prices.ts` with the production values before go-live.
- The service runs on 512 MiB; staging exceeded that three times. Consider 1 GiB.

Two compliance items already tracked elsewhere in these docs, worth resolving before real
money moves through the live account:

- [Trust / Stripe Compliance](/TRUST_STRIPE_COMPLIANCE): completed in code; its migrations
  are already in `schema.sql`. Remaining pre-production steps: subscribe the live payments
  endpoint to the events in /dev/ops/webhooks with connected-account events on, enable ACH on
  the platform Stripe account, run the remediation report only if a database holds trust
  deposits collected before per-trust-account routing (a fresh production database has none),
  and tune the ACH fee env vars if needed.
- [Direct Charge Migration](/DIRECT_CHARGE_MIGRATION) — **explicitly blocked on
  product-owner sign-off**. Phases 1-5 are not implemented; Paralegix currently bears
  Stripe dispute/chargeback liability under the current destination-charge model. Get an
  explicit decision from the owner before go-live, even if the decision is "accept the
  liability for now."

---

## 5. Vercel / DNS

- No `vercel.json` in `frontend/` — env vars are set per branch in the Vercel dashboard.
  Whichever Vercel project currently serves `paralegix.com` needs production env vars
  pointed at: the new production API URL, the new production Supabase project, and live
  Stripe (once §4 is done).
- If `staging` becomes `main` in place (same Vercel project already tracking `main`), no
  domain change is needed. If staging runs under a separate Vercel project today, this
  needs a deliberate domain move, not just an env var change.

---

## 5b. Product analytics (PostHog)

Local, staging and production each send to their own PostHog project (US cloud), so test
traffic never mixes with real usage. Project tokens are public by design: they ship in the
browser bundle and can only send events, never read them.

| Where | Variable | Production value |
| --- | --- | --- |
| Vercel, **Production** environment | `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` | `phc_mGDVc9bPoA7jFiGH6ygaqGEDeXXkuzP7yKFVSnx4AjkT` |
| Vercel, **Production** environment | `NEXT_PUBLIC_POSTHOG_HOST` | `https://us.i.posthog.com` |
| Cloud Run `paralegix-api` | `POSTHOG_PROJECT_TOKEN` | `phc_mGDVc9bPoA7jFiGH6ygaqGEDeXXkuzP7yKFVSnx4AjkT` |
| Cloud Run `paralegix-api` | `POSTHOG_HOST` | `https://us.i.posthog.com` |
| Cloud Run `paralegix-api` | `POSTHOG_PROJECT_ID` | `623394` |
| Cloud Run `paralegix-api` | `POSTHOG_PERSONAL_API_KEY` | A **secret** personal key with person write scope on the production project. Account erasure uses it to delete the person from PostHog, which the privacy policy promises. Store it like the other secrets, never in this doc. |

Set the Cloud Run variables with the command below. Put the production personal key (from your
password manager, label `paralegix-backend-production`) in place of `phx_...`. Run it in a
terminal whose history you clear afterwards, since the key is a secret.

```bash
gcloud run services update paralegix-api --region us-east4 \
  --update-env-vars POSTHOG_PROJECT_TOKEN=phc_mGDVc9bPoA7jFiGH6ygaqGEDeXXkuzP7yKFVSnx4AjkT,POSTHOG_HOST=https://us.i.posthog.com,POSTHOG_PROJECT_ID=623394,POSTHOG_PERSONAL_API_KEY=phx_...
```

Without the personal key, deleting an account silently leaves its analytics in PostHog, which
breaks a promise in the privacy policy. Staging already has its own key (project `623432`).

Unset means analytics is off, not broken, so a missed variable fails silently: check the
production project's Activity tab for events after the first login.

## 5c. Legal and privacy before launch

These were deferred while the product ran on staging. Each one is either something the public
legal pages already promise, or a gap a careful reviewer would find.

1. **Legal entity.** The business is not incorporated, but the pages name "Paralegix Inc.":
   the privacy policy (§1), the terms (§1, liability, indemnification, and governing law, which
   points at "the jurisdiction in which Paralegix Inc. is incorporated"), the marketing footer
   ("© Paralegix, Inc.") and `legalName` in `frontend/src/lib/seo/structuredData.ts`. Incorporate
   before launch, or replace these with the real operators and trade name and name an actual state
   in the governing-law clause. A liability cap that protects a company that does not exist
   protects no one.
2. **Re-sign the PostHog DPA** under the incorporated company's name at `app.posthog.com/legal`.
   The current one was signed on 2026-09-22 by a founding partner as Partner, before incorporation.
3. **Publish a privacy contact** in the privacy policy's Contact section: the name or title of the
   person responsible for privacy, an email address (for example `privacy@paralegix.com`) and a
   postal address. Canadian federal law, Quebec's Law 25 and the GDPR each require one.
4. **Email footer.** The policy (§10) says every email carries our postal address and a link to
   manage email preferences. Set `COMPANY_POSTAL_ADDRESS` on both Cloud Run services (today the
   footer prints "[physical mailing address not set]") and add it to `backend/.env.example`. The
   footer link goes to `/account`, which has no email settings: point it at the notification
   settings, or change the policy's wording to match.
5. **Policy version and notice.** The policy promises at least 30 days' email notice before a
   material change. If real users signed up before the analytics changes, email them, and bump
   `POLICY_VERSION` (backend env, default `1.0`) so new consent records carry the new version.
6. **Keep the records** in the company's legal folder, not this repository: the signed PostHog DPA
   PDF, and a dated screenshot of PostHog's organization settings with **Internal AI training** off.
7. **Questions for a lawyer**, none of which the code can settle:
   - Whether tying a client-portal user to their firm in analytics reveals the attorney-client
     relationship (ABA Model Rule 1.6), and whether firm contracts permit it.
   - Whether EU/UK tracking means appointing an Art. 27 representative, or whether PostHog should
     simply never start in the ask-first regions.
   - When the CCPA and other state laws start to apply, given revenue and user thresholds.
   - Quebec: the terms say the Service is not offered in Canada. Confirm that is enough, given
     that server-side events have no "legitimate interests" basis there and Quebec requires
     consumer terms in French.
   - Whether contracts signed before incorporation, including the DPA, bind both partners.

---

## 6. Suggested sequencing

1. Stand up production Supabase, apply schema, record the existing numbered migrations (§2).
2. Live Stripe setup — webhooks, Connect activation, prices (§4). Start early: Connect
   activation and firm re-onboarding have external lead time.
3. Get an explicit owner decision on the Direct Charge Migration liability question (§4).
4. Verify the mobile PDF polyfill question (§0).
5. Cutover: flip Cloud Run traffic and DNS, then smoke test. There is no data to move.

## 7. Verification checklist

- [ ] Production Supabase project provisioned, schema applied from `schema.sql`, every file
      in `backend/db/migrations/` recorded in `schema_migrations` with `--record-only`
- [ ] Production connection budget re-measured; `PG_POOL_MAX` / `_MAX_INSTANCES` consistent
      with it
- [ ] Fresh backend image pushed to Artifact Registry for the production trigger
- [ ] `RBAC_ENFORCED=true` set on the production Cloud Run service (`cloudbuild.yaml` does not
      pass it, and unset gives every member every permission; see [Staging Setup](/STAGING_SETUP))
- [ ] `housekeeping` cron scheduled
- [ ] `signing-jobs` cron scheduled with `x-cron-secret`, and its Scheduler log shows no
      `PERMISSION_DENIED`
- [ ] Production signing certificate provisioned (`SIGNING_P12_PATH` + `P12_PASSPHRASE`), and a
      test document signs through to a downloadable executed copy
- [ ] Live Stripe webhooks registered and receiving events
- [ ] Live Stripe Connect activated; at least one firm completes onboarding end to end
- [ ] Live Price/Product ids set for all 3 tiers × 2 billing periods
- [ ] Direct Charge Migration liability question has an explicit owner decision on record
- [ ] Mobile PDF rendering verified on an old iOS Safari / Android Chrome device
- [ ] PostHog production token set on Vercel Production and on `paralegix-api` (§5b), and a
      login shows up in the production PostHog project
- [ ] `POSTHOG_PROJECT_ID` and the production `POSTHOG_PERSONAL_API_KEY` set on `paralegix-api`
      (§5b), and deleting a throwaway account removes its person from the production project
- [ ] Legal entity settled and every page that names "Paralegix Inc." matches it (§5c.1)
- [ ] PostHog DPA re-signed under the company name (§5c.2)
- [ ] Privacy contact published in the privacy policy (§5c.3)
- [ ] `COMPANY_POSTAL_ADDRESS` set on Cloud Run, and the email footer link matches the policy (§5c.4)
- [ ] Existing users notified and `POLICY_VERSION` bumped, if anyone signed up before (§5c.5)
- [ ] DPA PDF and PostHog settings screenshot filed with the legal records (§5c.6)
- [ ] Lawyer's answers on the §5c.7 questions on record
- [ ] Vercel production env vars point at the new API URL, Supabase project, and live Stripe
