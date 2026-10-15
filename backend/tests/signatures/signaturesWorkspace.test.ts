/**
 * The signatures workspace read: the four requests the Signatures page made on
 * open (the session history page, the per-status summary, what is waiting for
 * the caller, and the firm's signing templates) answered in one.
 *
 * Each section has to be exactly the body its standalone route answers, because
 * the page renders them unchanged and other screens still call the originals.
 * The parity cases compare against the real routes rather than against expected
 * literals, so a section that drifted from its original (a dropped
 * `isCurrentUser` flag, a summary counted over the filtered page, templates
 * serialized differently) goes red.
 *
 * All four originals share one gate: `signatures.view` behind the
 * `documentSigning` plan feature. There is no section a caller could see while
 * being refused another, so the workspace refuses as a whole, with the same
 * status the originals give.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  ensureUser,
  ownerOf,
  memberWith,
  stranger,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { seedSigningSession } from '../support/signing';
import { DEFAULT_PERMISSIONS } from '../../src/modules/lawfirms/roles/permissions';

let firm: Firm;
let owner: Actor;
let rival: Firm;
let rivalOwner: Actor;

const links = (lawFirmId: string) => `/api/lawfirms/${lawFirmId}/signature-links`;
const workspace = (actor: Actor, lawFirmId: string = firm.id, query = '') =>
  actor.api.get(`${links(lawFirmId)}/workspace${query ? `?${query}` : ''}`);

const originals = {
  sessions: (actor: Actor, lawFirmId: string = firm.id, query = '') =>
    actor.api.get(`${links(lawFirmId)}/sessions${query ? `?${query}` : ''}`),
  summary: (actor: Actor, lawFirmId: string = firm.id) =>
    actor.api.get(`${links(lawFirmId)}/sessions/summary`),
  pendingForUser: (actor: Actor, lawFirmId: string = firm.id) =>
    actor.api.get(`${links(lawFirmId)}/pending-for-user`),
  templates: (actor: Actor, lawFirmId: string = firm.id) =>
    actor.api.get(`/api/lawfirms/${lawFirmId}/signing-templates`),
};

/** A session with one participant, seeded in an exact known state. */
async function seedSession(options: {
  lawFirmId?: string;
  createdBy?: string;
  status?: string;
  participantStatus?: string;
  memberUserId?: string | null;
  email?: string;
  fileName?: string;
  createdAt?: string;
} = {}) {
  const suffix = randomUUID().slice(0, 12);
  const lawFirmId = options.lawFirmId ?? firm.id;
  await ensureUser(options.createdBy ?? owner.uid);
  await ensureUser(options.memberUserId);

  const { sessionToken } = await seedSigningSession({
    lawFirmId,
    createdBy: options.createdBy ?? owner.uid,
    token: `sess-${suffix}`,
    session: {
      status: options.status ?? 'pending',
      file_name: options.fileName ?? `Agreement ${suffix}.pdf`,
      object_path: `lawfirmids/${lawFirmId}/general/${suffix}.pdf`,
      ...(options.createdAt ? { created_at: options.createdAt } : {}),
    },
    participants: [{
      id: `part-${suffix}`,
      publicToken: `pub-${suffix}`,
      roleLabel: 'Signer',
      name: 'Signer One',
      email: options.email ?? 'signer@example.test',
      status: options.participantStatus ?? 'active',
      columns: { member_user_id: options.memberUserId ?? null },
    }],
  });
  return { sessionToken };
}

async function seedTemplate(lawFirmId: string, name: string) {
  const inserted = await testPool.query(
    `insert into signature_templates
       (id, law_firm_id, name, description, fields, signer_roles, source_file_name, routing_mode)
     values ($1, $2, $3, 'Seeded', '[]', '[{"id":"role-1","label":"Client"}]', 'seed.pdf', 'sequential')`,
    [randomUUID(), lawFirmId, name],
  );
  expect(inserted.rowCount).toBe(1);
}

/** A firm with sessions in several states, one waiting on `signer`, and two templates. */
async function seedHistory(signerUid: string) {
  await seedSession({ status: 'pending', fileName: 'Retainer.pdf', createdAt: '2026-04-01T10:00:00Z' });
  await seedSession({ status: 'in_progress', fileName: 'Waiver.pdf', createdAt: '2026-04-02T10:00:00Z', memberUserId: signerUid });
  await seedSession({
    status: 'completed', participantStatus: 'completed', fileName: 'Settlement.pdf',
    email: 'reginald@counterparty.test', createdAt: '2026-04-03T10:00:00Z',
  });
  await seedSession({ status: 'cancelled', participantStatus: 'cancelled', fileName: 'Lease.pdf', createdAt: '2026-04-04T10:00:00Z' });
  await seedTemplate(firm.id, 'Engagement Letter');
  await seedTemplate(firm.id, 'Fee Agreement');
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  rival = await createFirm();
  rivalOwner = await ownerOf(rival.id);
});

describe('another firm', () => {
  it('refuses a caller from another firm with the status the originals give', async () => {
    await seedHistory(owner.uid);

    const res = await workspace(rivalOwner, firm.id);

    expect((await originals.sessions(rivalOwner, firm.id)).status).toBe(403);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('Retainer');
  });

  it('refuses a signed-in caller who belongs to no firm', async () => {
    expect((await workspace(stranger(), firm.id)).status).toBe(403);
  });

  it('never includes another firm\'s sessions, counts or templates', async () => {
    await seedHistory(owner.uid);
    await seedSession({ lawFirmId: rival.id, createdBy: owner.uid, memberUserId: owner.uid, fileName: 'RIVAL Deed.pdf' });
    await seedTemplate(rival.id, 'RIVAL Template');

    const res = await workspace(owner);

    expect(res.status).toBe(200);
    // Three, not four: the history hides a cancelled session nobody signed.
    expect(res.body.sessions.sessions.map((s: any) => s.fileName))
      .toEqual(['Settlement.pdf', 'Waiver.pdf', 'Retainer.pdf']);
    expect(res.body.summary.total).toBe(3);
    expect(res.body.pendingForUser.needsMySignature).toHaveLength(1);
    expect(res.body.templates.templates).toHaveLength(2);
    expect(JSON.stringify(res.body)).not.toContain('RIVAL');
  });
});

describe('parity with the four standalone reads', () => {
  it.each([
    ['no query', ''],
    ['a page window', 'page=2&limit=2'],
    ['a status filter', 'status=not_completed'],
    ['a search', 'search=counterparty'],
  ])('answers each section as its own route does, with %s', async (_label, query) => {
    const signer = await memberWith(firm.id, []);
    await seedHistory(signer.uid);

    for (const actor of [owner, signer]) {
      const res = await workspace(actor, firm.id, query);
      const [sessions, summary, pendingForUser, templates] = await Promise.all([
        originals.sessions(actor, firm.id, query),
        originals.summary(actor),
        originals.pendingForUser(actor),
        originals.templates(actor),
      ]);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['pendingForUser', 'sessions', 'summary', 'templates']);
      expect(res.body.sessions).toEqual(sessions.body);
      expect(res.body.summary).toEqual(summary.body);
      expect(res.body.pendingForUser).toEqual(pendingForUser.body);
      expect(res.body.templates).toEqual(templates.body);
    }
  });

  it('carries the caller-specific fields for the caller, not for someone else', async () => {
    const signer = await memberWith(firm.id, []);
    await seedHistory(signer.uid);

    const asSigner = await workspace(signer);
    const asOwner = await workspace(owner);

    expect(asSigner.body.pendingForUser.needsMySignature.map((s: any) => s.fileName)).toEqual(['Waiver.pdf']);
    expect(asOwner.body.pendingForUser.needsMySignature).toEqual([]);
    const waiver = (body: any) => body.sessions.sessions.find((s: any) => s.fileName === 'Waiver.pdf');
    expect(waiver(asSigner.body).readyForCurrentUser).toBe(true);
    expect(waiver(asOwner.body).readyForCurrentUser).toBe(false);
  });
});

describe('gates', () => {
  it('refuses a member without signatures.view, as the originals do', async () => {
    const member = await memberWith(firm.id, []);
    const index = DEFAULT_PERMISSIONS.indexOf('signatures.view');
    expect(index).toBeGreaterThanOrEqual(0);
    DEFAULT_PERMISSIONS.splice(index, 1);
    try {
      for (const read of Object.values(originals)) {
        expect((await read(member)).status).toBe(403);
      }
      expect((await workspace(member)).status).toBe(403);
    } finally {
      DEFAULT_PERMISSIONS.splice(index, 0, 'signatures.view');
    }
  });

  it('refuses a firm whose plan does not include document signing, as the originals do', async () => {
    const starter = await createFirm({ planId: 'starter' });
    const starterOwner = await ownerOf(starter.id);
    await seedTemplate(starter.id, 'Starter Template');

    for (const read of Object.values(originals)) {
      expect((await read(starterOwner, starter.id)).status).toBe(403);
    }
    const res = await workspace(starterOwner, starter.id);

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('Starter Template');
  });

  it('rejects the query the session list rejects', async () => {
    expect((await originals.sessions(owner, firm.id, 'limit=0')).status).toBe(400);
    expect((await workspace(owner, firm.id, 'limit=0')).status).toBe(400);
    expect((await workspace(owner, firm.id, 'status=bogus')).status).toBe(400);
  });
});
