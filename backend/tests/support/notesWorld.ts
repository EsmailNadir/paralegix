/**
 * Note fixtures and row readers shared by the matter, task and client notes
 * specs. All three parents store their notes in the one `notes` table, with one
 * nullable FK per parent, so the readers here serve every parent.
 *
 * Seeds go straight into the table rather than through the notes routes, so a
 * broken notes module cannot produce both the row and the expectation.
 */
import { randomUUID } from 'crypto';

import type { Actor } from './actors';
import { testPool } from './db';

/** Exactly one of these names the note's parent. */
export type NoteParent = { matterId: string } | { taskId: string } | { clientId: string };

export interface NoteSeed {
  content?: string;
  subject?: string | null;
  createdBy?: string | null;
}

/** A note on the given parent. Returns its id and the content it was given. */
export async function seedNote(
  lawFirmId: string,
  parent: NoteParent,
  seed: NoteSeed = {},
): Promise<{ id: string; content: string }> {
  const id = randomUUID();
  const content = seed.content ?? `Note ${id.slice(0, 8)}`;
  const res = await testPool.query(
    `insert into notes (id, law_firm_id, matter_id, task_id, client_id, content, subject, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id, lawFirmId,
      'matterId' in parent ? parent.matterId : null,
      'taskId' in parent ? parent.taskId : null,
      'clientId' in parent ? parent.clientId : null,
      content, seed.subject ?? null, seed.createdBy ?? null,
    ],
  );
  expect(res.rowCount).toBe(1);
  return { id, content };
}

/** The stored note, or null when no row has that id. */
export async function noteRow(id: string) {
  const { rows } = await testPool.query(
    `select content, content_html, pinned_at, retracted_at, retraction_reason,
            matter_id, task_id, client_id
       from notes where id = $1`,
    [id],
  );
  return rows[0] || null;
}

/** Every note in the firm, whatever its parent. */
export async function noteCount(lawFirmId: string): Promise<number> {
  const { rows } = await testPool.query(
    'select count(*)::int as n from notes where law_firm_id = $1',
    [lawFirmId],
  );
  return rows[0].n;
}

/** The stored reply, or null when no row has that id. */
export async function replyRow(id: string) {
  const { rows } = await testPool.query(
    'select content, parent_reply_id, retracted_at from note_replies where id = $1',
    [id],
  );
  return rows[0] || null;
}

/** The contents of a notes list response, in response order. */
export const noteContents = (body: any): string[] => (body.notes || []).map((n: any) => n.content);

export interface NoteEngineWalk {
  /** A caller allowed to read and write this parent's notes. */
  actor: Actor;
  lawFirmId: string;
  parent: NoteParent;
  /** The parent's notes route, with `suffix` appended. */
  notesPath: (suffix?: string) => string;
}

/**
 * Walks one note through every shared engine route under ONE parent adapter:
 * edit, versions, pin, unpin, replies, time, retraction and the edit lock.
 *
 * Every parent mounts the same engine, so the engine's own rules are pinned in
 * depth once, in `matterNotes.test.ts`. What each adapter still owns is the
 * wiring: that each route reaches the engine with this parent's id and gates.
 * One pass per adapter proves that without restating the engine three times.
 *
 * The note is seeded with no subject, HTML or date, so the edit and its
 * version snapshot take the empty-field paths a route-created note never does.
 */
export async function walkNoteEngine({ actor, lawFirmId, parent, notesPath }: NoteEngineWalk) {
  const note = await seedNote(lawFirmId, parent, { content: 'Seeded' });
  const at = (suffix: string) => notesPath(`/${note.id}${suffix}`);

  const edited = await actor.api.put(at('')).send({ content: 'Edited' });
  expect(edited.status).toBe(200);
  const versions = await actor.api.get(at('/versions'));
  expect(versions.body.versions.map((v: any) => v.content)).toEqual(['Seeded']);

  expect((await actor.api.put(at('/pin')).send({ pinned: true })).status).toBe(200);
  expect((await noteRow(note.id)).pinned_at).not.toBeNull();
  expect((await actor.api.put(at('/pin')).send({ pinned: false })).status).toBe(200);
  expect((await noteRow(note.id)).pinned_at).toBeNull();

  const missing = await actor.api.get(notesPath(`/${randomUUID()}/replies`));
  expect(missing.status).toBe(404);
  expect(missing.body.error).toBe('Note not found');
  const reply = await actor.api.post(at('/replies')).send({ content: 'A reply' });
  expect(reply.status).toBe(201);
  expect((await actor.api.delete(at(`/replies/${reply.body.reply.id}`)).send({})).status).toBe(200);
  expect(await replyRow(reply.body.reply.id)).toMatchObject({ content: 'A reply', retracted_at: expect.any(Date) });

  const time = await actor.api.post(at('/time')).send({
    timeSpent: 1, timeEntryDate: '2026-09-01', activityName: 'Call', isBillable: true,
  });
  expect(time.status).toBe(201);
  const entryId = time.body.note.time.entries[0].id;
  const retimed = await actor.api.put(at(`/time/${entryId}`)).send({
    timeSpent: 2, timeEntryDate: '2026-09-01', activityName: 'Call', isBillable: true,
  });
  expect(retimed.body.note.time.totalHours).toBe(2);
  const untimed = await actor.api.delete(at(`/time/${entryId}`));
  expect(untimed.body.note.time.entries).toEqual([]);

  // No reason given, so none is stored rather than an empty string.
  expect((await actor.api.delete(at('')).send({})).status).toBe(200);
  expect(await noteRow(note.id)).toMatchObject({
    content: 'Edited', retracted_at: expect.any(Date), retraction_reason: null,
  });
  const locked = await actor.api.put(at('')).send({ content: 'After retraction' });
  expect(locked.status).toBe(403);
  expect((await noteRow(note.id)).content).toBe('Edited');
}
