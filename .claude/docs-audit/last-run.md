# Last docs audit

Date: 2026-10-08
Findings: 22 (20 fixed automatically, 2 left as "Worth a look")

Scope: 63 agent-facing doc files discovered fresh. History window: since 2026-10-05.
Five read-only agents ran the judgment pass; every fix was verified against the source first.
Left for a human: whether `rbac-permissions` should carry `user-invocable: false`, and the
fourth hand-rolled header button in `app/client/lawfirm/[lawFirmId]/settings/page.tsx`
(code drift against `known-drift.md`, not a doc error).
