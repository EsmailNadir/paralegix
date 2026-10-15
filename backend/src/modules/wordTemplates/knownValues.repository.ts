/**
 * The firm's own records, read for template scanning (detection) and for the
 * leftover-client-text guard. Every read is scoped to the caller's firm through
 * an audited tenant context and nothing is cached: one firm's client names are
 * never loaded while another firm's template is scanned.
 */
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import {
  clients,
  contacts,
  courts,
  lawFirms,
  matterContacts,
  matters,
} from '../../shared/database/drizzle/schema';
import { firmQuery, tenantQuery } from '../../shared/database/queryContext';
import type { FirmKnownValueRows } from './lib/firm-known-values';

// Enough to cover a single firm's book of business without turning an upload
// into an unbounded read. A value past the cap is simply not recognised:
// detection degrades, it does not break.
const DETECTION_MAX_ROWS = 2000;
// Only a runaway guard for the strict read; far past any one firm's records.
const STRICT_MAX_ROWS = 100_000;

export class TooManyRecordsError extends Error {}

/**
 * `strict` is for the leftover guard. Detection can shrug off a capped read
 * and recognise less; a guard that did the same would report a template clean
 * because it never saw the client, so a strict read takes every client and
 * matter and throws rather than truncate.
 */
export async function loadFirmKnownValueRows(
  lawFirmId: string,
  { strict = false }: { strict?: boolean } = {},
): Promise<FirmKnownValueRows> {
  const cap = strict ? STRICT_MAX_ROWS + 1 : DETECTION_MAX_ROWS;
  const capped = <T>(rows: T[]): T[] => {
    if (strict && rows.length > STRICT_MAX_ROWS) {
      throw new TooManyRecordsError('Too many records to check the template.');
    }
    return rows;
  };

  const [firmRows, clientRows, matterRows, courtRows, partyRows] = await Promise.all([
    firmQuery(lawFirms, lawFirmId, ({ executor, scope }) => executor
      .select({
        name: lawFirms.name,
        address: lawFirms.address,
        phone: lawFirms.phone,
        email: lawFirms.email,
        zip: lawFirms.zip,
      })
      .from(lawFirms).where(scope).limit(1)),
    tenantQuery(clients, lawFirmId, ({ executor, scope }) => executor
      .select({
        name: clients.name,
        email: clients.email,
        phone: clients.phone,
        organization: clients.organization,
      })
      .from(clients).where(scope).orderBy(asc(clients.id)).limit(cap)),
    tenantQuery(matters, lawFirmId, ({ executor, scope }) => executor
      .select({ matterNumber: matters.matterNumber })
      .from(matters).where(and(scope, isNotNull(matters.matterNumber)))
      .orderBy(asc(matters.id)).limit(cap)),
    tenantQuery(courts, lawFirmId, ({ executor, scope }) => executor
      .select({ name: courts.name })
      .from(courts).where(scope).orderBy(asc(courts.id)).limit(DETECTION_MAX_ROWS)),
    tenantQuery(matterContacts, lawFirmId, ({ executor, scope }) => executor
      .select({ role: matterContacts.role, name: contacts.name })
      .from(matterContacts)
      .innerJoin(contacts, and(
        eq(contacts.lawFirmId, matterContacts.lawFirmId),
        eq(contacts.id, matterContacts.contactId),
      ))
      .where(and(scope, inArray(matterContacts.role, ['judge', 'opposing_counsel'])))
      .orderBy(asc(matterContacts.id))
      .limit(DETECTION_MAX_ROWS)),
  ]);

  const firm = firmRows[0] ?? null;
  return {
    firm: firm ? { ...firm, fax: null } : null,
    caseNumbers: capped(matterRows).map((r) => r.matterNumber),
    courtNames: courtRows.map((r) => r.name),
    judgeNames: partyRows.filter((r) => r.role === 'judge').map((r) => r.name),
    serviceRecipients: partyRows.filter((r) => r.role === 'opposing_counsel').map((r) => r.name),
    clients: capped(clientRows).map((r) => ({ ...r, email: r.email == null ? null : String(r.email) })),
  };
}
