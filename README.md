# Paralegix

Paralegix is a case management product for small law firms: matters, tasks, clients, time and
billing, trust accounting, documents, e-signatures, calendar sync, and a separate client portal,
all multi-tenant so each firm's data stays its own.

> **Reviewer, start here:** the [Credence ID identity verification](#identity-verification-with-credence-id)
> module below is the piece this sample is meant to show.

## Built with AI tools

This codebase was built with AI coding assistants (Claude Code) working under human direction. The
repository carries the guardrails that make that workable: [`AGENTS.md`](AGENTS.md) holds the
repo-wide rules every agent follows, `.claude/` holds the project's skills, review agents and the
hooks that block risky edits, and every change is expected to ship with tests that fail without it.
Design decisions, the tests that pin them, and the verification commands were directed and reviewed
by a person.

## Identity verification with Credence ID

A client opens the portal, taps **Verify with my phone's wallet**, and presents the mobile driver's
license in Apple Wallet (or Google Wallet, or a state wallet app over a QR code). The firm then sees
an **ID verified** badge on that client's record with the checked name, issuing state and time.
Verification runs through the [Credence ID Cloud SDK](https://credenceid.com/mobile-id/developer-documentation/sdk-reference/)
and the browser's Digital Credentials API.

### Where to look first

| File | What it shows |
|---|---|
| [`backend/src/modules/identityVerification/credence.client.ts`](backend/src/modules/identityVerification/credence.client.ts) | Server-side Credence client: token cache with refresh, single-flight setup, explicit `Origin`, provider errors mapped to safe messages |
| [`backend/src/modules/identityVerification/identityVerification.service.ts`](backend/src/modules/identityVerification/identityVerification.service.ts) | Start, complete and poll; session binding; claim extraction; data minimization; name matching |
| [`backend/src/modules/identityVerification/identityVerification.portal.routes.ts`](backend/src/modules/identityVerification/identityVerification.portal.routes.ts) | Client-portal routes (start, complete, poll, status) |
| [`backend/src/modules/identityVerification/identityVerification.routes.ts`](backend/src/modules/identityVerification/identityVerification.routes.ts) | The firm-side read behind the badge |
| [`backend/db/migrations/0049_client_identity_verifications.sql`](backend/db/migrations/0049_client_identity_verifications.sql) | The table, with tenant-scoped composite foreign keys |
| [`backend/tests/identityVerification/`](backend/tests/identityVerification/) | Route and client tests, cross-firm access first |
| [`frontend/src/hooks/useIdentityVerification.ts`](frontend/src/hooks/useIdentityVerification.ts) | Wallet flow (pointerdown prefetch so the wallet opens inside the iOS user gesture) and the QR + polling fallback |
| [`frontend/src/app/client/lawfirm/[lawFirmId]/identity/page.tsx`](frontend/src/app/client/lawfirm/[lawFirmId]/identity/page.tsx) | The portal page and its states |
| [`frontend/src/components/clientComp/IdentityVerifiedBadge.tsx`](frontend/src/components/clientComp/IdentityVerifiedBadge.tsx) | The badge on the firm's client record |
| [`docs/features/identity-verification.md`](docs/features/identity-verification.md) | Full feature write-up |

### Design decisions

- **The license key never reaches the browser.** Credence's sample app ships the key in the
  frontend bundle; here the backend holds it and proxies every Credence call.
- **A verification is bound to one client and one user.** Credence's session id is stored against
  `(law_firm_id, client_id, user_id)` and never sent to the browser. Completing it is accepted once,
  only from the user who started it, within 10 minutes, so a replayed or stolen session is useless.
- **Data minimization.** Only the given and family name, issuing jurisdiction, document type,
  credential expiry, the pass or fail of each check, and whether the name matches the client
  record are kept. The portrait, license number, address and birth date are never stored, returned
  or logged, and tests assert it.
- **A name mismatch is a flag, not a failure.** "Jon Smith" against a record for "Jonathan Smith" is
  still verified, and the firm sees "Verified, name differs" so a person decides.
- **Tenant isolation is tested first.** Every route's first test is a caller from another firm
  getting 403 or 404.

**Status:** the backend calls Credence's live API successfully (setup, token reuse, mdoc request,
W3C request and polling), and the mdoc request Credence returns is signed (`readerAuth`), which
Apple Wallet requires. The full phone-to-badge flow needs a public HTTPS origin registered with
Credence; see the feature doc.

## Also in this sample: three template engines behind one toggle

The Templates page switches, per user, between two existing template builders (a PDF field overlay
and an HTML/Word editor) and a third, "Word-first" library. Word-first keeps an uploaded `.docx`
byte for byte: it scans the document for blanks (Word form fields, highlights, `[BRACKETED]`
markers, labels, value shapes, repeating rows), lets the user review and name them, rewrites only
those words inside the Word XML, and fills the original file in place, so formatting survives.
Start at `backend/src/modules/wordTemplates/` and `frontend/src/components/wordTemplates/`.

## Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16, React 19, TypeScript, React Query |
| Backend | Express 5, TypeScript, Drizzle ORM over Postgres |
| Data | Postgres (schema in `backend/db/schema/*.sql`, numbered migrations) |
| Auth | Firebase Auth |
| Storage | Google Cloud Storage |
| Tests | Jest on both sides; backend route tests run against real Postgres |

## Repository layout

```
backend/    Express API: src/modules/<domain>/{routes,service,repository,validation}.ts
frontend/   Next.js app: src/app (routes), src/components, src/services, src/hooks
docs/       VitePress documentation site (user guide plus engineering reference in docs/features/)
infra/      Deployment configuration
.claude/    AI agent skills, review agents and guard hooks
```

## Running it locally

Requirements: Node 22+, Docker (or Podman) for Postgres, and a Firebase project for sign-in.

```bash
# 1. Postgres on port 5433
docker run --name paralegix-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=paralegix \
  -p 127.0.0.1:5433:5432 -d postgres:17

# 2. Supabase roles and helpers the schema expects, then the schema itself
docker exec -i paralegix-pg psql -U postgres -d paralegix < backend/scripts/test-db-shim.sql

# 3. Backend: copy the env template and fill in your own values
cd backend && cp .env.example .env && npm install
npx tsx db/apply-schema.ts && npm run dev        # http://localhost:5001

# 4. Frontend
cd ../frontend && npm install && npm run dev      # http://localhost:3000
```

`backend/.env.example` lists every variable. The identity verification feature needs the four
`CREDENCE_*` variables; without them the portal shows verification as unavailable.

## Tests

```bash
cd backend  && npm run typecheck && npm run lint && npm run test:db && npx jest tests/identityVerification
cd frontend && npm run ci:checks && npm run test:unit
```

## License

All rights reserved. This repository is published as a code sample for review; it is not licensed
for reuse.
