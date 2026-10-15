# Data, state, navigation, permissions

---

## Where code goes

| Path | Holds |
|---|---|
| `src/app/` | App Router pages — thin wrappers |
| `src/components/[domain]Comp/` | Feature components (Grid, CreateModal, EditModal co-located) |
| `src/components/ui/` | Shared primitives **only** |
| `src/hooks/[domain]Hooks/` | Hooks per domain |
| `src/services/[domain].service.ts` | One API service class per domain |
| `src/constants/` | `statusMeta.ts`, `taskConstants.ts`, `stageColors.ts` |
| `src/contexts/` | Twelve providers, incl. `PermissionsContext`, `PreferencesContext`, `NavigationContext`, `LawFirmContext`, `FirmSettingsContext` |

Path alias `@/*` → `./src/*`.

**Auth is not a context.** Read the Firebase user through `useAuth()` from `@/hooks/useAuth`.
(A second `src/context/AuthContext.js` once existed whose provider was never mounted, so every
consumer silently got an undefined user. It is gone — don't recreate it.)

---

## Navigation

Use `navigate()` from `useNavigation()` — it shows the loading spinner immediately.

```tsx
import { useNavigation } from "@/contexts/NavigationContext";
const { navigate } = useNavigation();
navigate(`/lawfirm/${lawFirmId}/matters/${matterId}`);
```

**This rule governs in-app feature navigation.** The exceptions are real and systematic — don't
"fix" them:

| Exception | Why |
|---|---|
| Auth and onboarding flows (`login`, `register`, `verify-email`, `auth/action`, `accept-*-invite`, `reset-password`) | Not feature navigation; often `router.replace()` to avoid a back-button trap |
| Layout guards (`app/*/layout.tsx`) redirecting an unauthorised or unverified user | Same |
| Marketing pages and `marketingComp/` | Separate surface, uses `router.push()` |
| The admin console (`app/admin/*`) | Separate surface |
| Sidebar logout | Leaves the app shell |
| Legal/status pages (`LegalPageHeader`, `LegalPageFooter`, `StatusPage`) | Standalone pages |

Inside `/lawfirm/*` and `/client/*` feature code, `navigate()` is the only correct answer.

---

## Data fetching

React Query hooks in `src/hooks/[domain]Hooks/`:

```ts
const { data, isLoading, error, refetch } = useQuery<X[]>({
  queryKey: ['domain', lawFirmId],
  queryFn: () => XService.list(lawFirmId!),
  enabled: !!lawFirmId,
});
```

After a mutation: `queryClient.invalidateQueries({ queryKey: ['domain', lawFirmId] })`.

- **GET** goes through `BaseApiService.dedupedGet`, which wraps `requestDeduplicator.execute`.
- **Mutations** go through `apiFetch` (`lib/utils/fetchWithTokenRefresh`), or `publicFetch` for an
  unauthenticated call. A plain `fetch` in `src/services/` fails `scripts/check-service-transport.mjs`.
- Normal `apiFetch` requests default to `'x-timezone': getUserTimeZone()`, preserving a caller's
  header. `timezone: false` opts out; `publicFetch` does not add it automatically.
- A modal that fetches at top level must guard it (`enabled: open`) so it doesn't fetch while
  closed.

---

## Paging — pick the right hook

This is how lists actually get their data (41 files). `ListView` renders; these two hooks decide
*what* it renders.

### `useServerTable` — the server pages, filters and sorts

For any list that can grow unbounded (matters, tasks, contacts, time entries). Owns page,
page size, sort model, filter bag, and a split search value: the raw input updates on every
keystroke so the field stays snappy, while only the debounced value reaches `queryParams` and
therefore the network.

Every input that changes the result set resets to page 1, so a change can never strand the view
past the end. Pair it with `recoverOutOfRangePage()` for the case where the current page's rows
were all deleted.

Filter values are the raw strings the server expects, and a key is **absent** rather than empty
when it isn't filtering — so it never reaches the query string or the React Query key.

### `usePagedRows` — the whole set is already in memory

For billing's derived views, where the money totals above the list are computed from the entire
loaded set and only the on-screen slice is windowed.

Pass a `resetKey` built from every input the row set depends on (search string, status filter,
folder id, joined into one value). Without it, refining a search from page 3 silently shows the
third page of the new matches instead of the best ones. The page is clamped on read rather than
reset in an effect, so a shrinking filter lands on the last page still holding rows instead of
flickering through an out-of-range render.

### Loading states while paging

Keep React Query's `loading` for the **initial** load (rendered as `<ListSkeleton>`) and use the
separate `fetching` flag for a page change, which `ListView` renders in place — otherwise
changing page collapses the whole list.

---

## Modal and mutation state

State lives in hooks under `src/hooks/[domain]Hooks/`, not in components. A create/edit hook
owns `open`, the form fields, `submitting`, `reset()`, and a `submit(setError)` that calls the
service, invalidates the query, closes, resets, and maps errors to a message on failure.

Page wrappers hold no modal state.

---

## Services and errors

On a failed response a service throws `ApiError` — never `new Error(body.error)` — so status,
code, details and requestId survive to the UI. From `@/lib/utils/apiErrors`:

```ts
throw await toApiError(response, '<fallback>');            // body not yet parsed
throw ApiError.fromResponse(response, body, '<fallback>'); // already parsed
```

In components, render with `getErrorMessage(err)` or pass the Error straight to
`<ErrorNotification error={err} />`, which renders field-level validation from an `ApiError`
automatically.

---

## Permissions

Frontend RBAC is **UI-only**; the backend enforces everything. Never treat a frontend gate as
security.

```tsx
<RequirePermission permission="domain.view"> … </RequirePermission>
const { hasPermission } = usePermissions();
{hasPermission("domain.create") && <CreateButton />}
```

`<RequireFeature>` gates on plan/feature flags. The client portal has no RBAC — only the client
identity link.

---

## Libraries

Tailwind v4, TanStack React Query, TipTap, dnd-kit, react-pdf / `@react-pdf/renderer`,
Framer Motion, recharts.

**There is no component library.** Every primitive is local, in `src/components/ui/`. MUI,
Chakra UI, Ant Design, and AG Grid are **not** installed — lists are `ListView`, not a grid
library, and tooltips are `@/components/ui/Tooltip`, not `@mui/material`. `@mui/material` and
its `@emotion/react` / `@emotion/styled` peers were removed once `Tooltip` was the only thing
still importing them; do not add a UI dependency back to get one component.

**Match what the surrounding code uses** before adding new UI, and check `package.json` before
importing anything else.

**SSR:** Firebase client imports must use dynamic `import()`, never a static top-level import.

---

## Bundlers

Dev runs on Turbopack; production builds run on webpack (`next build --webpack`), because
`pdfjs-dist` 5.x breaks under webpack's eval-based dev devtools. Each has its own alias block in
`next.config.ts` (`turbopack.resolveAlias` vs `webpack()`) — **a bundler-level change must be
made in both.**

`next build` type-checks but does **not** lint (Next 16 removed build-time ESLint), so a type
error fails the Vercel build while a lint error does not. Lint is enforced only by
`npm run lint` / `npm run ci:checks`.
