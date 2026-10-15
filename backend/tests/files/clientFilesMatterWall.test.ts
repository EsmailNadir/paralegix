/**
 * A client's own files follow the same matter wall as the client's notes.
 *
 * Client notes are gated by `assertClientNoteAccess`: a client on one or more
 * matters is readable only by someone staffed on one of them; a client on no
 * matter is firm-wide (the intake case); owners, firm admins and
 * `notes.viewFirmWide` holders always pass. Client-scoped documents used to
 * check firm membership alone, so a member walled off from every one of the
 * client's matters could list the client's folder, mint a download URL for any
 * file in it, and attach one of those files to a note elsewhere.
 *
 * What has to break for each case to go red:
 *   - the walled-member refusals: the client arm of `resolveFileScope`, the
 *     client branch of `assertFileRowsReadable`, the `clientId` the attachment
 *     check passes through, or the client branch of `assertObjectPathReadAccess`
 *     falling back to plain firm membership.
 *   - the allowed cases: the wall being drawn tighter than the notes rule
 *     (staffed member, owner, admin, notes.viewFirmWide, unattached client).
 */
import {
  createFirm,
  createPersonClient,
  memberWith,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { signedUrlCalls } from '../support/inMemoryBucket';
import { installRichBucket, resetRichBucket } from './richBucket';
import { joinMatter, rootOf, seedFile, seedMatter } from './fileWorld';

installRichBucket();

const { assertObjectPathReadAccess } = require('../../src/shared/utils/objectPathAccess');

const MEMBER_PERMS = ['files.view', 'files.upload', 'clients.view', 'clients.manage'];

let firm: Firm;
let owner: Actor;
let clientId: string;
let matterId: string;
let file: { id: string; objectPath: string; name: string };

const F = () => `/api/lawfirms/${firm.id}/files`;
const listClientRoot = (actor: Actor, id = clientId) =>
  actor.api.get(`${F()}/list-folder?lawFirmId=${firm.id}&clientId=${id}`);
const downloadUrl = (actor: Actor, fileId = file.id) =>
  actor.api.get(`${F()}/download-url?lawFirmId=${firm.id}&fileId=${fileId}`);

/** A firm-wide client the actor may write notes on, used as the attachment's host. */
async function noteOnOpenClient(actor: Actor, attachFileId: string) {
  const open = await createPersonClient(firm.id, { name: 'Open Intake' });
  return actor.api.post(`/api/lawfirms/${firm.id}/clients/${open.id}/notes`)
    .send({ content: 'See attached.', attachments: [{ id: attachFileId, name: 'Retainer.pdf' }] });
}

const linkCount = async (fileId: string) => Number((await testPool.query(
  'select count(*) as n from attachments where file_id = $1', [fileId],
)).rows[0].n);

async function attachClientToMatter(id: string, mId: string) {
  const { rowCount } = await testPool.query(
    'insert into matter_clients (matter_id, client_id, law_firm_id) values ($1, $2, $3)',
    [mId, id, firm.id],
  );
  expect(rowCount).toBe(1);
}

beforeEach(async () => {
  resetRichBucket();
  firm = await createFirm({ name: 'Wall & Partners' });
  owner = await ownerOf(firm.id);
  clientId = (await createPersonClient(firm.id, { name: 'Walled Client' })).id;
  matterId = await seedMatter(firm.id, owner.uid, 'Walled Matter');
  await attachClientToMatter(clientId, matterId);
  file = await seedFile(firm.id, { parentId: await rootOf(firm.id, { clientId }), name: 'Retainer.pdf' });
});

describe('a member walled off from every one of the client\'s matters', () => {
  let walled: Actor;
  beforeEach(async () => { walled = await memberWith(firm.id, MEMBER_PERMS); });

  it('cannot list the client\'s files', async () => {
    const res = await listClientRoot(walled);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('Retainer.pdf');
  });

  it('cannot mint a download URL for one of them, and nothing is signed', async () => {
    const before = signedUrlCalls.length;
    const res = await downloadUrl(walled);
    expect(res.status).toBe(403);
    expect(signedUrlCalls.length).toBe(before);
  });

  it('cannot attach one of them to a note, and no note or link is written', async () => {
    const res = await noteOnOpenClient(walled, file.id);
    expect(res.status).toBe(403);
    expect(await linkCount(file.id)).toBe(0);
    const notes = await testPool.query('select 1 from notes where law_firm_id = $1', [firm.id]);
    expect(notes.rowCount).toBe(0);
  });

  it('is refused by the object-path read gate', async () => {
    await expect(assertObjectPathReadAccess(firm.id, file.objectPath, walled.uid))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it('still gets 404, not 403, for a client id that does not exist', async () => {
    const res = await listClientRoot(walled, '00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
  });
});

describe('who still reaches the client\'s files', () => {
  async function expectFullAccess(actor: Actor) {
    const listed = await listClientRoot(actor);
    expect(listed.status).toBe(200);
    expect(listed.body.files.map((f: any) => f.name)).toEqual(['Retainer.pdf']);

    const minted = await downloadUrl(actor);
    expect(minted.status).toBe(200);

    await expect(assertObjectPathReadAccess(firm.id, file.objectPath, actor.uid)).resolves.toBeUndefined();

    const noted = await noteOnOpenClient(actor, file.id);
    expect(noted.status).toBe(201);
    expect(await linkCount(file.id)).toBe(1);
  }

  it('a member staffed on one of the client\'s matters', async () => {
    const other = await seedMatter(firm.id, owner.uid, 'Second Matter');
    await attachClientToMatter(clientId, other);
    const staffed = await memberWith(firm.id, MEMBER_PERMS);
    await joinMatter(firm.id, other, staffed.uid);
    await expectFullAccess(staffed);
  });

  it('the firm owner, who is not on the matter', async () => {
    await testPool.query('delete from matter_members where matter_id = $1', [matterId]);
    await expectFullAccess(owner);
  });

  it('a firm admin who is not on the matter', async () => {
    await expectFullAccess(await memberWith(firm.id, [...MEMBER_PERMS, 'members.changeRole']));
  });

  it('a holder of notes.viewFirmWide, as for client notes', async () => {
    await expectFullAccess(await memberWith(firm.id, [...MEMBER_PERMS, 'notes.viewFirmWide']));
  });

  it('any member, when the client is on no matter at all', async () => {
    await testPool.query('delete from matter_clients where client_id = $1', [clientId]);
    await expectFullAccess(await memberWith(firm.id, MEMBER_PERMS));
  });
});

describe('another firm', () => {
  it('cannot reach the client\'s files even though the client is on no matter', async () => {
    await testPool.query('delete from matter_clients where client_id = $1', [clientId]);
    const rival = await createFirm({ name: 'Rival LLP' });
    const rivalOwner = await ownerOf(rival.id);

    const listed = await rivalOwner.api.get(`${F()}/list-folder?lawFirmId=${firm.id}&clientId=${clientId}`);
    expect(listed.status).toBe(403);
    await expect(assertObjectPathReadAccess(firm.id, file.objectPath, rivalOwner.uid))
      .rejects.toMatchObject({ statusCode: 403 });
  });
});
