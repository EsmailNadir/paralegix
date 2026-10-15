/**
 * Matter event types that happen at, or are filed with, the matter's court:
 * proceedings and court filings. A deposition or a mediation on the same
 * matter is held elsewhere, so the matter's court says nothing about it.
 */
const COURT_FACING_MATTER_TYPES: ReadonlySet<string> = new Set([
  'court_date',
  'hearing',
  'trial',
  'filing_deadline',
  'appeal_deadline',
]);

interface EventCourtFields {
  type?: string | null;
  courtName?: string | null;
  locationName?: string | null;
}

/**
 * The court to show beside an event's location, or null.
 *
 * A client event carries a court only when one was picked for it, so it shows
 * whenever set. A matter event carries its matter's court, which is only
 * relevant to a court-facing type. Either way the court is dropped when the
 * location name already names it (the matter form prefills the location name
 * with the matter's court), and it never stands in for the location.
 */
export function eventCourtName(source: 'matter' | 'client', event: EventCourtFields): string | null {
  const court = event.courtName?.trim();
  if (!court) return null;
  if (source === 'matter' && !COURT_FACING_MATTER_TYPES.has(event.type ?? '')) return null;
  return court.toLowerCase() === (event.locationName ?? '').trim().toLowerCase() ? null : court;
}
