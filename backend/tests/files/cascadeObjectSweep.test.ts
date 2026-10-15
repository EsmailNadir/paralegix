/**
 * Deleting a parent removes its documents' stored objects in the request.
 *
 * The `files` rows cascade away with a matter, a task or a client, but the
 * objects they named have no foreign key. The sweep used to run in an event
 * listener after the response, and Cloud Run stops scheduling CPU once the
 * response is sent, so the objects stayed and the firm stayed charged.
 *
 * Each case mutes the event bus, which is what a starved listener looks like
 * from here. What has to break for these to go red: move the sweep back into a
 * listener, or stop crediting the firm for what it removed.
 */
import { installInMemoryBucket, objects } from '../support/inMemoryBucket';
import {
  createFirm,
  createPersonClient,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import {
  rootOf, seedFile, seedMatter, seedTask, setStorageUsed, storageUsedBytes,
} from './fileWorld';

installInMemoryBucket();

const eventBus = require('../../src/shared/events/eventBus');

let firm: Firm;
let owner: Actor;

beforeEach(async () => {
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
});

/** Two documents under a scope root, and a known storage figure to credit against. */
async function seedTwoDocuments(root: string) {
  const a = await seedFile(firm.id, { parentId: root, name: 'a.pdf', bytes: 300 });
  const b = await seedFile(firm.id, { parentId: root, name: 'b.pdf', bytes: 500 });
  await setStorageUsed(firm.id, 10_000);
  return [a, b];
}

/** Run a delete with no listener reacting to what it emits. */
async function withoutListeners(run: () => Promise<{ status: number }>) {
  const muted = jest.spyOn(eventBus, 'emit').mockReturnValue(true);
  try {
    const res = await run();
    expect(res.status).toBe(200);
  } finally {
    muted.mockRestore();
  }
}

describe('deleting a parent removes its documents in the request', () => {
  it('a matter', async () => {
    const matterId = await seedMatter(firm.id, owner.uid, 'Doomed');
    const docs = await seedTwoDocuments(await rootOf(firm.id, { matterId }));

    await withoutListeners(() => owner.api.delete(`/api/lawfirms/${firm.id}/matters/${matterId}`));

    expect(docs.map((d) => objects.has(d.objectPath))).toEqual([false, false]);
    expect(await storageUsedBytes(firm.id)).toBe(9_200);
  });

  it('a standalone task', async () => {
    const taskId = await seedTask(firm.id, { matterId: null });
    const docs = await seedTwoDocuments(await rootOf(firm.id, { taskId }));

    await withoutListeners(() => owner.api.delete(`/api/lawfirms/${firm.id}/tasks/${taskId}`));

    expect(docs.map((d) => objects.has(d.objectPath))).toEqual([false, false]);
    expect(await storageUsedBytes(firm.id)).toBe(9_200);
  });

  it('a client', async () => {
    const client = await createPersonClient(firm.id);
    const docs = await seedTwoDocuments(await rootOf(firm.id, { clientId: client.id }));

    await withoutListeners(() => owner.api.delete(`/api/lawfirms/${firm.id}/clients/${client.id}`));

    expect(docs.map((d) => objects.has(d.objectPath))).toEqual([false, false]);
    expect(await storageUsedBytes(firm.id)).toBe(9_200);
  });
});
