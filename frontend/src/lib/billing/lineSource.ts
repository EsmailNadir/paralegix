/**
 * Ids the invoice composers give a row that exists only in the browser: a time
 * entry typed in with "Add entry" or a flat fee not yet saved. They key the row
 * locally and name no activity on the server.
 */
const DRAFT_LINE_ID_PREFIXES = ["manual-te-", "flat-fee-"];

/** True for a composer-local row id that no saved activity carries. */
export function isDraftLineId(id: string | null | undefined): boolean {
  return Boolean(id) && DRAFT_LINE_ID_PREFIXES.some((prefix) => String(id).startsWith(prefix));
}

/**
 * The `id` field for an invoice line payload. A line sourced from a saved
 * activity carries that activity's id, which the server checks against a real
 * row and uses to freeze the activity. A hand-typed line carries no id, so the
 * server stores it as a manual line billed as typed.
 */
export function lineSourceId(id: string | null | undefined): { id?: string } {
  return id && !isDraftLineId(id) ? { id } : {};
}
