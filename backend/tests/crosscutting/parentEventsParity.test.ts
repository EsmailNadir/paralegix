/**
 * Matter events and client events are the same capability built twice. This file
 * runs one set of scenarios against both, so a rule added to one side and not
 * the other fails here instead of drifting unnoticed.
 *
 * What has to break for each scenario to go red:
 *   - caps: loosen the `.max(...)` on linkedFiles, assignedTo or contactIds in
 *     either validation file (matterEvents.validation.ts, clientEvents.validation.ts).
 *   - body ids: let a `lawFirmId`, `matterId`, `clientId` or `eventId` in the
 *     request body win over the URL in either route handler.
 *   - all-day: stop anchoring an all-day event at noon UTC on either side, so
 *     the day a caller ahead of UTC picked comes back as the day before.
 *   - cross-firm assignee: stop checking assignees against the firm (client
 *     side) or the matter (matter side) before writing.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  createFirmMember,
  createPersonClient,
  ownerOf,
  memberWith,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

interface Side {
  label: string;
  /** The owner's own parent plus the plumbing a write to it needs. */
  seed(firmId: string, owner: Actor): Promise<{ eventsUrl: string; parentColumn: 'matter_id' | 'client_id'; parentId: string }>;
  /** Extra fields an update body needs on this side. */
  updateExtras: Record<string, unknown>;
  /** Server-owned keys a caller might try to smuggle in, aimed at another firm. */
  smuggled(other: { firmId: string; parentId: string; eventId: string }): Record<string, unknown>;
  type: string;
}

const matterSide: Side = {
  label: 'matter events',
  type: 'hearing',
  updateExtras: {},
  async seed(firmId, owner) {
    const matterId = randomUUID();
    await testPool.query(
      'insert into matters (id, law_firm_id, name, matter_reference_id) values ($1, $2, $3, $4)',
      [matterId, firmId, 'Parity matter', `REF-${matterId.slice(0, 8)}`],
    );
    await testPool.query(
      'insert into matter_members (law_firm_id, matter_id, user_id) values ($1, $2, $3)',
      [firmId, matterId, owner.uid],
    );
    return { eventsUrl: `/api/lawfirms/${firmId}/matters/${matterId}/events`, parentColumn: 'matter_id', parentId: matterId };
  },
  smuggled: ({ firmId, parentId, eventId }) => ({ lawFirmId: firmId, matterId: parentId, eventId }),
};

const clientSide: Side = {
  label: 'client events',
  type: 'meeting',
  updateExtras: { source: 'client' },
  async seed(firmId) {
    const client = await createPersonClient(firmId, { name: 'Parity client' });
    return { eventsUrl: `/api/lawfirms/${firmId}/clients/${client.id}/events`, parentColumn: 'client_id', parentId: client.id };
  },
  smuggled: ({ firmId, parentId, eventId }) => ({ lawFirmId: firmId, clientId: parentId, eventId }),
};

describe.each([matterSide, clientSide])('$label', (side) => {
  let firm: Firm;
  let owner: Actor;
  let eventsUrl: string;
  let parentColumn: 'matter_id' | 'client_id';
  let parentId: string;

  const create = (body: Record<string, unknown> = {}, actor: Actor = owner) =>
    actor.api.post(eventsUrl).send({ type: side.type, title: 'Parity Event', date: '2026-05-10', allDay: true, ...body });
  const update = (eventId: string, body: Record<string, unknown>, actor: Actor = owner) =>
    actor.api.put(`${eventsUrl}/${eventId}`).send({ ...side.updateExtras, ...body });

  const eventCount = async (lawFirmId = firm.id) =>
    (await testPool.query('select count(*)::int n from events where law_firm_id = $1', [lawFirmId])).rows[0].n as number;
  const row = async (eventId: string) =>
    (await testPool.query(
      'select law_firm_id, matter_id, client_id, title, date, all_day from events where id = $1', [eventId],
    )).rows[0];
  const assigneeRows = async (eventId: string) =>
    (await testPool.query('select user_id from event_assignees where event_id = $1', [eventId])).rows;

  beforeEach(async () => {
    firm = await createFirm();
    owner = await ownerOf(firm.id);
    ({ eventsUrl, parentColumn, parentId } = await side.seed(firm.id, owner));
  });

  describe('caps on the replace-set fields', () => {
    const linkedFile = () => ({
      fileId: randomUUID(), name: 'doc.pdf', size: 10, contentType: 'application/pdf', scope: 'general',
    });
    const overCap: [string, () => Record<string, unknown>, number][] = [
      ['linkedFiles', () => ({ linkedFiles: Array.from({ length: 21 }, linkedFile) }), 20],
      ['assignedTo', () => ({ assignedTo: Array.from({ length: 51 }, () => randomUUID()) }), 50],
      ['contactIds', () => ({ contactIds: Array.from({ length: 51 }, () => randomUUID()) }), 50],
    ];

    it.each(overCap)('refuses a create with too many %s and writes nothing', async (field, build, cap) => {
      const res = await create(build());

      expect(res.status).toBe(400);
      // The cap itself is named: a later check refusing the same ids (an
      // assignee who is not a member) must not be able to stand in for it.
      expect(JSON.stringify(res.body)).toContain(field);
      expect(JSON.stringify(res.body)).toMatch(new RegExp(`\\b${cap}\\b`));
      expect(await eventCount()).toBe(0);
    });

    it.each(overCap)('refuses an update with too many %s and applies none of it', async (field, build, cap) => {
      const created = await create({ title: 'Original' });
      expect(created.status).toBe(201);

      const res = await update(created.body.eventId, { title: 'Changed', ...build() });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain(field);
      expect(JSON.stringify(res.body)).toMatch(new RegExp(`\\b${cap}\\b`));
      expect((await row(created.body.eventId)).title).toBe('Original');
    });
  });

  describe('body ids cannot widen the write', () => {
    let otherFirm: Firm;
    let otherOwner: Actor;
    let other: Awaited<ReturnType<Side['seed']>>;
    let victimId: string;

    beforeEach(async () => {
      otherFirm = await createFirm();
      otherOwner = await ownerOf(otherFirm.id);
      other = await side.seed(otherFirm.id, otherOwner);
      // The A04 shape: a bare member of the second firm, so a write that did
      // follow the body would pass the membership check there.
      await memberWith(otherFirm.id, [], { uid: owner.uid });
      const victim = await otherOwner.api.post(other.eventsUrl)
        .send({ type: side.type, title: 'Neighbour Original', date: '2026-05-10', allDay: true });
      expect(victim.status).toBe(201);
      victimId = victim.body.eventId;
    });

    it('creates under the URL parent and firm even when the body names another', async () => {
      const before = await eventCount(otherFirm.id);

      const res = await create({ title: 'Smuggled', ...side.smuggled({ firmId: otherFirm.id, parentId: other.parentId, eventId: victimId }) });

      expect(res.status).toBe(201);
      expect(await eventCount(otherFirm.id)).toBe(before);
      const stored = await row(res.body.eventId);
      expect(stored.law_firm_id).toBe(firm.id);
      expect(stored[parentColumn]).toBe(parentId);
    });

    it('updates the URL event and leaves the event the body names untouched', async () => {
      const mine = await create({ title: 'My Original' });
      expect(mine.status).toBe(201);

      const res = await update(mine.body.eventId, {
        title: 'Hijacked',
        ...side.smuggled({ firmId: otherFirm.id, parentId: other.parentId, eventId: victimId }),
      });

      expect(res.status).toBe(200);
      expect((await row(mine.body.eventId)).title).toBe('Hijacked');
      expect((await row(victimId)).title).toBe('Neighbour Original');
    });
  });

  describe('all-day events', () => {
    const parisOwner = () => ({ uid: owner.uid, api: as(tokenFor({ uid: owner.uid }), 'Europe/Paris') });

    it('round-trips the picked day, not the day before, for a caller ahead of UTC', async () => {
      const res = await create({ date: '2026-09-01T00:00', allDay: true }, parisOwner());
      expect(res.status).toBe(201);

      const stored = await row(res.body.eventId);
      expect(stored.all_day).toBe(true);
      expect(stored.date.toISOString()).toBe('2026-09-01T12:00:00.000Z');

      const list = await parisOwner().api.get(eventsUrl);
      expect(list.status).toBe(200);
      const listed = list.body.events.find((event: any) => event.id === res.body.eventId);
      expect(listed.date).toBe('2026-09-01T12:00:00.000Z');
      expect(listed.dateLocalDisplay).toBe('Sep 1, 2026');
    });

    it('keeps the all-day anchor when an update changes only the date', async () => {
      const created = await create({ date: '2026-09-01T00:00', allDay: true }, parisOwner());
      expect(created.status).toBe(201);

      const res = await update(created.body.eventId, { date: '2026-09-15T00:00' }, parisOwner());

      expect(res.status).toBe(200);
      expect((await row(created.body.eventId)).date.toISOString()).toBe('2026-09-15T12:00:00.000Z');
    });
  });

  describe('assignees', () => {
    it('refuses another firm\'s member on create, writing nothing and disclosing nobody', async () => {
      const otherFirm = await createFirm();
      const name = `Other Firm Lawyer ${randomUUID().slice(0, 6)}`;
      const outsider = await createFirmMember(otherFirm.id, { isOwner: false, name });

      const res = await create({ assignedTo: [outsider.uid] });

      expect([400, 403]).toContain(res.status);
      expect(JSON.stringify(res.body)).not.toContain(name);
      expect(await eventCount()).toBe(0);
      const { rows } = await testPool.query('select 1 from event_assignees where user_id = $1', [outsider.uid]);
      expect(rows).toEqual([]);
    });

    it('refuses another firm\'s member on update and keeps the existing assignee', async () => {
      const colleague = await createFirmMember(firm.id, { isOwner: false });
      if (side.label === 'matter events') {
        await testPool.query(
          'insert into matter_members (law_firm_id, matter_id, user_id) values ($1, $2, $3)',
          [firm.id, parentId, colleague.uid],
        );
      }
      const created = await create({ assignedTo: [colleague.uid] });
      expect(created.status).toBe(201);
      const otherFirm = await createFirm();
      const outsider = await createFirmMember(otherFirm.id, { isOwner: false });

      const res = await update(created.body.eventId, { assignedTo: [outsider.uid] });

      expect([400, 403]).toContain(res.status);
      expect((await assigneeRows(created.body.eventId)).map((r) => r.user_id)).toEqual([colleague.uid]);
    });
  });
});
