/**
 * B11.1 row 4 extension: `purgeEligibleFirms()` (lawFirmRetentionPurge.test.ts)
 * proves the retention window and the trust-ledger block using an EMPTY firm.
 * This spec targets a POPULATED firm whose graph includes a table the schema
 * itself flags as a special case: `conversations.client_record_id` carries a
 * deliberate `on delete restrict` (schema.sql, next to the `conversations`
 * table) instead of cascade, because "a client delete must not silently
 * destroy message history" at the ROUTE level (deleting one client while its
 * canonical company thread survives).
 *
 * A firm-level purge is a different operation: the ENTIRE firm, including
 * every conversation under it, is meant to disappear in the same statement.
 * `conversations.law_firm_id` and `clients.law_firm_id` both cascade from
 * `law_firms`, so nothing here is theoretically un-deletable - but Postgres
 * fires each table's own `on delete cascade`/`on delete restrict` triggers as
 * it walks the dependency graph, and the order between two SIBLING cascades
 * (clients and conversations, both hanging directly off law_firms) is not
 * guaranteed to match the order a human would pick. If the engine reaches the
 * client row before the conversation row that restricts it, the RESTRICT
 * fires against a conversation that was always going to be deleted anyway,
 * and the whole purge throws - converting a routine retention sweep into a
 * silent, permanent `failed` count with the firm (and every real client and
 * matter inside it) never actually deleted.
 */
import {
  createFirm,
  createOrgClient,
  drainEvents,
  ownerOf,
  setRetentionWindow,
  testPool,
} from '../support/setupInProcess';

const { admin } = require('../../src/shared/database/firebase');
const lawfirmsService = require('../../src/modules/lawfirms/lawfirms.service');

let originalStorage: any;

beforeEach(() => {
  // Same rationale as lawFirmRetentionPurge.test.ts: let the hard-purge path
  // reach its storage cleanup without the harness's inert bucket throwing on
  // every call, which would only prove the best-effort catch works.
  originalStorage = admin.storage;
  admin.storage = () => ({
    bucket: () => ({
      deleteFiles: jest.fn().mockResolvedValue(undefined),
      getFiles: jest.fn().mockResolvedValue([[], null]),
    }),
  });
});

afterEach(() => {
  admin.storage = originalStorage;
});

async function firmExists(lawFirmId: string): Promise<boolean> {
  const { rowCount } = await testPool.query(`select 1 from law_firms where id = $1`, [lawFirmId]);
  return (rowCount ?? 0) > 0;
}

async function clientExists(clientId: string): Promise<boolean> {
  const { rowCount } = await testPool.query(`select 1 from clients where id = $1`, [clientId]);
  return (rowCount ?? 0) > 0;
}

async function conversationExists(lawFirmId: string, clientRecordId: string): Promise<boolean> {
  const { rowCount } = await testPool.query(
    `select 1 from conversations where law_firm_id = $1 and client_record_id = $2`,
    [lawFirmId, clientRecordId],
  );
  return (rowCount ?? 0) > 0;
}

describe('B11.1: firm purge against a canonical company conversation (conversations.client_record_id RESTRICT)', () => {
  it('purges a firm whose organization client has a canonical company conversation, leaving an untouched sibling firm alone', async () => {
    const doomed = await createFirm({ name: 'Purge candidate with a company thread' });
    const doomedOwner = await ownerOf(doomed.id);
    const doomedOrg = await createOrgClient(doomed.id, { name: 'Doomed Org Client' });

    // Creates the canonical `conversations` row with client_record_id set -
    // the RESTRICT FK's actual target - exactly the way the company Messages
    // tab does in production.
    const convRes = await doomedOwner.api.get(
      `/api/lawfirms/${doomed.id}/messaging/company-conversation/${doomedOrg.id}`,
    );
    expect(convRes.status).toBe(200);
    await drainEvents();
    expect(await conversationExists(doomed.id, doomedOrg.id)).toBe(true);

    // A sibling firm, past nothing, with the identical shape: its own
    // organization client and canonical conversation. This is the control
    // that proves a purge elsewhere never reaches firms outside its own row.
    const rival = await createFirm({ name: 'Untouched sibling firm' });
    const rivalOwner = await ownerOf(rival.id);
    const rivalOrg = await createOrgClient(rival.id, { name: 'Rival Org Client' });
    const rivalConvRes = await rivalOwner.api.get(
      `/api/lawfirms/${rival.id}/messaging/company-conversation/${rivalOrg.id}`,
    );
    expect(rivalConvRes.status).toBe(200);
    await drainEvents();

    await setRetentionWindow(doomed.id, '-1 minute');

    const result = await lawfirmsService.purgeEligibleFirms();

    // If this comes back with `failed: 1` instead, the RESTRICT constraint on
    // conversations.client_record_id fired before Postgres's own cascade
    // reached the conversation row, and the firm (with all its real client
    // and matter data) was never actually deleted.
    expect(result).toEqual({ purged: 1, blockedByLegalHold: 0, blockedByTrustLedger: 0, failed: 0 });

    expect(await firmExists(doomed.id)).toBe(false);
    expect(await clientExists(doomedOrg.id)).toBe(false);
    expect(await conversationExists(doomed.id, doomedOrg.id)).toBe(false);

    // The sibling firm and its own canonical conversation are completely
    // unaffected by purging the other firm.
    expect(await firmExists(rival.id)).toBe(true);
    expect(await clientExists(rivalOrg.id)).toBe(true);
    expect(await conversationExists(rival.id, rivalOrg.id)).toBe(true);
  });
});
