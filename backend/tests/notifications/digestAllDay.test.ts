/**
 * The day an all-day event falls on in a recipient's daily digest.
 */
import { randomUUID } from 'crypto';
import { testPool, createFirm, ownerOf } from '../support/setupInProcess';

const digestRepo = require('../../src/modules/notifications/digest/digest.repository');

/**
 * An all-day event is stored at its day's noon-UTC anchor, which is already the
 * next day at UTC+12 and beyond. Goes red if its day is read in the recipient's
 * zone: in Auckland it moved to the 16th and fell out of the 15th's digest.
 */
test('an all-day event is on its own day for a recipient in Auckland', async () => {
  const firm = await createFirm();
  const owner = await ownerOf(firm.id);
  const matterId = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id) values ($1, $2, 'Kea v. Tui', $3)`,
    [matterId, firm.id, `M-${matterId.slice(0, 8)}`],
  );
  await testPool.query(
    `insert into matter_members (law_firm_id, matter_id, user_id, role, joined_at) values ($1, $2, $3, 'lead', now())`,
    [firm.id, matterId, owner.uid],
  );
  await testPool.query(
    `insert into events (law_firm_id, matter_id, title, date, type, all_day)
     values ($1, $2, 'Filing deadline', '2026-12-15T12:00:00Z', 'filing_deadline', true)`,
    [firm.id, matterId],
  );

  const rows = await digestRepo.findDigestEvents(firm.id, owner.uid, '2026-12-15', '2026-12-15', 'Pacific/Auckland');

  expect(rows.map((r: any) => [r.title, r.day])).toEqual([['Filing deadline', '2026-12-15']]);
});
