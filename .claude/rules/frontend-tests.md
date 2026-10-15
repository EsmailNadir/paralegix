---
paths:
  - "frontend/tests/**"
  - "frontend/jest.config.js"
---

## Tests

A frontend Jest suite lives under `frontend/tests/` (`app`, `components`, `contexts`, `hooks`, `styles`,
`lib`, `perf`, `services`, `utils`, plus the `support/` harness), config in `frontend/jest.config.js`. **Tests are required, not optional**;
see the root `AGENTS.md` for the rule. How the suite splits:

```bash
npm test              # alias for test:unit; the OFFLINE half only, not everything
npm run test:unit     # jsdom unit specs; excludes tests/perf and every *.live.test.* file
npm run test:services     # LIVE: tests/services/services.live.test.ts only
npm run test:integration  # LIVE: services.live.test.ts + tests/hooks/hooks.live.test.ts
npm run test:all      # every suite
npm run test:perf     # tests/perf
```

The live half needs a running backend, `MOCK_FRONTEND_SERVICES=0`, and a Firebase ID token in
`__TEST_TOKEN__`. The two halves need opposite `MOCK_FRONTEND_SERVICES` values, so one combined
run can never pass. See `frontend/tests/services/README.md`.

`npm run ci:checks` deliberately does not run Jest.

### A trap before you write a component test

`frontend/tests/setup.ts` globally replaces 20+ service modules with a Proxy whose every method resolves
to `{}`, and forces `hasPermission: () => true`. So by default a component test CANNOT fail
because a service returned the wrong shape, because an endpoint answered 403, or because a
permission was missing. It only checks that the component renders given fabricated data.

**Use `frontend/tests/support/` instead.** It fakes the TRANSPORT rather than the services, so the whole
service layer stays real: url building, query parameters, response parsing and `ApiError`
handling all execute.

| File | What it gives you |
|---|---|
| `apiMock.ts` | `installApiMock()` → `api.get('/clients', {...})`, `api.getExact(fullUrlWithQuery, ...)`, `api.post(...)`, `api.calls()`, `api.callsTo(path)`. An **unmatched request throws** AND is recorded, so `restore()` fails the spec even when the caller catches the error; call `api.allowUnhandled()` when the refusal is the subject. Answer with `{ status: 403, body: {...} }` for an error path, `{ status: 200, text: '<html>' , headers: {...} }` for a non-JSON one, `{ delayMs }` for a loading state or a deadline, and `sequence(a, b)` when the same route must answer differently on the retry. The fake honours `signal`, so timeout, caller-abort and unreachable-network all reach their real branches. |
| `permissions.ts` | `grantBaselineMember([extra])`, `grantReadOnly()`, `grantOutsider()`, `grantPermissions([...])`, and `resetPermissions()`. The real permission answers, so the read-only degradation rule can finally be asserted. Reach for a baseline-aware preset when the case is a PERSON: every firm member carries a 23-code baseline, unioned in independently by the backend and the frontend, so only a non-member holds nothing. `grantPermissions` stays an exact set, for a case about what a component is told. **Call `resetPermissions()` in `afterEach`**: the object is shared, and a spec that narrows it without restoring breaks the next spec somewhere unrelated. |
| `renderWithProviders.tsx` | `renderWithProviders(<Thing />)` with a FRESH `QueryClient` per render and `retry: false`. A shared client would hand the second spec the first spec's cached data. |
| `accessibility.ts` | `scanAccessibility(container)` runs axe-core against rendered components or pages and returns the full result; assert `expect((await scanAccessibility(container)).violations).toEqual([])`. It checks the WCAG 2.0/2.1/2.2 A and AA DOM rules. `color-contrast` is disabled because jsdom cannot measure layout, so a pass says nothing about contrast. |
| `screenReaderNarrator.ts` | `narrateElement(element)` builds a simulated VoiceOver/NVDA utterance from the accessibility tree (roles, accessible names, descriptions, valid/invalid states, checked, required, dimmed). It approximates a screen reader; it does not replace a manual pass. |
| `xhrMock.ts` | `installXhrMock()` for the upload paths `apiMock` cannot see, since uploads are hand-built on `XMLHttpRequest`. `xhr.onExact(method, url, ...)` matches the complete path; plain `on` is a substring match and will answer another firm's upload. Same unhandled-request rule as `apiMock`. |

Unmock the service and the deduplicator at the top of the file:

```ts
jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');
```

Worked examples: `frontend/tests/components/clients/ClientContacts.test.tsx` (transport + error paths),
`frontend/tests/components/clients/ClientContactsPermissions.test.tsx` (narrow roles), and
`frontend/tests/contexts/PermissionsContext.test.tsx` (the real RBAC context). The older
per-file `jest.mock` style in `frontend/tests/components/billing/OrgAccessModal.test.tsx` still works,
but prefer the harness for new specs.

A component test written without one of these overrides is decoration.

