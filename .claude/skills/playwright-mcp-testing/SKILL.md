---
name: playwright-mcp-testing
description: Drive the Paralegix app in a real browser with Playwright MCP: manual UI testing, reproducing a frontend bug, testing role and permission behavior.
disable-model-invocation: true
---

# Playwright MCP Testing (Paralegix)

## Prerequisite: the Playwright MCP server

This skill drives the `mcp__playwright__*` tools. They come from an MCP server that is NOT
configured in this repo or in the user's Claude config, so they are usually absent. Check that
the `mcp__playwright__*` tools are actually available before following any step below. If they
are not, say so and stop rather than substituting another browser. The Browser pane
(`mcp__Claude_Browser__*`) is a different tool family with different tool names, and this
skill's selectors, waits and navigation notes were written against Playwright.

`preview_start` is the one exception: it belongs to the Browser pane and is always available.
That is why the server-start step below uses it.

## Overview
Drive the running Paralegix frontend (`localhost:3000`, backend `localhost:5001`) in a real browser via the `mcp__playwright__*` tools. Use this to manually exercise UI flows, reproduce bugs, and verify changes against real data in the local Podman Postgres.

## Starting servers
If the app isn't already running, start what you need with `preview_start` and the launch-config
names from `.claude/launch.json`:

1. `preview_start` with `{ name: "backend" }` → http://localhost:5001
2. `preview_start` with `{ name: "frontend" }` → http://localhost:3000

**Never start a dev server with `npm run dev` in Bash** — dev servers go through the Browser pane
so they stay listable and stoppable. (The `run-local` skill exists for the separate "spin up the
whole stack" request; you do not need it here, and it should not be invoked on your own initiative.)

The frontend prefers port 3000 but tolerates a spill to 3001/3002 — the backend's default CORS
origins cover all three (the `localhost:3000/3001/3002` entries in the CORS allowlist in
`backend/src/app.ts`). Only free the port if you specifically need
the OAuth redirect to match a `localhost:3000` callback.

**You MUST stop any server you started once you're done** — `preview_list`, then `preview_stop` on
each `serverId` you launched. If a server was *already* running when you started, leave it alone.

## Test accounts
These are the canonical local-dev test accounts. Both account types exist in the same firm:

- **Firm owner / member** — `test3@gmail.com` / `password`, owns "Test3 Test Firm". Belongs to more
  than one firm, so login may land on either; navigate directly to
  `/lawfirm/1354e5d3-1b94-46b2-b78d-0e04faece7d4` to land on "Test3 Test Firm".
- **Client (portal)** — `test3client@gmail.com` / `password`, portal at `/client/dashboard`.

Both emails are pre-verified. Log in through the UI (it mints a fresh Firebase token). The persisted browser profile may already be signed in as the client — sign out and re-login as `test3@gmail.com` for firm-member pages.

## Changing roles / giving yourself admin
This is local dev with full DB access — you can grant yourself whatever permissions a test needs. To test admin-only or permission-gated behavior, edit the `roles` / `members` rows in Postgres directly (the firm owner's role permissions, or swap a member's `role_id`), then **clear the browser's Firebase session and re-login** so the new claims/permissions apply. Roles are `text[]` permission arrays on the `roles` table scoped by `law_firm_id` — see the Table Inventory in `.claude/rules/backend-data-model.md`. Feel free to create roles, add permissions, or promote the test member to admin as the test demands.

After changing anything server-side: clear localStorage + IndexedDB `firebaseLocalStorageDb`, then re-login.

## Navigation gotchas

- **Sidebar nav:** `browser_click` by role on sidebar `<Link>` items often does NOT trigger Next.js client-side navigation. Fire the native DOM click instead: `browser_evaluate` → `document.querySelector('a[href="<path>"]').click()`. This preserves the module-scoped React Query cache.
- **Full reload vs client-side:** `browser_navigate` does a full `page.goto` → wipes the React Query cache. Use the DOM-click navigation above to test cache reuse across pages.
- **Direct URLs:** the owner belongs to more than one firm, so login may land on either. See the firm ID under Test accounts above.

## Healthy-baseline console noise
On a clean load these always appear — ignore them: the React DevTools download tip,
`[HMR] connected`, and a Next.js LCP `loading="eager"` warning for the Paralegix logo. Real
problems show up as `error`-level console entries or `failed` network requests.

## When done
1. Stop any frontend/backend servers you started (`preview_list` → `preview_stop`).
2. Confirm no orphaned background processes remain.
