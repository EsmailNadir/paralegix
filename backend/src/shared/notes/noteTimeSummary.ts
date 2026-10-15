/**
 * The billing picture for one note, assembled from its time entries and where
 * those entries sit on invoices.
 *
 * A note holds no time of its own. Every number here is derived, which is what
 * lets one note carry many entries without the note row and the billing tables
 * ever disagreeing. Shared by matter, task, and client notes: the shape of a
 * note's time is identical regardless of what it's attached to.
 */

/**
 * Invoice states that mean "queued but not yet billed to the client". An entry
 * on one of these is already locked against edits, so it reads as its own state
 * rather than as either end of billed/unbilled.
 */
const PENDING_INVOICE_STATUSES = new Set(['draft', 'pending_approval']);

export type NoteTimeStatus = 'none' | 'unbilled' | 'pending' | 'billed';

export interface NoteTimeEntrySummary {
  id: string;
  entryDate: string | null;
  /** Hours as recorded on the entry, after the firm's rounding increment. */
  hours: number;
  name: string | null;
  description: string | null;
  billable: boolean;
  userId: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  invoiceStatus: string | null;
  /** False once the entry is on any invoice, matching the service's edit guard. */
  editable: boolean;
}

export interface NoteTimeSummary {
  entries: NoteTimeEntrySummary[];
  entryCount: number;
  totalHours: number;
  billableHours: number;
  nonBillableHours: number;
  billedHours: number;
  pendingHours: number;
  unbilledHours: number;
  status: NoteTimeStatus;
  /** True when any entry is on an invoice, so the note's time cannot be removed. */
  locked: boolean;
}

export const EMPTY_NOTE_TIME: NoteTimeSummary = {
  entries: [],
  entryCount: 0,
  totalHours: 0,
  billableHours: 0,
  nonBillableHours: 0,
  billedHours: 0,
  pendingHours: 0,
  unbilledHours: 0,
  status: 'none',
  locked: false,
};

/** `numeric` columns arrive as strings from the driver, so never trust the type. */
function hoursOf(value: any) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/** Guards against float drift accumulating across many small entries. */
function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/**
 * Shape one raw time-entry row of `activities` plus its invoice placement into the summary
 * entry the note panel renders.
 */
export function toEntrySummary(row: any, placement: any): NoteTimeEntrySummary {
  return {
    id: row.id,
    entryDate: typeof row.activityDate === 'string' ? row.activityDate.slice(0, 10) : null,
    hours: hoursOf(row.hours),
    name: row.name || null,
    description: row.description || null,
    billable: row.billable !== false,
    userId: row.userId || null,
    invoiceId: placement?.invoiceId || null,
    invoiceNumber: placement?.invoiceNumber || null,
    invoiceStatus: placement?.status || null,
    editable: !placement,
  };
}

/**
 * Roll a note's entries up into the totals and the single status the list row
 * shows.
 *
 * Status is the worst-case of the entries, in the sense of what a reader most
 * needs to know: any billed entry makes the note billed, otherwise any pending
 * entry makes it pending. A note whose entries are split across states still
 * shows every entry individually in the panel.
 */
export function summarizeNoteTime(entries: NoteTimeEntrySummary[]): NoteTimeSummary {
  if (!entries.length) return EMPTY_NOTE_TIME;

  let totalHours = 0;
  let billableHours = 0;
  let billedHours = 0;
  let pendingHours = 0;
  let anyBilled = false;
  let anyPending = false;
  let locked = false;

  for (const e of entries) {
    totalHours += e.hours;
    if (e.billable) billableHours += e.hours;
    if (e.invoiceId) {
      locked = true;
      if (PENDING_INVOICE_STATUSES.has(e.invoiceStatus || '')) {
        pendingHours += e.hours;
        anyPending = true;
      } else {
        billedHours += e.hours;
        anyBilled = true;
      }
    }
  }

  const status: NoteTimeStatus = anyBilled ? 'billed' : anyPending ? 'pending' : 'unbilled';

  return {
    entries,
    entryCount: entries.length,
    totalHours: round2(totalHours),
    billableHours: round2(billableHours),
    nonBillableHours: round2(totalHours - billableHours),
    billedHours: round2(billedHours),
    pendingHours: round2(pendingHours),
    unbilledHours: round2(totalHours - billedHours - pendingHours),
    status,
    locked,
  };
}
