# Frontend service integration tests

These are **live** integration tests: they exercise the real frontend service classes
against a running backend over HTTP (not jsdom unit tests). They are excluded from the
plain unit run via `npm run test:unit`.

> The four live hook suites (`tests/hooks/useBillingWorkbench|useTasks|useTrustAccounts|
> useTrustTransactions`) have the same requirements as this directory and run under
> `npm run test:integration` alongside it.
>
> **`npm test` runs the unit suite only.** The two halves need opposite settings of
> `MOCK_FRONTEND_SERVICES`, so a single run covering both can never pass; use
> `npm run test:integration` for these, or `npm run test:all` to run every suite.

## Requirements

- The backend dev server must be running (default `http://127.0.0.1:5001`).
- The global frontend-service mock must be **off** (`MOCK_FRONTEND_SERVICES=0`), otherwise
  each service under test is replaced by a stub in `tests/setup.ts`.
- A Firebase ID token for a test account must be exported as `__TEST_TOKEN__` (or `TEST_TOKEN`).
  Tokens last ~1h; re-fetch if you see auth errors.
- Either `127.0.0.1` or `localhost` works for the API host. A one-off `ECONNRESET` here
  almost always means the backend was mid-restart (`node --watch` picked up an edit), not
  an address-family problem; re-run once the server is back up.

The test account belongs to more than one firm; `tests/services/_firm.ts` resolves the correct
firm ("Test3 Test Firm", full permissions) rather than blindly taking `lawFirmIds[0]`. The live
hook suites use the same resolver for the same reason.

## Running

```bash
cd frontend
export __TEST_TOKEN__=$(node -e 'fetch("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=$FIREBASE_WEB_API_KEY",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:"test3@gmail.com",password:"password",returnSecureToken:true})}).then(r=>r.json()).then(d=>process.stdout.write(d.idToken))')
export MOCK_FRONTEND_SERVICES=0
export NEXT_PUBLIC_API_URL=http://127.0.0.1:5001/api
npm run test:integration         # this directory + the four live hook suites
npm run test:services            # or: npx jest tests/services/<file>.service.test.ts
```

`npm test` (= `npm run test:unit`) runs everything **except** these live suites and the
perf benchmarks, and needs none of the above.
