---
name: run-local
description: Run, start, or launch the whole Paralegix app locally (frontend, backend, docs).
disable-model-invocation: true
---

# Run Paralegix Locally

Stops anything on the dev ports, then starts all three servers: backend (5001),
frontend (3000), and docs (3005).

## When to use

- The user says something like "run Paralegix", "start the app locally", "spin up all the servers", "launch everything".

**Do NOT use this skill to:**
- Verify a code change, reproduce a bug, or preview a page → use the built-in Browser-pane tools
  (`preview_start` + `read_page` / `computer`). Note that this repo's default is NOT to open a
  browser at all: ship the change, confirm it lints/builds/typechecks, and stop. Reach for
  `playwright-mcp-testing` only when the user asks for it by name, since that skill does not
  auto-invoke.
- Run just one server, or run the backend for a test suite.

This is an explicit, user-driven action only. Never invoke it on your own initiative.

## Ports

| Server   | Port | Launch config name |
|----------|------|--------------------|
| frontend | 3000 | `frontend`         |
| backend  | 5001 | `backend`          |
| docs     | 3005 | `docs`             |

(Frontend may spill to 3001 if 3000 is occupied — that's why Step 1 clears the ports first.)

## Step 1 — Stop everything on the dev ports

Free the ports so the servers bind to the expected ones (avoids the "Port 3000 is
in use" fallback):

First stop anything this session started — that is the clean path and needs no shell at
all: call `preview_list`, then `preview_stop` on each returned `serverId`.

For strays owned by another process (a server started outside the Browser pane), free
the ports directly. On macOS and Linux:

```bash
PIDS=$(lsof -tiTCP:3000,3001,5001,3005 -sTCP:LISTEN); [ -n "$PIDS" ] && kill -9 $PIDS || echo "dev ports already free"
```

**`-sTCP:LISTEN` is mandatory, not tidiness.** Without it, `lsof -ti:<port>` also matches
*outbound* connections to those ports — which on a normal dev machine includes the editor or
agent talking to localhost:3000 and every browser tab with the app open. Dropping the filter
turns this line into `kill -9` on the user's browser and tooling. Only ever kill listeners.

The `[ -n ... ]` guard keeps `kill` from running with no arguments when the ports are free. If
`lsof` is unavailable (Windows), find the *listening* PID with `netstat -ano | findstr LISTENING
| findstr :3000` and stop it with `taskkill /PID <pid> /F`.

## Step 2 — Start the three servers

Start each via `preview_start` using its launch-config `name` (never `npm run dev`
in Bash — dev servers go through the Browser pane). They read `backend/.env` and
`frontend/.env.local` as configured (including whatever `DB_TARGET` points at — see
the `local-database` skill if the user wants to switch databases).

1. `preview_start` with `{ name: "backend" }` → http://localhost:5001
2. `preview_start` with `{ name: "frontend" }` → http://localhost:3000
3. `preview_start` with `{ name: "docs" }` → http://localhost:3005

## Step 3 (optional) — Stripe webhook forwarding

**Only if the user explicitly asks to run Stripe too** (e.g. "run Paralegix with
Stripe", "and start the Stripe listeners"). Do NOT start Stripe by default — the
plain "run the app" request does not include it.

When asked, read `.claude/skills/stripe-dev/SKILL.md` and follow it to start the two
webhook listeners (it carries `disable-model-invocation`, so the Skill tool cannot load
it). Do not duplicate its steps here.

## Step 4 — Confirm and report

For each server, check `preview_logs` for a ready line (backend: "Server running on
port 5001"; frontend: "Ready in …"; docs: VitePress local URL) and confirm no
startup errors. Then tell the user all three are up with their URLs:

- App: http://localhost:3000
- API: http://localhost:5001
- Docs: http://localhost:3005
- Stripe listeners: only if Step 3 ran (both webhook listeners active)

If a server fails to start, surface the relevant `preview_logs` output and stop —
don't silently continue with a partial stack.

Do NOT open or drive the app in the browser to verify it works — no navigating
pages, taking screenshots, or hitting endpoints. Starting the servers and seeing
their ready lines in the logs is the whole job.
