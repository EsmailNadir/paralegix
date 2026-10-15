/**
 * Canonical matter-status vocabulary (backend source of truth).
 *
 * `matters.status` is constrained both by a DB CHECK (`schema.sql`) and by the Zod
 * enum `VALID_MATTER_STATUSES` (`matters.validation.js`). These literal lists are
 * the app-managed *classification* of that vocabulary: which statuses count as
 * closed vs terminal. Centralizing them here means a future terminal status is
 * classified in ONE place instead of being silently included or dropped by
 * hand-maintained `in (...)` / `not in (...)` predicates scattered across callers.
 *
 * Two related-but-distinct sets:
 *
 *   CLOSED_MATTER_STATUSES: counts as a "closed" matter for the dashboard's
 *                            closed-matter stat card (`status in ('completed','closed')`).
 *   TERMINAL_MATTER_STATUSES: a superset of closed statuses PLUS `archived`. A matter
 *                            in any of these is considered done/inactive. The matters
 *                            repository uses it to gate the derived "payment ongoing"
 *                            flag (only surfaced on functionally-done matters).
 *
 * Keep these in sync with the frontend `matterStatusConfig`
 * (`frontend/src/app/lawfirm/[lawFirmId]/page.tsx`).
 */

// Statuses that count as a "closed" matter (closed-matter stat card).
export const CLOSED_MATTER_STATUSES = Object.freeze(['completed', 'closed']);

// Statuses considered terminal/inactive (closed + archived). A matter in any of
// these is excluded from active-only views such as "My Assignments".
export const TERMINAL_MATTER_STATUSES = Object.freeze([...CLOSED_MATTER_STATUSES, 'archived']);
