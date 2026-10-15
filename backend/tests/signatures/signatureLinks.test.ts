/**
 * Issuing and re-sending a signing link.
 *
 * `signatureLinks.routes.ts` is the FIRM side of document signing: it turns a
 * document in the firm's storage into a signing session and hands back a URL.
 * That URL is a bearer credential to an executed legal document, and it is
 * handed to people who have no account here at all, so the questions this file
 * asks are about who may mint one, over which document, and what a re-send does
 * to the one already in the wild.
 *
 * The existing signature specs own the other half. `signingAccess.test.ts`
 * covers who may REACH a session and what state permits what,
 * `signingAccessCode.test.ts` the access-code gate and its brute-force
 * controls, `signingRouting.test.ts` the sequential/parallel state machine and
 * single-use links, and `signatureLayout` / `textFit` /
 * `signingArchive` the placement and sealing. None of them issue a link.
 *
 * TWO PIECES OF ENVIRONMENT ARE DELIBERATELY OVERRIDDEN HERE:
 *
 *   The harness's GCS mock is inert by design: every bucket operation throws
 *   under its own name so a spec that reaches storage fails loudly. Link
 *   issuance genuinely moves bytes (it FREEZES a copy of the source document so
 *   the firm cannot alter what is being signed mid-session), so this spec
 *   installs its own in-memory bucket at MODULE SCOPE. That is load-bearing:
 *   `signatureLinks.routes.ts` resolves `admin.storage().bucket(...)` once, at
 *   module load, and hands that one handle to every route.
 *
 *   `backend/.env` carries `DISABLE_ALL_REMINDER_EMAILS=true`, which the test
 *   harness loads, and the re-send route refuses outright while it is set. It
 *   is cleared here so the route's own rules are what the cases below meet, and
 *   one case sets it back to prove the kill switch still works.
 *
 * Sessions that are only being READ are seeded with SQL, for the reason
 * `signingAccess.test.ts` gives: seeding puts a session in an exact known state.
 * Sessions being CREATED go through the route, because creation is the subject.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  ensureUser,
  createFirmMember,
  createOrgClient,
  createPersonClient,
  createPortalUser,
  linkPersonToOrg,
  ownerOf,
  memberWith,
  as,
  tokenFor,
  sentEmails,
  drainEvents,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { sessionIdSql } from '../support/factories';
import { seedSigningSession } from '../support/signing';
import { gateMethod } from '../support/gate';

// ── the shared in-memory bucket, installed before the app is ever required ──
//
// This file used to carry a bucket double of its own, with no generations and
// no ranged reads. Sending a document now ADMITS it: the boundary pins the
// landed generation and inspects the structure through bounded windows, and
// neither is possible against a double that answers only `download()`. The
// shared one supports both, so there is one double rather than two that drift.
import { installInMemoryBucket, objects as storedObjects, putObject as landObject } from '../support/inMemoryBucket';
import { minimalPdfBytes } from '../support/minimalPdf';

installInMemoryBucket();

// The module object the re-send route calls its claim through, so a gate
// installed on it is the same function the route reaches.
const signaturesRepo = require('../../src/modules/signatures/signatures.repository');

// The re-send route refuses everything while the global kill switch is on, and
// `backend/.env` sets it. Cleared here so the route's OWN rules are what the
// cases below reach; one case turns it back on deliberately.
process.env.DISABLE_ALL_REMINDER_EMAILS = 'false';

/** Put bytes at a path without going through any route. */
function putObject(path: string, custom: Record<string, string> = {}): void {
  // A REAL PDF. This wrote `%PDF-1.4 <path>`, which is a header and nothing
  // else. Sending a document now admits it, and admission resolves the page
  // tree; a string that starts with the right five bytes is refused, which is
  // the correct answer to those bytes and the wrong subject for these cases.
  landObject(path, { body: minimalPdfBytes({ pages: 2 }), contentType: 'application/pdf', custom });
}

// ── fixtures ───────────────────────────────────────────────────────────────

let firm: Firm;
let owner: Actor;
/** A firm with no connection to anything seeded here. */
let rival: Firm;
let rivalOwner: Actor;
/** The firm document every issuing case sends, unless it says otherwise. */
let sourcePath: string;

const links = (lawFirmId: string) => `/api/lawfirms/${lawFirmId}/signature-links`;

const generate = (actor: Actor, body: Record<string, unknown>) =>
  actor.api.post(`${links(firm.id)}/generate`).send({
    objectPath: sourcePath,
    fileName: 'Engagement Agreement.pdf',
    ...body,
  });

/** Every signing session this firm holds, newest first. */
async function sessionRows(lawFirmId: string = firm.id) {
  const { rows } = await testPool.query(
    `select token, object_path, destination_folder_id, status, routing_mode, current_signer_order
       from signature_sessions where law_firm_id = $1 order by created_at desc`,
    [lawFirmId],
  );
  return rows;
}

const sessionCount = async (lawFirmId: string = firm.id) => (await sessionRows(lawFirmId)).length;

async function tokenRow(publicToken: string) {
  const { rows } = await testPool.query(
    `select s.token as session_token, t.participant_id, t.law_firm_id, t.consumed_at
       from signature_participant_tokens t
       join signature_sessions s on s.id = t.session_id
      where t.token = $1`,
    [publicToken],
  );
  return rows[0] || null;
}

async function participantRows(sessionToken: string) {
  const { rows } = await testPool.query(
    `select p.id, p.role_label, p.status, p.signing_order, p.email,
            c.secret_hash as access_code_hash,
            coalesce(rem.sent_count, 0) as reminder_count,
            rem.last_sent_at as last_reminder_sent_at,
            t.token as public_token
       from signature_participants p
       left join signature_participant_tokens t on t.participant_id = p.id
       left join signature_challenges c
              on c.participant_id = p.id and c.kind = 'access_code'
       left join reminders rem on rem.signature_participant_id = p.id
      where p.session_id = ${sessionIdSql('$1')}
      order by p.signing_order asc`,
    [sessionToken],
  );
  return rows;
}

/** A matter, plus one member of it. */
async function seedMatter(lawFirmId: string, memberUid: string): Promise<string> {
  const id = randomUUID();
  const created = await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id) values ($1, $2, $3, $4)`,
    [id, lawFirmId, 'Hollis v. Denton', `REF-${id.slice(0, 8)}`],
  );
  expect(created.rowCount).toBe(1);
  const joined = await testPool.query(
    `insert into matter_members (matter_id, user_id, law_firm_id, role, joined_at)
     values ($1, $2, $3, 'lead', now())`,
    [id, memberUid, lawFirmId],
  );
  expect(joined.rowCount).toBe(1);
  return id;
}

/**
 * A v2 session with one participant and its PUBLIC token, seeded directly.
 *
 * The public token is the participant's, not the session's: it is what a signer
 * holds and what a re-send has to re-deliver. A session without that row cannot
 * be re-sent at all, so seeding it is not incidental setup.
 */
async function seedSession(options: {
  lawFirmId?: string;
  createdBy?: string;
  status?: string;
  participantStatus?: string;
  deliveryMethod?: string;
  memberUserId?: string | null;
  clientUserId?: string | null;
  email?: string;
  fileName?: string;
  objectPath?: string | null;
  lastReminderSentAt?: string | null;
  reminderCount?: number;
  completedAt?: string | null;
} = {}) {
  const suffix = randomUUID().slice(0, 12);
  const lawFirmId = options.lawFirmId ?? firm.id;

  await ensureUser(options.createdBy ?? owner.uid);
  await ensureUser(options.memberUserId);
  await ensureUser(options.clientUserId);
  const { sessionToken, participants: [signer] } = await seedSigningSession({
    lawFirmId,
    createdBy: options.createdBy ?? owner.uid,
    token: `sess-${suffix}`,
    session: {
      status: options.status ?? 'pending',
      file_name: options.fileName ?? 'Engagement Agreement.pdf',
      // Distinct per session by default. The firm history deliberately hides an
      // unsigned session whose source document already has a COMPLETED session
      // against it, so sharing one path between fixtures would silently drop
      // sessions from every list assertion below.
      object_path: options.objectPath === undefined ? `lawfirmids/${lawFirmId}/general/${suffix}.pdf` : options.objectPath,
      completed_at: options.completedAt ?? null,
    },
    participants: [{
      id: `part-${suffix}`,
      publicToken: `pub-${suffix}`,
      roleLabel: 'Signer',
      name: 'Signer One',
      email: options.email ?? 'signer@example.test',
      status: options.participantStatus ?? 'active',
      deliveryMethod: options.deliveryMethod ?? 'email',
      columns: {
        member_user_id: options.memberUserId ?? null,
        client_user_id: options.clientUserId ?? null,
      },
    }],
  });

  // Reminder state is a shared `reminders` row (migration 0245); a participant
  // who has never been reminded has no row.
  if (options.lastReminderSentAt || options.reminderCount) {
    await testPool.query(
      `insert into reminders (law_firm_id, signature_participant_id, last_sent_at, sent_count)
       values ($1, $2, $3, $4)`,
      [lawFirmId, signer.participantId, options.lastReminderSentAt ?? null, options.reminderCount ?? 0],
    );
  }

  return { sessionToken, participantId: signer.participantId, publicToken: signer.publicToken };
}

const resend = (actor: Actor, lawFirmId: string, sessionToken: string, participantId: string) =>
  actor.api.post(`${links(lawFirmId)}/${sessionToken}/resend-participant/${participantId}`).send({});

const reminderState = async (participantId: string) => {
  const { rows } = await testPool.query(
    `select coalesce(sent_count, 0) as reminder_count, last_sent_at as last_reminder_sent_at
       from reminders where signature_participant_id = $1`,
    [participantId],
  );
  // No row means never reminded, which is the zero state the callers assert.
  return rows[0] || { reminder_count: 0, last_reminder_sent_at: null };
};

beforeEach(async () => {
  storedObjects.clear();
  process.env.DISABLE_ALL_REMINDER_EMAILS = 'false';

  firm = await createFirm();
  owner = await ownerOf(firm.id);
  rival = await createFirm();
  rivalOwner = await ownerOf(rival.id);

  sourcePath = `lawfirmids/${firm.id}/general/Engagement Agreement.pdf`;
  putObject(sourcePath);
  await drainEvents();
});

describe('issuing a link', () => {
  it('hands back a token that is a live participant credential', async () => {
    const res = await generate(owner, {});

    expect(res.status).toBe(200);
    // The response `token` is what goes in the URL a signer is emailed. It has
    // to be a real, unconsumed row in the tokens table scoped to this firm, or
    // the link the firm just copied opens nothing.
    const row = await tokenRow(res.body.token);
    expect(row).not.toBeNull();
    expect(row.law_firm_id).toBe(firm.id);
    expect(row.consumed_at).toBeNull();
    expect(row.session_token).toBe(res.body.sessionToken);
  });

  it('does NOT hand back the session token as the signer link', async () => {
    const res = await generate(owner, {});

    // The session token is the firm-side identifier and appears in firm-side
    // URLs; the participant's public token is the bearer credential. Returning
    // one where the other belongs would put the firm's own session id in an
    // email, and the two have different lifetimes: the public token is
    // single-use and gets consumed, the session token never does.
    expect(res.body.token).not.toBe(res.body.sessionToken);
  });

  it('lists an organization member through the real recipient route', async () => {
    const portal = await createPortalUser();
    const person = await createPersonClient(firm.id, {
      name: 'Organization Signer',
      userId: portal.uid,
      email: 'organization-signer@example.test',
    });
    const organization = await createOrgClient(firm.id, { name: 'Northwind Holdings' });
    await linkPersonToOrg(firm.id, person.id, organization.id, { canViewBilling: false });

    const all = await owner.api.get(`${links(firm.id)}/recipients`);
    const narrowed = await owner.api.get(
      `${links(firm.id)}/recipients?clientId=${organization.id}`,
    );

    expect(all.status).toBe(200);
    expect(narrowed.status).toBe(200);
    expect(all.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'Organization Signer',
        userId: portal.uid,
        companyName: 'Northwind Holdings',
        companyLinkId: expect.any(String),
      }),
    ]));
    expect(narrowed.body.items).toEqual([
      expect.objectContaining({
        name: 'Organization Signer',
        userId: portal.uid,
        companyName: 'Northwind Holdings',
      }),
    ]);
    expect(narrowed.body.items.some((item: any) => item.name === 'Northwind Holdings')).toBe(false);
  });

  it('binds a generated portal signing participant to the organization member identity', async () => {
    const portal = await createPortalUser();
    const person = await createPersonClient(firm.id, {
      name: 'Organization Signer',
      userId: portal.uid,
      email: 'organization-signer@example.test',
    });
    const organization = await createOrgClient(firm.id, { name: 'Northwind Holdings' });
    await linkPersonToOrg(firm.id, person.id, organization.id, { canViewBilling: false });

    const res = await generate(owner, {
      signers: [{
        participantId: 'organization-signer',
        roleLabel: 'Organization Representative',
        name: 'Organization Signer',
        email: 'organization-signer@example.test',
        deliveryMethod: 'portal',
        clientUserId: portal.uid,
      }],
      fields: [{
        id: 'organization-signature',
        page: 1,
        xPercent: 10,
        yPercent: 10,
        widthPercent: 20,
        heightPercent: 5,
        fieldType: 'signature',
        signerId: 'organization-signer',
      }],
    });

    expect(res.status).toBe(200);
    const { rows } = await testPool.query(
      `select client_user_id, delivery_method, role_label
         from signature_participants where session_id = ${sessionIdSql('$1')}`,
      [res.body.sessionToken],
    );
    expect(rows).toEqual([{
      client_user_id: portal.uid,
      delivery_method: 'portal',
      role_label: 'Organization Representative',
    }]);
  });

  it('freezes its own copy of the document rather than signing the firm\'s', async () => {
    const res = await generate(owner, {});

    // The session must not depend on a file the firm can rename, move, replace
    // or delete while signing is open. Replacing it would silently change what
    // finalize rebuilds the authoritative signed PDF from, so the executed
    // document could differ from what the signer was shown.
    const [session] = await sessionRows();
    expect(session.token).toBe(res.body.sessionToken);
    expect(session.object_path).not.toBe(sourcePath);
    expect(session.object_path.startsWith(`signing-uploads/${firm.id}/`)).toBe(true);
    // The copy exists, and it is the source's bytes. A path recorded with
    // nothing behind it would fail the same assertion as an unfrozen path.
    expect(storedObjects.get(session.object_path)?.body?.toString())
      .toBe(storedObjects.get(sourcePath)?.body?.toString());
  });

  it('leaves the firm document itself untouched', async () => {
    await generate(owner, {});

    // A freeze that MOVED the document would satisfy the case above and would
    // also make the firm's own copy vanish from the file browser.
    expect(storedObjects.has(sourcePath)).toBe(true);
  });

  it('gives each signer of a multi-signer session its own distinct token', async () => {
    const res = await generate(owner, {
      signers: [
        { roleLabel: 'Client', order: 1, name: 'A', email: 'a@example.test' },
        { roleLabel: 'Counsel', order: 2, name: 'B', email: 'b@example.test' },
      ],
    });

    const rows = await participantRows(res.body.sessionToken);
    expect(rows).toHaveLength(2);
    // Two signers sharing one link would let the second signer sign as the
    // first, which is the whole identity claim a multi-party document rests on.
    expect(new Set(rows.map((r: any) => r.public_token)).size).toBe(2);
  });

  it('returns the FIRST signer\'s token, and only that one is active', async () => {
    const res = await generate(owner, {
      signers: [
        { roleLabel: 'Client', order: 1, name: 'A', email: 'a@example.test' },
        { roleLabel: 'Counsel', order: 2, name: 'B', email: 'b@example.test' },
      ],
    });

    const rows = await participantRows(res.body.sessionToken);
    const returned = rows.find((r: any) => r.public_token === res.body.token);
    // Sequential routing: the link the firm is handed must be the one signer who
    // may act now. Handing out signer two's link would let them sign ahead of a
    // party whose signature the document is ordered to collect first.
    expect(returned.signing_order).toBe(1);
    expect(returned.status).toBe('active');
    expect(rows.find((r: any) => r.signing_order === 2).status).toBe('waiting');
  });

  it('stores a signer access code hashed, never in the clear', async () => {
    const res = await generate(owner, {
      signers: [{ roleLabel: 'Client', order: 1, name: 'A', email: 'a@example.test', accessCode: '482913' }],
    });

    const [row] = await participantRows(res.body.sessionToken);
    // The access code is the second factor on a forwarded link. A row holding it
    // in the clear turns a database read into a signing credential.
    expect(row.access_code_hash).not.toBe('482913');
    expect(row.access_code_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('who may issue a link', () => {
  it('refuses a member without signatures.send, and creates nothing', async () => {
    const viewer = await memberWith(firm.id, ['signatures.view']);

    const res = await generate(viewer, {});

    expect(res.status).toBe(403);
    // The status alone does not prove the refusal came BEFORE the write. A route
    // that created the session and then failed the gate would still answer 403
    // while a live signing link existed for a document nobody was allowed to
    // send.
    expect(await sessionCount()).toBe(0);
  });

  it('refuses another firm\'s owner', async () => {
    const res = await rivalOwner.api.post(`${links(firm.id)}/generate`).send({
      objectPath: sourcePath,
      fileName: 'Engagement Agreement.pdf',
    });

    expect(res.status).toBe(403);
    expect(await sessionCount()).toBe(0);
  });
});

describe('which document may be sent', () => {
  it('refuses a document that belongs to another firm', async () => {
    const foreign = `lawfirmids/${rival.id}/general/Their Contract.pdf`;
    putObject(foreign);

    const res = await generate(owner, { objectPath: foreign });

    // The object EXISTS, so this is a refusal on ownership rather than a
    // not-found that would pass whether or not the check were there.
    expect(res.status).toBe(403);
    expect(await sessionCount()).toBe(0);
  });

  it('answers not-found for a document that is not in storage', async () => {
    const res = await generate(owner, { objectPath: `lawfirmids/${firm.id}/general/ghost.pdf` });

    expect(res.status).toBe(404);
  });

  it('hides the preserved-record archive behind a not-found', async () => {
    const archived = `lawfirmids/${firm.id}/signatures/${randomUUID()}/executed.pdf`;
    putObject(archived);

    const res = await generate(owner, { objectPath: archived });

    // Sending an archived executed document for signature copies it out of the
    // archive into an upload prefix and shows it to whoever is named: a route
    // around the wall the archive exists to be. Answered 404 rather than 403 so
    // the archive does not confirm what it holds.
    expect(res.status).toBe(404);
    expect(await sessionCount()).toBe(0);
  });

  /** A real document in a matter's tree: a row, and the bytes behind it. */
  async function matterDocument(matterId: string, name = 'Pleading.pdf') {
    // Required lazily: this spec installs its own bucket at module scope, and
    // the files module resolves its bucket handle when it is first loaded.
    const filesRepo = require('../../src/modules/files/files.repository');
    const root = await filesRepo.ensureScopeRoot(firm.id, { scope: 'matter', matterId });
    const row = await filesRepo.createFile(firm.id, {
      parentId: root, name, mimeType: 'application/pdf',
    });
    await filesRepo.finalize(firm.id, row.id, { sizeBytes: 1024, mimeType: 'application/pdf' });
    putObject(row.objectPath);
    return row.objectPath;
  }

  it('refuses a matter document to a sender who is not on the matter', async () => {
    // The matter has a member, and it is somebody else. The sender below holds
    // `signatures.send` for the firm but has no standing on this matter.
    const onTheMatter = await createFirmMember(firm.id, { isOwner: false, permissions: [] });
    const matterId = await seedMatter(firm.id, onTheMatter.uid);
    const matterDoc = await matterDocument(matterId);

    const sender = await memberWith(firm.id, ['signatures.send']);
    const refused = await sender.api.post(`${links(firm.id)}/generate`)
      .send({ objectPath: matterDoc, fileName: 'Pleading.pdf' });

    // Matter membership is the ACL on matter documents everywhere else. Without
    // it here, any `signatures.send` holder could send-for-signature, and
    // thereby exfiltrate, any matter document in the firm.
    //
    // The document is a real ROW, because that is where the matter now lives.
    // This gate used to read the matter out of the object path, and an object
    // path says nothing about the tree any more: the parse returned null for
    // every document and this wall silently stopped applying to anything.
    expect(refused.status).toBe(403);
    expect(await sessionCount()).toBe(0);
  });

  it('allows a matter document to a sender who IS on the matter', async () => {
    const member = await createFirmMember(firm.id, { isOwner: false, permissions: ['signatures.send'] });
    const matterId = await seedMatter(firm.id, member.uid);
    const matterDoc = await matterDocument(matterId);

    const res = await as(tokenFor({ uid: member.uid })).post(`${links(firm.id)}/generate`)
      .send({ objectPath: matterDoc, fileName: 'Pleading.pdf' });

    // The boundary from below. A check that refused every matter document would
    // satisfy the case above while making matter documents unsignable.
    expect(res.status).toBe(200);
  });

  it('refuses an upload another user made', async () => {
    const upload = `signing-uploads/${firm.id}/${randomUUID().slice(0, 12)}/theirs.pdf`;
    putObject(upload, { uploadedBy: 'somebody-else', lawFirmId: firm.id });

    const res = await generate(owner, { objectPath: upload });

    // Uploads sit outside the firm prefix and are authorized by `uploadedBy` on
    // the object rather than by firm membership. Reading that wrong would let
    // one member send another member's in-flight upload.
    expect(res.status).toBe(403);
    expect(await sessionCount()).toBe(0);
  });

  it('accepts the sender\'s own upload without re-copying it', async () => {
    const upload = `signing-uploads/${firm.id}/${randomUUID().slice(0, 12)}/mine.pdf`;
    putObject(upload, { uploadedBy: owner.uid, lawFirmId: firm.id });

    const res = await generate(owner, { objectPath: upload, fileName: 'mine.pdf' });

    expect(res.status).toBe(200);
    // An upload is already the session's own transient copy that nobody can
    // reach through the file browser, so freezing it again would buy nothing and
    // double the storage every send costs.
    const [session] = await sessionRows();
    expect(session.object_path).toBe(upload);
  });
});

describe('where the signed copy may be filed', () => {
  // Required lazily, for the reason `matterDocument` above gives.
  const filesRepo = () => require('../../src/modules/files/files.repository');

  it("refuses a folder belonging to another firm", async () => {
    const theirRoot = await filesRepo().ensureScopeRoot(rival.id, { scope: 'firm' });

    const res = await generate(owner, { destinationFolderId: theirRoot });

    // The lookup is scoped to the caller's firm, so a real id from another firm
    // resolves to nothing at all. That is the whole check: cross-firm filing is
    // not a rule the code has to remember to apply.
    expect(res.status).toBe(404);
    expect(await sessionCount()).toBe(0);
  });

  it('refuses a document where a folder belongs', async () => {
    const root = await filesRepo().ensureScopeRoot(firm.id, { scope: 'firm' });
    const doc = await filesRepo().createFile(firm.id, {
      parentId: root, name: 'not-a-folder.pdf', mimeType: 'application/pdf',
    });

    const res = await generate(owner, { destinationFolderId: doc.id });

    expect(res.status).toBe(400);
    expect(await sessionCount()).toBe(0);
  });

  it('refuses a folder that has been deleted', async () => {
    const root = await filesRepo().ensureScopeRoot(firm.id, { scope: 'firm' });
    const folder = await filesRepo().createFolder(firm.id, { parentId: root, name: 'Gone' });
    await filesRepo().softDeleteSubtree(firm.id, folder.id, owner.uid);

    const res = await generate(owner, { destinationFolderId: folder.id });

    // A session outlives its folder. Refusing at send time is the cheap half;
    // the finalize path re-checks and falls back to General Files for a folder
    // deleted while signing was already open.
    expect(res.status).toBe(404);
    expect(await sessionCount()).toBe(0);
  });

  it('accepts a real folder and records it', async () => {
    const root = await filesRepo().ensureScopeRoot(firm.id, { scope: 'firm' });

    const res = await generate(owner, { destinationFolderId: root });

    expect(res.status).toBe(200);
    // The boundary from below for the three refusals above, which a blanket
    // rejection would also satisfy.
    const [session] = await sessionRows();
    expect(session.destination_folder_id).toBe(root);
  });

  it('has no way to name the places filing was never allowed', async () => {
    // The preserved-record archives and the scratch prefix an open session works
    // in used to need an allow-list, because a destination was a path string and
    // those paths were spellable. They are system storage with no folder row, so
    // there is no id a request could carry.
    const { rows } = await testPool.query(
      `select count(*)::int n from files where law_firm_id = $1 and kind = 'folder'`,
      [firm.id],
    );
    const roots = await testPool.query(
      `select count(*)::int n from files where law_firm_id = $1 and parent_id is null`,
      [firm.id],
    );
    expect(rows[0].n).toBe(roots.rows[0].n);
  });
});

describe('signers and fields must line up', () => {
  it('refuses a field keyed to a signer nobody supplied', async () => {
    const res = await generate(owner, {
      signers: [{ participantId: 'signer-a', roleLabel: 'Client', name: 'A', email: 'a@example.test' }],
      fields: [{
        id: 'f1', page: 1, xPercent: 10, yPercent: 10, widthPercent: 20, heightPercent: 5,
        fieldType: 'signature', signerId: 'signer-nobody',
      }],
    });

    // A field pointing at an unknown signer is filtered out on the public read
    // path, so the signer is shown a document with a field missing and no
    // diagnosis. Failing at create time is the only place it is visible.
    expect(res.status).toBe(400);
    expect(await sessionCount()).toBe(0);
  });

  it('accepts a field keyed to a signer that was supplied', async () => {
    const res = await generate(owner, {
      signers: [{ participantId: 'signer-a', roleLabel: 'Client', name: 'A', email: 'a@example.test' }],
      fields: [{
        id: 'f1', page: 1, xPercent: 10, yPercent: 10, widthPercent: 20, heightPercent: 5,
        fieldType: 'signature', signerId: 'signer-a',
      }],
    });

    expect(res.status).toBe(200);
  });

  it('refuses a signer bound to a member of another firm', async () => {
    const outsider = await ownerOf(rival.id);

    const res = await generate(owner, {
      signers: [{ roleLabel: 'Counsel', name: 'B', email: 'b@example.test', memberUserId: outsider.uid }],
    });

    // A bound identity decides where the completed PDF is delivered and who is
    // treated as the signer. An arbitrary uid here would post an executed
    // document into a stranger's conversation thread.
    expect(res.status).toBe(400);
    expect(await sessionCount()).toBe(0);
  });

  it('refuses a signer bound to a client of another firm', async () => {
    const portalUid = `portal-${randomUUID().slice(0, 8)}`;
    await testPool.query(
      `insert into users (id, email, name, user_type) values ($1, $2, 'Outsider', 'client')`,
      [portalUid, `${portalUid}@example.test`],
    );
    await testPool.query(
      `insert into clients (id, law_firm_id, name, client_type, user_id)
       values ($1, $2, 'Outside Client', 'person', $3)`,
      [randomUUID(), rival.id, portalUid],
    );

    const res = await generate(owner, {
      signers: [{ roleLabel: 'Client', name: 'C', email: 'c@example.test', clientUserId: portalUid }],
    });

    expect(res.status).toBe(400);
    expect(await sessionCount()).toBe(0);
  });
});

describe('re-sending a link', () => {
  it('re-delivers the SAME link, emails it, and records the reminder', async () => {
    const seeded = await seedSession();

    const res = await resend(owner, firm.id, seeded.sessionToken, seeded.participantId);

    expect(res.status).toBe(200);
    // A re-send is a reminder, not a reissue. Minting a second token would leave
    // two live credentials for one signer slot; invalidating the first would
    // break the link already sitting in the signer's inbox. Exactly one token
    // row, still the original, still unconsumed.
    const { rows } = await testPool.query(
      `select token, consumed_at from signature_participant_tokens where participant_id = $1`,
      [seeded.participantId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].token).toBe(seeded.publicToken);
    expect(rows[0].consumed_at).toBeNull();
    // The stored token being unchanged is only half the claim: the message the
    // signer actually receives has to carry it. A re-send that emailed a
    // different token would strand them on a dead URL.
    const delivered = sentEmails().filter((m) => String(m.html || '').includes(seeded.publicToken));
    expect(delivered).toHaveLength(1);
    expect(delivered[0].to).toBe('signer@example.test');
    // The counter is what the next re-send is rate-limited against, and what the
    // audit trail counts. A 200 that wrote nothing would let a firm resend in a
    // loop.
    const state = await reminderState(seeded.participantId);
    expect(state.reminder_count).toBe(1);
    expect(state.last_reminder_sent_at).not.toBeNull();
  });

  it('refuses a second re-send inside the cooling-off minute, and sends nothing', async () => {
    const seeded = await seedSession({
      lastReminderSentAt: new Date(Date.now() - 10_000).toISOString(),
      reminderCount: 1,
    });

    const res = await resend(owner, firm.id, seeded.sessionToken, seeded.participantId);

    expect(res.status).toBe(429);
    expect(res.body.details.retryAfterSeconds).toBeGreaterThan(0);
    // Asserting the absence only works because the case above proves the route
    // does send when it is allowed to. The count is also left alone, so a
    // refused attempt cannot push the cooling-off window forward.
    expect(sentEmails()).toHaveLength(0);
    expect((await reminderState(seeded.participantId)).reminder_count).toBe(1);
  });


  it('allows a re-send once the minute has passed', async () => {
    const seeded = await seedSession({
      lastReminderSentAt: new Date(Date.now() - 120_000).toISOString(),
      reminderCount: 1,
    });

    const res = await resend(owner, firm.id, seeded.sessionToken, seeded.participantId);

    // The boundary from below: the limit is a cooling-off period, not a cap. A
    // firm chasing a signature the next day must not be locked out.
    expect(res.status).toBe(200);
    expect((await reminderState(seeded.participantId)).reminder_count).toBe(2);
  });

  it('sends one email when two re-sends of the same signer overlap', async () => {
    const seeded = await seedSession();
    const gate = gateMethod(signaturesRepo, 'claimReminderSend');

    try {
      // Both requests are in flight and both are proved to be paused inside the
      // claim at the same instant. A bare `Promise.all` would not prove that,
      // and would pass against the check-then-act version this replaced: the
      // cooling-off comparison read a stamp neither request had written yet.
      async function resendOnce() {
        return resend(owner, firm.id, seeded.sessionToken, seeded.participantId);
      }
      const first = resendOnce();
      const second = resendOnce();

      await gate.arrived(2);
      gate.open();

      const [resA, resB] = await Promise.all([first, second]);
      await drainEvents();

      // One winner and one refusal. Two 200s here means the signer was mailed
      // the same reminder twice by one double-click.
      expect([resA.status, resB.status].sort()).toEqual([200, 429]);
      expect(sentEmails()).toHaveLength(1);
      expect((await reminderState(seeded.participantId)).reminder_count).toBe(1);
    } finally {
      gate.restore();
    }
  });

  it('refuses when reminders are switched off globally', async () => {
    const seeded = await seedSession();
    process.env.DISABLE_ALL_REMINDER_EMAILS = 'true';

    const res = await resend(owner, firm.id, seeded.sessionToken, seeded.participantId);

    // The operational kill switch. It has to hold on the manual re-send too, not
    // just the reminder cron, or the switch is not a switch.
    expect(res.status).toBe(409);
    expect(sentEmails()).toHaveLength(0);
  });
});

describe('re-sending across firms', () => {
  it('answers not-found when another firm asks about this firm\'s session, and sends nothing', async () => {
    const seeded = await seedSession();

    const res = await resend(rivalOwner, rival.id, seeded.sessionToken, seeded.participantId);

    // The session token is the only thing addressing the session, and the router
    // is mounted under the CALLER's firm id, so the firm on the session is what
    // stops the cross-firm read. Not-found rather than forbidden: a firm should
    // not learn that a token it guessed is real.
    expect(res.status).toBe(404);
    // The signer must not receive a reminder that a firm with no relationship to
    // the document caused, and the reminder counter must not move.
    expect(sentEmails()).toHaveLength(0);
    expect((await reminderState(seeded.participantId)).reminder_count).toBe(0);
  });

  it('answers not-found when a firm names its own id but another firm\'s session', async () => {
    const seeded = await seedSession({ lawFirmId: rival.id, createdBy: rivalOwner.uid });

    const res = await resend(owner, firm.id, seeded.sessionToken, seeded.participantId);

    // The mirror image: the caller is a legitimate member of the firm in the
    // URL, and the session belongs to someone else. Only the comparison of the
    // two catches this.
    expect(res.status).toBe(404);
  });
});

describe('which sessions may be re-sent', () => {
  it('refuses a completed session', async () => {
    const seeded = await seedSession({ status: 'completed', participantStatus: 'completed' });

    const res = await resend(owner, firm.id, seeded.sessionToken, seeded.participantId);

    // An executed document has no outstanding signature to chase, and its link
    // is spent.
    expect(res.status).toBe(409);
  });

  it('refuses a cancelled session', async () => {
    const seeded = await seedSession({ status: 'cancelled', participantStatus: 'cancelled' });

    const res = await resend(owner, firm.id, seeded.sessionToken, seeded.participantId);

    // Cancelling is how a firm withdraws a request. Re-sending afterwards would
    // put a dead link back in front of the signer.
    expect(res.status).toBe(409);
  });

  it('refuses a signer who already signed', async () => {
    const seeded = await seedSession({ status: 'in_progress', participantStatus: 'completed' });

    const res = await resend(owner, firm.id, seeded.sessionToken, seeded.participantId);

    expect(res.status).toBe(400);
    expect(sentEmails()).toHaveLength(0);
  });

  it('allows a signer still waiting their turn', async () => {
    const seeded = await seedSession({ status: 'in_progress', participantStatus: 'waiting' });

    // Waiting signers can be given their link early in sequential routing, so
    // this is deliberately permitted; the boundary from below for the case above.
    expect((await resend(owner, firm.id, seeded.sessionToken, seeded.participantId)).status).toBe(200);
  });

  it('answers not-found for a participant that is not in the session', async () => {
    const seeded = await seedSession();

    const res = await resend(owner, firm.id, seeded.sessionToken, 'part-nobody');

    expect(res.status).toBe(404);
  });
});

describe('the firm signing history', () => {
  it('lists this firm\'s sessions and not another firm\'s', async () => {
    const mine = await seedSession({ fileName: 'Mine.pdf' });
    await seedSession({ lawFirmId: rival.id, createdBy: rivalOwner.uid, fileName: 'Theirs.pdf' });

    const res = await owner.api.get(`${links(firm.id)}/sessions`);

    expect(res.status).toBe(200);
    expect(res.body.sessions.map((s: any) => s.token)).toEqual([mine.sessionToken]);
    expect(res.body.totalItems).toBe(1);
  });

  it('counts the whole history, not the page returned', async () => {
    await seedSession();
    await seedSession();
    await seedSession();

    const res = await owner.api.get(`${links(firm.id)}/sessions?limit=2`);

    // `totalItems` drives the pager. Reporting the page length would make the
    // second page unreachable and silently hide older sessions.
    expect(res.body.sessions).toHaveLength(2);
    expect(res.body.totalItems).toBe(3);
  });

  it('narrows to a status when one is asked for', async () => {
    const pending = await seedSession({ status: 'pending' });
    await seedSession({ status: 'completed', participantStatus: 'completed', completedAt: new Date().toISOString() });

    const res = await owner.api.get(`${links(firm.id)}/sessions?status=pending`);

    expect(res.body.sessions.map((s: any) => s.token)).toEqual([pending.sessionToken]);
  });

  it('finds a session by its signer\'s email', async () => {
    const wanted = await seedSession({ email: 'reginald@counterparty.test' });
    await seedSession({ email: 'someone@else.test' });

    const res = await owner.api.get(`${links(firm.id)}/sessions?search=counterparty`);

    // Search reaches the participant rows, not only the session's own columns:
    // on a multi-signer document the session carries no single signer name.
    expect(res.body.sessions.map((s: any) => s.token)).toEqual([wanted.sessionToken]);
  });

  it('summarises the counts per status over the whole history', async () => {
    await seedSession({ status: 'pending' });
    await seedSession({ status: 'pending' });
    await seedSession({ status: 'completed', participantStatus: 'completed' });

    const res = await owner.api.get(`${links(firm.id)}/sessions/summary`);

    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ pending: 2, completed: 1 });
    expect(res.body.total).toBe(3);
    // The synthetic "still outstanding" filter, derived here so the client does
    // not have to know which statuses it spans.
    expect(res.body.notCompleted).toBe(2);
  });

  it('counts nothing for another firm', async () => {
    await seedSession({ lawFirmId: rival.id, createdBy: rivalOwner.uid });

    const res = await owner.api.get(`${links(firm.id)}/sessions/summary`);

    expect(res.body.counts).toEqual({});
    expect(res.body.total).toBe(0);
  });
});

describe('what is waiting for one user', () => {
  it('reports a session where the caller is the active signer', async () => {
    const seeded = await seedSession({ memberUserId: owner.uid, createdBy: 'someone-else' });

    const res = await owner.api.get(`${links(firm.id)}/pending-for-user`);

    expect(res.status).toBe(200);
    expect(res.body.needsMySignature.map((s: any) => s.sessionToken)).toEqual([seeded.sessionToken]);
    // Their own link, so the dashboard can send them straight into signing.
    expect(res.body.needsMySignature[0].publicToken).toBe(seeded.publicToken);
  });

  it('reports a session the caller sent, in the other bucket', async () => {
    const seeded = await seedSession({ createdBy: owner.uid, memberUserId: null });

    const res = await owner.api.get(`${links(firm.id)}/pending-for-user`);

    expect(res.body.createdByMe.map((s: any) => s.sessionToken)).toEqual([seeded.sessionToken]);
    // The sender is not a signer, so nothing is waiting on THEM.
    expect(res.body.needsMySignature).toEqual([]);
  });

  it('reports nothing for a session belonging to another firm', async () => {
    await seedSession({ lawFirmId: rival.id, createdBy: owner.uid, memberUserId: owner.uid });

    const res = await owner.api.get(`${links(firm.id)}/pending-for-user`);

    // The caller is both the sender and the signer; only the firm scope keeps
    // the other firm's session out of their dashboard.
    expect(res.body.needsMySignature).toEqual([]);
    expect(res.body.createdByMe).toEqual([]);
  });

  it('reports nothing for a session that is already finished', async () => {
    await seedSession({ status: 'completed', participantStatus: 'completed', memberUserId: owner.uid });

    const res = await owner.api.get(`${links(firm.id)}/pending-for-user`);

    expect(res.body.needsMySignature).toEqual([]);
    expect(res.body.createdByMe).toEqual([]);
  });
});

describe('a field or signer id is the client\'s name for it, not a row key', () => {
  // The placer loads a saved signing template by spreading its stored fields,
  // ids included, so every session sent from one template carries the same
  // field ids. A draft signer's participantId is likewise chosen by the
  // browser. Neither may collide with a row another session already holds.
  const templateSigner = {
    participantId: 'template-signer', roleLabel: 'Client', name: 'A', email: 'a@example.test',
  };
  const templateField = {
    id: 'template-signature', page: 1, xPercent: 10, yPercent: 10, widthPercent: 20, heightPercent: 5,
    fieldType: 'signature', signerId: 'template-signer',
  };

  async function sessionGraph(sessionToken: string) {
    const { rows: fields } = await testPool.query(
      `select id, signer_id from signature_fields where session_id = ${sessionIdSql('$1')}`,
      [sessionToken],
    );
    const { rows: participants } = await testPool.query(
      `select id from signature_participants where session_id = ${sessionIdSql('$1')}`,
      [sessionToken],
    );
    return { fields, participantIds: participants.map((p: any) => p.id) };
  }

  it('creates a second session from the same template ids, each holding its own rows', async () => {
    const first = await generate(owner, { signers: [templateSigner], fields: [templateField] });
    const second = await generate(owner, { signers: [templateSigner], fields: [templateField] });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.sessionToken).not.toBe(first.body.sessionToken);

    const a = await sessionGraph(first.body.sessionToken);
    const b = await sessionGraph(second.body.sessionToken);
    // The field keeps the id the client sent, inside each session.
    expect(a.fields.map((f: any) => f.id)).toEqual(['template-signature']);
    expect(b.fields.map((f: any) => f.id)).toEqual(['template-signature']);
    // Each session's signer is its own row, and each field still points at
    // the signer of ITS session rather than at the client's draft id.
    expect(a.participantIds).toHaveLength(1);
    expect(b.participantIds).toHaveLength(1);
    expect(a.participantIds[0]).not.toBe(b.participantIds[0]);
    expect(a.fields[0].signer_id).toBe(a.participantIds[0]);
    expect(b.fields[0].signer_id).toBe(b.participantIds[0]);
  });

  it('does the same through /send, and the copy links name the server\'s participant', async () => {
    const copySigner = { ...templateSigner, deliveryMethod: 'copy_link' };
    const send = () => owner.api.post(`${links(firm.id)}/send`).send({
      objectPath: sourcePath,
      fileName: 'Engagement Agreement.pdf',
      signers: [copySigner],
      fields: [templateField],
    });

    const first = await send();
    const second = await send();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const a = await sessionGraph(first.body.sessionToken);
    const b = await sessionGraph(second.body.sessionToken);
    expect(a.participantIds[0]).not.toBe(b.participantIds[0]);
    expect(first.body.copyLinks.map((l: any) => l.participantId)).toEqual(a.participantIds);
    expect(second.body.copyLinks.map((l: any) => l.participantId)).toEqual(b.participantIds);
  });

  it('lets two firms use the same field and signer ids', async () => {
    const rivalSource = `lawfirmids/${rival.id}/general/Engagement Agreement.pdf`;
    putObject(rivalSource);

    const ours = await generate(owner, { signers: [templateSigner], fields: [templateField] });
    const theirs = await rivalOwner.api.post(`${links(rival.id)}/generate`).send({
      objectPath: rivalSource,
      fileName: 'Engagement Agreement.pdf',
      signers: [templateSigner],
      fields: [templateField],
    });

    expect(ours.status).toBe(200);
    expect(theirs.status).toBe(200);
    const { rows } = await testPool.query(
      `select law_firm_id from signature_fields where id = 'template-signature' and law_firm_id = any($1)`,
      [[firm.id, rival.id]],
    );
    expect(rows.map((r: any) => r.law_firm_id).sort()).toEqual([firm.id, rival.id].sort());
  });

  it('refuses two signers in one request sharing a participantId, and creates nothing', async () => {
    const res = await generate(owner, {
      signers: [templateSigner, { ...templateSigner, name: 'B', email: 'b@example.test' }],
      fields: [templateField],
    });

    // Which of the two the field belongs to is undecidable, so the request is
    // refused rather than silently giving the field to one of them.
    expect(res.status).toBe(400);
    expect(await sessionCount()).toBe(0);
  });

  it.each([
    ['blank', '   '],
    ['longer than 200 characters', 'f'.repeat(201)],
  ])('refuses a field id that is %s', async (_label, id) => {
    const res = await generate(owner, { signers: [templateSigner], fields: [{ ...templateField, id }] });

    expect(res.status).toBe(400);
    expect(await sessionCount()).toBe(0);
  });

  it('stores a field id trimmed', async () => {
    const res = await generate(owner, {
      signers: [templateSigner], fields: [{ ...templateField, id: '  padded-id  ' }],
    });

    expect(res.status).toBe(200);
    const { fields } = await sessionGraph(res.body.sessionToken);
    expect(fields.map((f: any) => f.id)).toEqual(['padded-id']);
  });
});
