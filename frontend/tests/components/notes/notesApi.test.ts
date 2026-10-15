/**
 * The shared note-CRUD surface, tested OFFLINE against a fake transport.
 *
 * `createNotesApi` is instantiated three times, once per parent entity, and the
 * only difference between the three is two strings: the url segment and the name
 * of the id field on an upload. Everything else, fifteen methods of url
 * building, query construction, body shaping and error mapping, is one
 * implementation shared by matter notes, task notes and client notes. That is
 * the point of the module and also its risk: a mistake here is a mistake on
 * every notes panel in the app at once.
 *
 * The existing spec for this area, `tests/components/notes/NotesSection.test.tsx`,
 * runs under the global service Proxy in `tests/setup.ts`, so none of this code
 * executes there. This file unmocks and fakes `fetch` instead.
 *
 * WHAT THIS FILE IS ABOUT
 *
 * 1. THE PARENT SEGMENT IS WHOSE NOTES THESE ARE. The factory argument is the
 *    only thing separating `/matters/:id/notes` from `/tasks/:id/notes`, and
 *    both answer with a list of notes. Getting it wrong shows one entity's
 *    private notes on another's panel and writes new ones there too.
 *
 * 2. THE FIRM SEGMENT IS THE TENANT BOUNDARY, and note bodies are the most
 *    sensitive free text the product holds.
 *
 * 3. AN 'ALL' FILTER IS NOT A FILTER. The panel spells "no filter" as the string
 *    'all' for three of its controls, and the server has no such value. Sending
 *    it returns nothing, which reads as an entity with no notes.
 *
 * 4. RETRACTING IS NOT DELETING. Retraction uses the DELETE verb but keeps the
 *    note and its time entries, which is why it carries a reason and answers
 *    with the note it just retracted.
 */
jest.unmock('@/services/notesApi');
// The notes API delegates its uploads to the files service, so that has to be
// real too or the upload legs below are answered by a stub.
jest.unmock('@/services/files.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import { installXhrMock, type XhrMock } from '../../support/xhrMock';
import { createNotesApi } from '@/services/notesApi';
import { ApiError } from '@/lib/utils/apiErrors';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

const LAW_FIRM_ID = 'firm-1';
const MATTER_ID = 'matter-9';
const TASK_ID = 'task-4';
const CLIENT_ID = 'client-2';
const NOTE_ID = 'note-1';

const matterNotes = createNotesApi('matters', 'matterId');
const taskNotes = createNotesApi('tasks', 'taskId');
const clientNotes = createNotesApi('clients', 'clientId');

/** Query parameters read back the way a server reads them: a space is `+` on the wire. */
const paramsOf = (url: string): URLSearchParams => new URL(url, 'http://x').searchParams;

const bodyOf = (call: { body: unknown }): Record<string, unknown> =>
  call.body as Record<string, unknown>;

/** A note payload with the two fields every write requires, plus any overrides. */
const noteBody = (overrides: Record<string, unknown> = {}) => ({
  content: 'Called opposing counsel.',
  contentHtml: '<p>Called opposing counsel.</p>',
  ...overrides,
});

let api: ApiMock;
/** Attachments upload straight to storage now, on an XHR PUT `apiMock` cannot see. */
let xhr: XhrMock;

beforeEach(() => {
  api = installApiMock();
  xhr = installXhrMock();
  // An upload session outlives the test that saved it. Left behind, the next
  // test's file matches it on name, size and last-modified, skips init, and
  // then asserts against a request that was never made.
  try { window.localStorage.clear(); } catch { /* no storage in this env */ }
  // Several cases read one endpoint twice to compare two parameter sets, which
  // trips the dev-only duplicate-GET warning and buries the real output.
  __resetDuplicateRequestGuard();
});

afterEach(() => {
  xhr.restore();
  api.restore();
});

describe('the parent segment is whose notes these are', () => {
  it('reads matter notes from the matters route and task notes from the tasks route', async () => {
    api.get('/notes', { notes: [], totalNotes: 0 });

    await matterNotes.listNotes(LAW_FIRM_ID, MATTER_ID);
    await taskNotes.listNotes(LAW_FIRM_ID, TASK_ID);
    await clientNotes.listNotes(LAW_FIRM_ID, CLIENT_ID);

    // Three instances of one implementation, told apart only by the segment.
    // Both wrong answers are plausible: a shared segment shows the same notes on
    // every panel, and a swapped one shows a matter's privileged notes under a
    // task the client can see.
    expect(api.calls('GET').map((call) => call.pathname)).toEqual([
      '/api/lawfirms/firm-1/matters/matter-9/notes',
      '/api/lawfirms/firm-1/tasks/task-4/notes',
      '/api/lawfirms/firm-1/clients/client-2/notes',
    ]);
  });

  it('keeps the firm segment on the note write routes as well', async () => {
    api.post('/notes', { note: { id: NOTE_ID } });
    api.put(`/notes/${NOTE_ID}`, { note: { id: NOTE_ID } });
    api.delete(`/notes/${NOTE_ID}`, { message: 'ok', note: { id: NOTE_ID } });

    await matterNotes.addNote(LAW_FIRM_ID, MATTER_ID, noteBody());
    await matterNotes.updateNote(LAW_FIRM_ID, MATTER_ID, NOTE_ID, noteBody());
    await matterNotes.retractNote(LAW_FIRM_ID, MATTER_ID, NOTE_ID);

    // Tenant scoping is the application's job on these routes. A write that
    // loses the firm segment does not fail, it lands somewhere else.
    for (const call of api.calls()) {
      expect(call.pathname.startsWith('/api/lawfirms/firm-1/matters/matter-9/notes')).toBe(true);
    }
  });

  it('escapes the firm, parent and note ids so none of them can add a segment', async () => {
    api.get(`/notes/${encodeURIComponent('note/1 a')}`, { note: { id: 'note/1 a' } });

    await matterNotes.getNoteDetail('firm/1', 'matter 9', 'note/1 a');

    // Unescaped, a slash in any of the three splits it across segments and the
    // request addresses a shorter route that may still answer.
    expect(api.calls('GET')[0].pathname).toBe(
      `/api/lawfirms/firm%2F1/matters/matter%209/notes/${encodeURIComponent('note/1 a')}`,
    );
  });

  it('sends the credential and the timezone the backend requires', async () => {
    api.get('/notes', { notes: [], totalNotes: 0 });

    await matterNotes.listNotes(LAW_FIRM_ID, MATTER_ID);

    // `requireTimezone` rejects a request carrying no `X-Timezone`, so losing the
    // header turns every notes read into a 400 that reads as a broken panel.
    const { headers } = api.calls('GET')[0];
    expect(headers.authorization).toBe('Bearer mock-token');
    expect(headers['x-timezone']).toBeTruthy();
  });
});

describe('an all filter is not a filter', () => {
  it('omits the sentinel values the panel uses to mean unfiltered', async () => {
    api.get('/notes', { notes: [], totalNotes: 0 });

    await matterNotes.listNotes(LAW_FIRM_ID, MATTER_ID, {
      noteType: 'all', timeFilter: 'all',
    });

    // 'all' is a UI word with no matching row anywhere. Sent, the server filters
    // on the literal string and answers with nothing, so selecting "All types"
    // empties a panel that had notes in it a moment earlier.
    const query = paramsOf(api.calls('GET')[0].url);
    expect(query.get('noteType')).toBeNull();
    expect(query.get('timeFilter')).toBeNull();
  });

  it('sends a real selection under each of those keys', async () => {
    api.get('/notes', { notes: [], totalNotes: 0 });

    await matterNotes.listNotes(LAW_FIRM_ID, MATTER_ID, {
      noteType: 'phone_call', timeFilter: 'with-time',
    });

    // The mirror of the case above. Suppressing these along with the sentinel
    // leaves the panel showing every note whatever tab is selected.
    const query = paramsOf(api.calls('GET')[0].url);
    expect(query.get('noteType')).toBe('phone_call');
    expect(query.get('timeFilter')).toBe('with-time');
  });

  it('sends the page window and the remaining filters under their own names', async () => {
    api.get('/notes', { notes: [], totalNotes: 0 });

    await matterNotes.listNotes(LAW_FIRM_ID, MATTER_ID, {
      page: 3, limit: 25, tag: 'discovery', authorId: 'user-8',
    });

    // `tag` and `authorId` sit next to each other on the filter bar and are both
    // opaque strings, so a swap returns a plausible non-empty list of the wrong
    // notes rather than an error.
    const query = paramsOf(api.calls('GET')[0].url);
    expect(query.get('page')).toBe('3');
    expect(query.get('limit')).toBe('25');
    expect(query.get('tag')).toBe('discovery');
    expect(query.get('authorId')).toBe('user-8');
  });

  it('sends the note-date bounds as the day-only strings the column stores', async () => {
    api.get('/notes', { notes: [], totalNotes: 0 });

    await matterNotes.listNotes(LAW_FIRM_ID, MATTER_ID, {
      dateFrom: '2026-01-01', dateTo: '2026-01-31',
    });

    // `note_date` is a Postgres `date`, compared as a day. Widening either bound
    // into a timestamp shifts the window by the user's offset from UTC, so a
    // note written on the 31st drops out of a range that names the 31st.
    const query = paramsOf(api.calls('GET')[0].url);
    expect(query.get('dateFrom')).toBe('2026-01-01');
    expect(query.get('dateTo')).toBe('2026-01-31');
  });

  it('trims a search term and omits one that is only whitespace', async () => {
    api.get('/notes', { notes: [], totalNotes: 0 });

    await matterNotes.listNotes(LAW_FIRM_ID, MATTER_ID, { search: '  opposing counsel  ' });
    await matterNotes.listNotes(LAW_FIRM_ID, MATTER_ID, { search: '   ' });

    // A whitespace-only search comes from a user clearing the box. Sent, it
    // matches nothing and the panel looks empty rather than restored.
    const [searched, cleared] = api.calls('GET').map((call) => paramsOf(call.url));
    expect(searched.get('search')).toBe('opposing counsel');
    expect(cleared.get('search')).toBeNull();
  });

  it('sends no query at all when the panel asked for the default page', async () => {
    api.get('/notes', { notes: [], totalNotes: 0 });

    await matterNotes.listNotes(LAW_FIRM_ID, MATTER_ID);

    // Nothing is interpolated unguarded, so an unset filter never reaches the
    // server as the literal text `undefined`, which would pass a "was it sent"
    // check and match no row.
    expect(api.calls('GET')[0].url).not.toContain('?');
    expect(api.calls('GET')[0].url).not.toContain('undefined');
  });

  it('asks the server which page a deep-linked note falls on', async () => {
    api.get('/notes', { notes: [], totalNotes: 0, resolvedPage: 4 });

    const result = await matterNotes.listNotes(LAW_FIRM_ID, MATTER_ID, {
      jumpToNoteId: NOTE_ID, page: 1,
    });

    // A notification links straight to a note that may be on any page under the
    // current filters. Only the server can say which, and dropping either the
    // request parameter or the answer scrolls the panel to a note that is not
    // on the page it loaded.
    expect(paramsOf(api.calls('GET')[0].url).get('jumpToNoteId')).toBe(NOTE_ID);
    expect(result.resolvedPage).toBe(4);
  });
});

describe('what a notes read returns', () => {
  it('unwraps the notes, the total and the tag list', async () => {
    api.get('/notes', {
      notes: [{ id: NOTE_ID, content: 'Called opposing counsel.' }],
      totalNotes: 42,
      tags: ['discovery', 'urgent'],
    });

    const result = await matterNotes.listNotes(LAW_FIRM_ID, MATTER_ID);

    // The envelope keys are the contract. Reading the response as the array
    // itself shows an empty panel on a request that succeeded.
    expect(result.notes).toHaveLength(1);
    expect(result.totalNotes).toBe(42);
    expect(result.tags).toEqual(['discovery', 'urgent']);
  });

  it('reports the time-tab counts the server sent', async () => {
    api.get('/notes', {
      notes: [], totalNotes: 0,
      counts: { all: 12, withTime: 5, withoutTime: 7 },
    });

    const { counts } = await matterNotes.listNotes(LAW_FIRM_ID, MATTER_ID);

    // These count over every filter EXCEPT the time filter, so selecting one tab
    // cannot zero the other two. Taking them from the page instead of the
    // envelope makes each tab report only what is currently on screen.
    expect(counts).toEqual({ all: 12, withTime: 5, withoutTime: 7 });
  });

  it('substitutes zeroes for counts the server did not send', async () => {
    api.get('/notes', { notes: [], totalNotes: 0 });

    const { counts, tags, resolvedPage } = await matterNotes.listNotes(LAW_FIRM_ID, MATTER_ID);

    // The tabs render these directly and the tag dropdown maps over `tags`.
    // Undefined shows "NaN" beside a tab name and throws in the dropdown.
    expect(counts).toEqual({ all: 0, withTime: 0, withoutTime: 0 });
    expect(tags).toEqual([]);
    expect(resolvedPage).toBeNull();
  });

  it('discards a notes field that is not an array', async () => {
    api.get('/notes', { notes: { id: NOTE_ID }, totalNotes: 1 });

    const { notes } = await matterNotes.listNotes(LAW_FIRM_ID, MATTER_ID);

    // The panel maps over this. A single object where a list belongs throws
    // during render rather than showing one note.
    expect(notes).toEqual([]);
  });

  it('keeps a note time summary in the units the server sent it', async () => {
    api.get('/notes', {
      notes: [{
        id: NOTE_ID,
        content: 'Drafted motion.',
        noteDate: '2026-01-15',
        time: {
          entries: [{ id: 'te-1', hours: 1.5, entryDate: '2026-01-15', billable: true, editable: false }],
          totalHours: 1.5, billedHours: 0, status: 'unbilled', locked: true,
        },
      }],
      totalNotes: 1,
    });

    const { notes } = await matterNotes.listNotes(LAW_FIRM_ID, MATTER_ID);

    // `noteDate` is a day-only `date` column and arrives as a raw 'YYYY-MM-DD'
    // string. Parsing it into a Date here would shift it a day for anyone west
    // of UTC, and the note would then be billed under the wrong day.
    expect(notes[0].noteDate).toBe('2026-01-15');
    expect(notes[0].time?.entries[0].entryDate).toBe('2026-01-15');
    expect(notes[0].time?.locked).toBe(true);
    expect(notes[0].time?.entries[0].editable).toBe(false);
  });

  it('returns a note detail envelope as the server framed it', async () => {
    api.get(`/notes/${NOTE_ID}`, { note: { id: NOTE_ID, content: 'Called opposing counsel.' } });

    const { note } = await matterNotes.getNoteDetail(LAW_FIRM_ID, MATTER_ID, NOTE_ID);

    expect(api.calls('GET')[0].pathname).toBe(`/api/lawfirms/firm-1/matters/matter-9/notes/${NOTE_ID}`);
    expect(note.id).toBe(NOTE_ID);
  });
});

describe('what a note write sends', () => {
  it('defaults an unstated note type rather than leaving the column unset', async () => {
    api.post('/notes', { note: { id: NOTE_ID } });

    await matterNotes.addNote(LAW_FIRM_ID, MATTER_ID, noteBody());

    // The composer's type selector starts unset. An absent `noteType` leaves the
    // note out of every type filter, so it is invisible on a panel with any tab
    // other than "All" selected.
    expect(bodyOf(api.calls('POST')[0]).noteType).toBe('general');
  });

  it('keeps a chosen note type instead of overwriting it with the default', async () => {
    api.post('/notes', { note: { id: NOTE_ID } });

    await matterNotes.addNote(LAW_FIRM_ID, MATTER_ID, noteBody({ noteType: 'phone_call' }));

    expect(bodyOf(api.calls('POST')[0]).noteType).toBe('phone_call');
  });

  it('sends the work date the author chose as a day-only string', async () => {
    api.post('/notes', { note: { id: NOTE_ID } });

    await matterNotes.addNote(LAW_FIRM_ID, MATTER_ID, noteBody({
      noteDate: '2026-01-15', subject: 'Call with counsel', mentions: ['user-8'],
    }));

    // `noteDate` is when the work happened and is separate from `createdAt`.
    // Serializing it as a timestamp lands it on the previous day for anyone west
    // of UTC, which is how time gets billed to the wrong date.
    const body = bodyOf(api.calls('POST')[0]);
    expect(body.noteDate).toBe('2026-01-15');
    expect(body.subject).toBe('Call with counsel');
    expect(body.mentions).toEqual(['user-8']);
  });

  it('omits an empty time-entry list rather than sending one', async () => {
    api.post('/notes', { note: { id: NOTE_ID } });

    await matterNotes.addNote(LAW_FIRM_ID, MATTER_ID, noteBody({ timeEntries: [] }));

    // Plain Save sends none. An empty array is a different request from an
    // absent key on a route that treats the key as "replace the entries", so
    // sending it would clear time the note already carries.
    expect('timeEntries' in bodyOf(api.calls('POST')[0])).toBe(false);
  });

  it('sends the time entries the composer collected, untouched', async () => {
    api.post('/notes', { note: { id: NOTE_ID } });

    await matterNotes.addNote(LAW_FIRM_ID, MATTER_ID, noteBody({
      timeEntries: [
        { timeSpent: 1.5, timeEntryDate: '2026-01-15', isBillable: true, activityName: 'Call' },
        { timeSpent: 0.25, isBillable: false },
      ],
    }));

    // Save & Add Time sends one entry, the panel can send several, and each is
    // billable hours against a matter. Reshaping or collapsing them here is the
    // difference between an invoice that is right and one that is not.
    const entries = bodyOf(api.calls('POST')[0]).timeEntries as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(2);
    expect(entries[0].timeSpent).toBe(1.5);
    expect(entries[0].timeEntryDate).toBe('2026-01-15');
    expect(entries[1].isBillable).toBe(false);
  });

  it('sends both the plain text and the html on an edit', async () => {
    api.put(`/notes/${NOTE_ID}`, { note: { id: NOTE_ID } });

    await matterNotes.updateNote(LAW_FIRM_ID, MATTER_ID, NOTE_ID, noteBody({
      content: 'Revised.', contentHtml: '<p>Revised.</p>', subject: 'Revised call',
    }));

    // The html is what the panel renders and the plain text is what full-text
    // search indexes. Sending only one leaves the note either unsearchable or
    // unformatted, and the version history records the gap permanently.
    const call = api.calls('PUT')[0];
    expect(call.pathname).toBe(`/api/lawfirms/firm-1/matters/matter-9/notes/${NOTE_ID}`);
    expect(bodyOf(call).content).toBe('Revised.');
    expect(bodyOf(call).contentHtml).toBe('<p>Revised.</p>');
  });

  it('does not resend the note type on an edit that did not change it', async () => {
    api.put(`/notes/${NOTE_ID}`, { note: { id: NOTE_ID } });

    await matterNotes.updateNote(LAW_FIRM_ID, MATTER_ID, NOTE_ID, noteBody());

    // Unlike the create, the update applies no default. Adding one here would
    // rewrite every edited note to 'general', silently retyping notes whose
    // author only fixed a typo.
    expect('noteType' in bodyOf(api.calls('PUT')[0])).toBe(false);
  });
});

describe('retracting is not deleting', () => {
  it('carries the reason on the retraction and answers with the note', async () => {
    api.delete(`/notes/${NOTE_ID}`, {
      message: 'ok',
      note: { id: NOTE_ID, retractedAt: '2026-01-16T10:00:00.000Z', retractionReason: 'Wrong matter' },
    });

    const result = await matterNotes.retractNote(LAW_FIRM_ID, MATTER_ID, NOTE_ID, 'Wrong matter');

    // The verb is DELETE but the note and its time entries survive, which is why
    // the request carries a reason and the response carries the note back. A
    // retraction that sends no body loses the audit trail the retraction exists
    // to create.
    const call = api.calls('DELETE')[0];
    expect(call.pathname).toBe(`/api/lawfirms/firm-1/matters/matter-9/notes/${NOTE_ID}`);
    expect(bodyOf(call).reason).toBe('Wrong matter');
    expect(result.note.retractedAt).toBe('2026-01-16T10:00:00.000Z');
  });

  it('pins and unpins through the pin sub-route, not through an edit', async () => {
    api.put(`/notes/${NOTE_ID}/pin`, { note: { id: NOTE_ID, pinnedAt: '2026-01-16T10:00:00.000Z' } });

    await matterNotes.setNotePinned(LAW_FIRM_ID, MATTER_ID, NOTE_ID, true);

    // Pinning is not an edit: it must not create a version or stamp the note as
    // edited by whoever pinned it. Routing it through the note url would do both.
    const call = api.calls('PUT')[0];
    expect(call.pathname).toBe(`/api/lawfirms/firm-1/matters/matter-9/notes/${NOTE_ID}/pin`);
    expect(bodyOf(call).pinned).toBe(true);
  });

  it('sends an unpin as an explicit false rather than omitting the flag', async () => {
    api.put(`/notes/${NOTE_ID}/pin`, { note: { id: NOTE_ID, pinnedAt: null } });

    await matterNotes.setNotePinned(LAW_FIRM_ID, MATTER_ID, NOTE_ID, false);

    // An omitted flag on a toggle route leaves the note pinned while the button
    // shows it unpinned, and the state flips back on the next load.
    const body = bodyOf(api.calls('PUT')[0]);
    expect('pinned' in body).toBe(true);
    expect(body.pinned).toBe(false);
  });

  it('reads version history from its own sub-route', async () => {
    api.get(`/notes/${NOTE_ID}/versions`, {
      versions: [{ id: 'v1', version: 1, content: 'First draft' }],
    });

    const { versions } = await matterNotes.listNoteVersions(LAW_FIRM_ID, MATTER_ID, NOTE_ID);

    expect(api.calls('GET')[0].pathname)
      .toBe(`/api/lawfirms/firm-1/matters/matter-9/notes/${NOTE_ID}/versions`);
    expect(versions[0].version).toBe(1);
  });
});

describe('time entries hang off the note, not off the matter', () => {
  it('adds time through the note time sub-route', async () => {
    api.post(`/notes/${NOTE_ID}/time`, { note: { id: NOTE_ID } });

    await matterNotes.addNoteTimeEntry(LAW_FIRM_ID, MATTER_ID, NOTE_ID, {
      timeSpent: 2, timeEntryDate: '2026-01-15', isBillable: true, activityName: 'Drafting',
    });

    // The matter also has a standalone time-entry route. Time added there is not
    // attached to the note, so the note shows no time while the matter bills for
    // it, and the two can never be reconciled afterwards.
    const call = api.calls('POST')[0];
    expect(call.pathname).toBe(`/api/lawfirms/firm-1/matters/matter-9/notes/${NOTE_ID}/time`);
    expect(bodyOf(call).timeSpent).toBe(2);
    expect(bodyOf(call).timeEntryDate).toBe('2026-01-15');
    expect(bodyOf(call).isBillable).toBe(true);
  });

  it('addresses one entry by its own id when editing or removing it', async () => {
    api.put(`/notes/${NOTE_ID}/time/te-3`, { note: { id: NOTE_ID } });
    api.delete(`/notes/${NOTE_ID}/time/te-3`, { note: { id: NOTE_ID } });

    await matterNotes.updateNoteTimeEntry(LAW_FIRM_ID, MATTER_ID, NOTE_ID, 'te-3', { timeSpent: 0.75 });
    await matterNotes.removeNoteTimeEntry(LAW_FIRM_ID, MATTER_ID, NOTE_ID, 'te-3');

    // A note can carry several entries. Addressing the collection instead of the
    // member edits or deletes whichever one the server picks first, and the row
    // the user clicked stays as it was.
    expect(api.calls('PUT')[0].pathname).toMatch(/\/notes\/note-1\/time\/te-3$/);
    expect(api.calls('DELETE')[0].pathname).toMatch(/\/notes\/note-1\/time\/te-3$/);
    expect(bodyOf(api.calls('PUT')[0]).timeSpent).toBe(0.75);
  });

  it('escapes a time-entry id so it cannot address a different route', async () => {
    api.delete(`/time/${encodeURIComponent('te/3')}`, { note: { id: NOTE_ID } });

    await matterNotes.removeNoteTimeEntry(LAW_FIRM_ID, MATTER_ID, NOTE_ID, 'te/3');

    expect(api.calls('DELETE')[0].pathname)
      .toBe(`/api/lawfirms/firm-1/matters/matter-9/notes/${NOTE_ID}/time/${encodeURIComponent('te/3')}`);
  });
});

describe('replies hang off the note', () => {
  it('reads and writes replies on the note replies sub-route', async () => {
    api.get(`/notes/${NOTE_ID}/replies`, { replies: [{ id: 'reply-1', content: 'Noted.' }] });
    api.post(`/notes/${NOTE_ID}/replies`, { reply: { id: 'reply-2' } });

    const { replies } = await matterNotes.listNoteReplies(LAW_FIRM_ID, MATTER_ID, NOTE_ID);
    await matterNotes.addNoteReply(LAW_FIRM_ID, MATTER_ID, NOTE_ID, {
      content: 'Agreed.', contentHtml: '<p>Agreed.</p>', mentions: ['user-8'],
    });

    expect(replies[0].id).toBe('reply-1');
    expect(api.calls('POST')[0].pathname)
      .toBe(`/api/lawfirms/firm-1/matters/matter-9/notes/${NOTE_ID}/replies`);
    expect(bodyOf(api.calls('POST')[0]).mentions).toEqual(['user-8']);
  });

  it('omits the parent reply when the reply answers the note itself', async () => {
    api.post(`/notes/${NOTE_ID}/replies`, { reply: { id: 'reply-2' } });

    await matterNotes.addNoteReply(LAW_FIRM_ID, MATTER_ID, NOTE_ID, {
      content: 'Agreed.', parentReplyId: null,
    });

    // A top-level reply is stored with a null parent. Sending the null through
    // as a value the route validates as an id rejects the write; the thread view
    // and the notification fan-out both key off this field.
    expect('parentReplyId' in bodyOf(api.calls('POST')[0])).toBe(false);
  });

  it('names the reply being answered when the reply is nested', async () => {
    api.post(`/notes/${NOTE_ID}/replies`, { reply: { id: 'reply-3' } });

    await matterNotes.addNoteReply(LAW_FIRM_ID, MATTER_ID, NOTE_ID, {
      content: 'Following up.', parentReplyId: 'reply-1',
    });

    // The mirror of the case above: dropping this flattens every nested reply to
    // the top of the thread, and the conversation loses its order.
    expect(bodyOf(api.calls('POST')[0]).parentReplyId).toBe('reply-1');
  });

  it('edits and retracts a reply by the reply id, under its note', async () => {
    api.put(`/notes/${NOTE_ID}/replies/reply-1`, { reply: { id: 'reply-1' } });
    api.delete(`/notes/${NOTE_ID}/replies/reply-1`, { message: 'ok', reply: { id: 'reply-1' } });

    await matterNotes.updateNoteReply(LAW_FIRM_ID, MATTER_ID, NOTE_ID, 'reply-1', { content: 'Revised.' });
    await matterNotes.retractNoteReply(LAW_FIRM_ID, MATTER_ID, NOTE_ID, 'reply-1', 'Posted in error');

    // Two ids in one path, pointing at different tables. Addressing the reply
    // with the note id edits the note instead of the reply, which the panel
    // reports as a successful reply edit that did nothing visible.
    expect(api.calls('PUT')[0].pathname).toMatch(/\/notes\/note-1\/replies\/reply-1$/);
    expect(api.calls('DELETE')[0].pathname).toMatch(/\/notes\/note-1\/replies\/reply-1$/);
    expect(bodyOf(api.calls('DELETE')[0]).reason).toBe('Posted in error');
  });
});

describe('attachments are uploaded before the note that carries them', () => {
  const SESSION = 'https://storage.googleapis.com/upload/note-a';

  /** Answer the three legs of a direct upload for one note attachment. */
  function arrangeUpload(files: unknown[] = []) {
    api.post('/files/upload-init', {
      uploads: [{
        fileId: 'a1', name: 'brief.pdf', objectPath: 'notes/brief.pdf',
        uploadUrl: SESSION, contentType: 'application/pdf', declaredSize: 1,
      }],
    });
    xhr.onExact('PUT', SESSION, { status: 200 });
    api.post('/files/upload-finalize', { files, failures: [] });
  }

  it('names the parent by its own id field, and the note-attachments folder', async () => {
    arrangeUpload([{
      fileId: 'a1', name: 'brief.pdf', size: 10,
      contentType: 'application/pdf', signedUrl: 'https://x/a1', objectPath: 'notes/brief.pdf',
    }]);

    await taskNotes.uploadNoteAttachments(LAW_FIRM_ID, TASK_ID, [
      new File(['x'], 'brief.pdf', { type: 'application/pdf' }),
    ]);

    // The upload is firm-scoped, not parent-scoped, so the only thing telling
    // the server what this file belongs to is which id is set. A task upload
    // sending `matterId` attaches the file to nothing, and the note then links
    // a document the parent does not own.
    const init = api.callsTo('/files/upload-init')[0].body as any;
    expect(init.context).toBe('task');
    expect(init.taskId).toBe(TASK_ID);
    expect(init.matterId).toBeUndefined();
    expect(init.lawFirmId).toBe(LAW_FIRM_ID);
    // A real folder in the scope tree, so the browser can rename and move these
    // like anything else. It used to be a path segment with no folder behind it.
    expect(init.attachmentFolder).toBe('note-attachments');
  });

  it('names the parent field differently for each note parent', async () => {
    arrangeUpload([{ fileId: 'a1', objectPath: 'notes/brief.pdf' }]);
    const file = () => new File(['x'], 'brief.pdf', { type: 'application/pdf' });

    await matterNotes.uploadNoteAttachments(LAW_FIRM_ID, MATTER_ID, [file()]);
    await clientNotes.uploadNoteAttachments(LAW_FIRM_ID, CLIENT_ID, [file()]);

    // The second of the two factory arguments exists only for this. Sharing one
    // field name across the three instances would misfile every attachment on
    // two of the three panels.
    const [matterInit, clientInit] = api.callsTo('/files/upload-init').map((c) => c.body as any);
    expect(matterInit.matterId).toBe(MATTER_ID);
    expect(matterInit.context).toBe('matter');
    expect(clientInit.clientId).toBe(CLIENT_ID);
    expect(clientInit.context).toBe('client');
  });

  it('sends the bytes to storage, not through the API', async () => {
    // The multipart route this replaced held ten files at a hundred megabytes
    // each in the API container before the handler ran.
    arrangeUpload([{ fileId: 'a1', objectPath: 'notes/brief.pdf' }]);

    await matterNotes.uploadNoteAttachments(LAW_FIRM_ID, MATTER_ID, [
      new File(['x'], 'brief.pdf', { type: 'application/pdf' }),
    ]);

    expect(xhr.calls('PUT')[0].url).toBe(SESSION);
  });

  it('uploads the new files and merges them with the ones already stored', async () => {
    arrangeUpload([{
      fileId: 'new-1', name: 'brief.pdf', size: 10,
      contentType: 'application/pdf', signedUrl: 'https://x/new-1', objectPath: 'notes/brief.pdf',
    }]);
    api.post('/notes', { note: { id: NOTE_ID } });

    await matterNotes.addNote(LAW_FIRM_ID, MATTER_ID, noteBody({
      attachments: [
        { id: 'tmp-1', name: 'brief.pdf', size: 10, type: 'application/pdf', file: new File(['x'], 'brief.pdf') },
        { id: 'kept-1', name: 'order.pdf', size: 20, type: 'application/pdf', url: 'https://x/kept-1' },
      ],
    }));

    // An edit that adds one file to a note that already has one must send both.
    // Sending only the upload result drops the existing attachment from the
    // note; sending only the existing one loses the file just uploaded, which
    // stays in the bucket unreferenced.
    const note = api.calls('POST').find((c) => c.pathname.endsWith('/notes'))!;
    expect(api.callsTo('/files/upload-init')).toHaveLength(1);
    expect(note.pathname).toBe('/api/lawfirms/firm-1/matters/matter-9/notes');
    const attachments = bodyOf(note).attachments as Array<Record<string, unknown>>;
    expect(attachments.map((a) => a.id)).toEqual(['new-1', 'kept-1']);
    expect(attachments[1].url).toBe('https://x/kept-1');
  });

  it('issues no upload when every attachment is already stored', async () => {
    api.post('/notes', { note: { id: NOTE_ID } });

    await matterNotes.addNote(LAW_FIRM_ID, MATTER_ID, noteBody({
      attachments: [{ id: 'kept-1', name: 'order.pdf', size: 20, type: 'application/pdf', url: 'https://x/kept-1' }],
    }));

    // Re-uploading on every edit would duplicate the file in the bucket once per
    // save. The absence is only meaningful because the note write below proves
    // the method actually ran.
    expect(api.callsTo('/files/upload-init')).toEqual([]);
    expect(api.calls('POST')).toHaveLength(1);
    expect(api.calls('POST')[0].pathname).toBe('/api/lawfirms/firm-1/matters/matter-9/notes');
    expect((bodyOf(api.calls('POST')[0]).attachments as unknown[]).length).toBe(1);
  });

  it('omits the attachments key entirely when the note carries none', async () => {
    api.post('/notes', { note: { id: NOTE_ID } });

    await matterNotes.addNote(LAW_FIRM_ID, MATTER_ID, noteBody({ attachments: [] }));

    // An empty array on the update route means "remove every attachment", which
    // is not what a note saved without touching its files is asking for.
    expect(api.calls('POST')).toHaveLength(1);
    expect('attachments' in bodyOf(api.calls('POST')[0])).toBe(false);
  });

  it('does not write the note when its attachment upload failed', async () => {
    // Refused at init, before any byte moves: an over-quota firm or a forbidden
    // type never reaches the storage leg.
    api.post('/files/upload-init', { status: 500, body: { error: 'Storage unavailable' } });
    api.post('/notes', { note: { id: NOTE_ID } });

    const error = await matterNotes.addNote(LAW_FIRM_ID, MATTER_ID, noteBody({
      attachments: [{ id: 'tmp-1', name: 'brief.pdf', size: 10, type: 'application/pdf', file: new File(['x'], 'brief.pdf') }],
    })).catch((e) => e);

    // Saving the note anyway posts it without the file the author attached, and
    // the composer closes, so there is nothing left on screen to retry from.
    expect(api.callsTo('/files/upload-init')).toHaveLength(1);
    expect(error).toBeDefined();
    expect(xhr.calls()).toEqual([]);
    expect(api.callsTo('/matters/matter-9/notes')).toHaveLength(0);
  });
});

describe('a refusal is not an empty panel', () => {
  it('throws a forbidden ApiError from the list rather than resolving to no notes', async () => {
    api.get('/notes', { status: 403, body: { error: 'Forbidden', code: 'FORBIDDEN' } });

    const error = await matterNotes.listNotes(LAW_FIRM_ID, MATTER_ID).catch((e) => e);

    // A matter the member may not read notes on, and a matter with no notes yet,
    // render the same empty panel. The request has to have gone out before the
    // outcome means anything.
    expect(api.callsTo('/matters/matter-9/notes')).toHaveLength(1);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).isForbidden).toBe(true);
    expect((error as ApiError).status).toBe(403);
  });

  it('reads a refusal from the code alone when the status does not say so', async () => {
    api.get(`/notes/${NOTE_ID}`, { status: 400, body: { error: 'Denied', code: 'FORBIDDEN' } });

    const error = await matterNotes.getNoteDetail(LAW_FIRM_ID, MATTER_ID, NOTE_ID).catch((e) => e);

    // Keying the locked state off the status alone shows a coded 400 as an error
    // banner telling the user to retry something that will never succeed.
    expect(api.callsTo(`/notes/${NOTE_ID}`)).toHaveLength(1);
    expect((error as ApiError).isForbidden).toBe(true);
  });

  it('does not read a validation failure as a refusal', async () => {
    api.post('/notes', { status: 400, body: { error: 'Content is required', code: 'VALIDATION_ERROR' } });

    const error = await matterNotes.addNote(LAW_FIRM_ID, MATTER_ID, noteBody({ content: '' })).catch((e) => e);

    // A rejected note body is the author's to fix. Presenting it as a permission
    // lock hides the actual reason the note would not save.
    expect(api.calls('POST')).toHaveLength(1);
    expect((error as ApiError).isForbidden).toBe(false);
    expect((error as ApiError).message).toBe('Content is required');
  });

  it('throws on a refused write instead of returning the error body as a note', async () => {
    api.post('/notes', { status: 403, body: { error: 'Forbidden', code: 'FORBIDDEN' } });

    const error = await matterNotes.addNote(LAW_FIRM_ID, MATTER_ID, noteBody()).catch((e) => e);

    // Without the response check the method hands the parsed refusal back as
    // `{ note }`, so the composer closes on a note that was never written.
    expect(api.calls('POST')).toHaveLength(1);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).isForbidden).toBe(true);
  });

  it('throws when a retraction is refused', async () => {
    api.delete(`/notes/${NOTE_ID}`, { status: 403, body: { error: 'Forbidden', code: 'FORBIDDEN' } });

    const error = await matterNotes.retractNote(LAW_FIRM_ID, MATTER_ID, NOTE_ID, 'Wrong matter').catch((e) => e);

    // Reporting a refused retraction as done leaves a note the author believes
    // is withdrawn visible to the whole firm.
    expect(api.calls('DELETE')).toHaveLength(1);
    expect((error as ApiError).isForbidden).toBe(true);
  });

  it('throws on every refused note action rather than reporting it done', async () => {
    api.put(`/notes/${NOTE_ID}`, { status: 403, body: { error: 'Forbidden', code: 'FORBIDDEN' } });
    api.put(`/notes/${NOTE_ID}/pin`, { status: 403, body: { error: 'Forbidden', code: 'FORBIDDEN' } });
    api.get(`/notes/${NOTE_ID}/versions`, { status: 403, body: { error: 'Forbidden', code: 'FORBIDDEN' } });
    api.delete(`/notes/${NOTE_ID}/time/te-3`, { status: 403, body: { error: 'Forbidden', code: 'FORBIDDEN' } });
    api.put(`/notes/${NOTE_ID}/replies/reply-1`, { status: 403, body: { error: 'Forbidden', code: 'FORBIDDEN' } });
    api.delete(`/notes/${NOTE_ID}/replies/reply-1`, { status: 403, body: { error: 'Forbidden', code: 'FORBIDDEN' } });

    const failures = await Promise.all([
      matterNotes.updateNote(LAW_FIRM_ID, MATTER_ID, NOTE_ID, noteBody()).catch((e) => e),
      matterNotes.setNotePinned(LAW_FIRM_ID, MATTER_ID, NOTE_ID, true).catch((e) => e),
      matterNotes.listNoteVersions(LAW_FIRM_ID, MATTER_ID, NOTE_ID).catch((e) => e),
      matterNotes.removeNoteTimeEntry(LAW_FIRM_ID, MATTER_ID, NOTE_ID, 'te-3').catch((e) => e),
      matterNotes.updateNoteReply(LAW_FIRM_ID, MATTER_ID, NOTE_ID, 'reply-1', { content: 'x' }).catch((e) => e),
      matterNotes.retractNoteReply(LAW_FIRM_ID, MATTER_ID, NOTE_ID, 'reply-1', 'error').catch((e) => e),
    ]);

    // Each of these returns its response body straight back to the caller, so
    // dropping the status check turns a refusal into a resolved value with the
    // expected key missing. The panel then closes the editor, clears the pin,
    // or empties the version list on an action the server never performed.
    expect(api.calls()).toHaveLength(6);
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(ApiError);
      expect((failure as ApiError).isForbidden).toBe(true);
    }
  });

  it('names the failed operation when the server sends no message', async () => {
    api.get('/notes', { status: 500, body: {} });
    api.post(`/notes/${NOTE_ID}/time`, { status: 500, body: {} });
    api.get(`/notes/${NOTE_ID}/replies`, { status: 500, body: {} });

    const listError = await matterNotes.listNotes(LAW_FIRM_ID, MATTER_ID).catch((e) => e);
    const timeError = await matterNotes
      .addNoteTimeEntry(LAW_FIRM_ID, MATTER_ID, NOTE_ID, { timeSpent: 1 }).catch((e) => e);
    const replyError = await matterNotes.listNoteReplies(LAW_FIRM_ID, MATTER_ID, NOTE_ID).catch((e) => e);

    // These fallbacks are the only text the user sees when a 500 arrives with an
    // empty body. Sharing one across the module says "failed to load notes"
    // after a failed attempt to add time, which sends the user looking in the
    // wrong place.
    expect((listError as ApiError).message).toBe('Failed to load notes');
    expect((timeError as ApiError).message).toBe('Failed to add time');
    expect((replyError as ApiError).message).toBe('Failed to load replies');
  });

  it('keeps the server message when the failure carries one', async () => {
    api.put(`/notes/${NOTE_ID}/time/te-3`, {
      status: 409,
      body: { error: 'This entry is on an invoice and can no longer be edited' },
    });

    const error = await matterNotes
      .updateNoteTimeEntry(LAW_FIRM_ID, MATTER_ID, NOTE_ID, 'te-3', { timeSpent: 3 })
      .catch((e) => e);

    // An entry locks once it reaches an invoice. Replacing that reason with the
    // generic fallback leaves the user retrying an edit that can never succeed.
    expect(api.calls('PUT')).toHaveLength(1);
    expect((error as ApiError).message).toBe('This entry is on an invoice and can no longer be edited');
  });
});
