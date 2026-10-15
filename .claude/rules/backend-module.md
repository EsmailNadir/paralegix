---
paths:
  - "backend/src/modules/**"
  - "backend/src/app.ts"
---

# Backend module patterns

Every module lives at `src/modules/<domain>/` with `.routes.ts`, `.service.ts`, `.repository.ts`,
`.validation.ts` and an optional `.events.ts`. Scaffold a new one with the `new-backend-module`
skill; it also registers the router, adds permission codes and writes the first route test.

## Read the feature doc first

Most modules have an engineering reference under `docs/features/`. It cites `file:line`. Open it
before changing behaviour, and update it when the behaviour changes. `audit` and `privacy` are
covered by `docs/dev/security/audit-logging.md` and `privacy-data-rights.md`; `subscriptions` and
`users` have no dedicated doc, so read the code there.

| Module | Doc |
|---|---|
| `admin` | `docs/features/admin-console.md` |
| `auth` | `docs/features/authentication.md` |
| `catalog`, `courts`, `practiceAreas`, `noteTypes`, `noteTemplates` | `docs/features/reference-data.md` |
| `documentRequests`, `share` | `docs/features/document-requests.md` |
| `billing` | `docs/features/billing.md` |
| `calendar` | `docs/features/calendar.md` |
| `clients` | `docs/features/clients.md` |
| `contacts` | `docs/features/contacts.md` |
| `dashboard` | `docs/features/dashboard.md` |
| `files` | `docs/features/files.md` |
| `identityVerification` | `docs/features/identity-verification.md` |
| `invitations` | `docs/features/invitations.md` |
| `lawfirms`, `lawfirms/roles` | `docs/features/lawfirms-rbac-plans.md` |
| `leads`, `intake` | `docs/features/leads.md` |
| `matters` | `docs/features/matters.md` |
| `messaging` | `docs/features/messaging.md` |
| `notifications` | `docs/features/notifications.md` |
| `settings` | `docs/features/settings.md` |
| `signatures` | `docs/features/e-signatures.md` |
| `stripe` | `docs/features/stripe-payments.md` |
| `tasks` | `docs/features/tasks.md` |
| `templates` | `docs/features/templates.md` (document templates only, not note templates) |
| `trust` | `docs/features/trust-accounting.md` |
| search across modules | `docs/features/server-side-search.md` |

## Tenant scoping is the application's job

Tenant keys and foreign-key conventions are defined in `AGENTS.md` under Data Model. Postgres RLS covers
only the messaging, notification and signature tables; the backend connects as `postgres` and
bypasses it everywhere else. Scoping is enforced by the audited Drizzle query contexts
(`tenantQuery`, `firmQuery`, `systemQuery`, `adminQuery` and `tokenQuery`, the exact set in `AUDITED_QUERY_CALLS` in `backend/eslint.config.mjs`), which the custom
ESLint rule `paralegix/safe-drizzle-boundary` requires. Never reach the raw executor.

Use `assertLawFirmMembership` and `assertMatterMembership` from `shared/utils/membership`.

**The first test case for any new route is a caller from another firm.** The harness gives you
`stranger()` and a second firm's owner. A route that returns 200 to the wrong firm is the most
expensive defect this codebase can ship, and it never looks wrong on screen.

## An uncalled route is not automatically dead

A route with no frontend caller may be a genuine UI gap. Delete one only when a newer route
demonstrably replaced it. Otherwise report it as missing UI.

## Route Pattern

**Middleware order:** `verifyToken → requirePermission → [validate, requireTimezone] → handler`. `verifyToken`
and `requirePermission` always come first; `validate` and `requireTimezone` (when the route needs it) are
independent of each other and appear in either order across the codebase. Don't treat one order as the rule
when writing or reviewing a route.

**No try/catch in a handler.** Express 5 forwards a rejected promise from an async handler to
the error middleware itself, so `try { … } catch (err) { next(err) }` is pure noise. Write the
happy path and let it throw. Keep a `catch` only when it does real work (mapping a Firebase auth
code to a 401, logging context, cleaning up a partial upload), and take `next` as a parameter
only when you actually call it.

A sweep removed the pass-through form from most routes, and the last known survivor is
in `clients/portal/portal.routes.ts`. Any that remain are
leftovers, not precedent. Delete one if you are already editing the handler; do not copy the
shape into a new route. Counting them by hand drifts, so re-derive instead. The
`catch` spans several lines, so a line-based grep finds none; match the AST:

```bash
ast-grep run -l ts -p 'try { $$$ } catch ($E) { next($E); }' backend/src --globs '*.routes.ts'
ast-grep run -l ts -p 'try { $$$ } catch ($E) { return next($E); }' backend/src --globs '*.routes.ts'
```

**Wrap every handler in `handler()`** from `backend/src/shared/http/handler.ts`. It types `req`
(authenticated user presence and string-valued params; param names remain unrestricted), and it sends what the
handler RETURNS, so the status lives in one place per route instead of at every `res.json`.
A handler that needs the response object itself (a stream, a redirect, a download) takes `res`
as a second argument and writes to it.

```ts
import { handler } from '../../shared/http/handler';

const router = express.Router({ mergeParams: true });

router.get('/',
  verifyToken,
  requirePermission('domain.view'),
  requireTimezone,                    // omit if not time-aware
  handler(async (req) => service.listX({
    lawFirmId: req.params.lawFirmId, userId: req.user.uid, timezone: req.tz,
  }))
);

router.post('/',
  verifyToken,
  requirePermission('domain.create'),
  validate(createXSchema),
  requireTimezone,
  handler(async (req) => service.createX({
    lawFirmId: req.params.lawFirmId, userId: req.user.uid, timezone: req.tz, ...req.body,
  }), 201)                            // 201 for POST, 200 for everything else
);
```

Remaining legacy handlers spell out `async (req: any, res: any)` with an explicit
`res.status().json()`. They are the pre-`handler()` shape, not precedent. Convert one if you
are already editing it; never copy it into a new route. Re-derive the remaining locations:

```bash
grep -rc 'async (req: any, res: any' backend/src --include='*.routes.ts' | grep -v ':0'
```

List routes must come before `/:id` wildcard routes.

**Notes routes are generated, not written.** Matter, task and client notes share one REST surface
via `createNotesRouter()` (`backend/src/shared/notes/notesRouter.ts`): pass the `:param` name, the two
services, the module's validation exports, and one permission per route group. Routes an entity
has on top of the shared fourteen are mounted onto the returned router (see
`matterNotes.routes.ts`). Adding a shared notes endpoint means editing the factory once.

## Service Pattern

Functions receive a **destructured object** (never `req`/`res`):
```ts
async function createX({ lawFirmId, userId, timezone, name, optionalField }) {
  await assertLawFirmMembership(lawFirmId, userId);   // always first
  // if (matterId) await assertMatterMembership(lawFirmId, matterId, userId);

  if (!name?.trim()) throw new ValidationError('Name is required');

  const created = await xRepo.create(lawFirmId, { name: name.trim(), createdBy: userId });

  eventBus.emit(X_CREATED, { lawFirmId, entityId: created.id, entityData: created, userId, timeZone: timezone });

  return { message: 'X created successfully', xId: created.id, x: formatX(created, timezone) };
}
```

## Response Envelopes

| Operation | Shape |
|---|---|
| List | `{ items: [...], totalItems: N }` (or domain-specific e.g. `{ tasks, totalTasks }`) |
| Create | `{ message: 'X created successfully', xId: id, x: formatted }` |
| Update | `{ message: 'X updated successfully', x: formatted }` |
| Delete | `{ message: 'X deleted successfully', xId: id }` |
| Bulk | `{ message, requested, updated/deleted, failed, errors: { id: reason } }` |

Never return bare arrays at root level.

## Validation (Zod)

```ts
import { z } from 'zod';

const createXSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(500),
    status: z.enum(['active', 'inactive']).optional(),
    tags: z.array(z.string()).optional(),
  }),
  params: z.object({ lawFirmId: z.string() }),
  query: z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),  // z.coerce for query strings
  }),
});
```

`validate()` middleware calls `schema.safeParse({ body, query, params })` and throws `ValidationError` on failure.

## Errors

```ts
throw new NotFoundError('Resource name');   // 404
throw new ForbiddenError('reason');         // 403
throw new ValidationError(details);        // 400
throw new ConflictError('message');        // 409
```

All from `backend/src/shared/errors/AppError.ts`. The centralized `errorHandler` catches them — never call `res.status()` in a service, and prefer throwing AppErrors over `res.status(4xx).json(...)` in routes too (the handler adds `requestId` and 403 security-event flagging).

Error envelope: `{ error, code, details?, requestId }` (a plain error without a string `code` omits `code`). `error` is user-facing copy, so write it for the end user. `ValidationError` accepts a string, a Zod `flatten()` result, or a `{ field: ['msg'] }` map and surfaces the first message as the top-level `error`. An `AppError` message reaches the client verbatim at any status, 5xx included (a 503 from `busyGate.ts`, the calendar services' 500s), so its text must be safe to show. Only plain errors are scrubbed: their 5xx messages and any third-party SDK (gaxios/axios/Stripe) message are replaced with generic copy and logged with the requestId instead.

