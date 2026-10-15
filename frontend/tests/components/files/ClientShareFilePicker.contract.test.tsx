/**
 * Sharing files into a client's portal from the share picker, as a contract:
 * which key a selection is stored under, and how many requests a share makes.
 *
 * THE SELECTION KEY. `toggleSelect` stored a picked file under `item.id` while
 * the row read `selected.has(item.objectPath)` to draw its tick. A file's `id`
 * is its row in the files tree and never moves; its `objectPath` is where the
 * bytes currently live and changes on a rename. Those are two different
 * strings, so a picked file's checkbox never drew a tick and the row never
 * highlighted: the footer count was the only evidence anything had been picked.
 *
 * ONE REQUEST PER SCOPE. `handleConfirm` sent one PATCH per picked file.
 * `Promise.all` first, which opened the whole selection at once against an API
 * instance whose small Postgres pool is shared by every request on it; then four
 * at a time, which was bounded but still one round trip per file, so a
 * two-hundred-file share was two hundred of them. `PATCH
 * /files/bulk-client-visibility` takes the set, so a selection inside one scope
 * is ONE request however large it is.
 *
 * The per-file outcome did not go with it. The route reports each id it could
 * not apply in an `errors` map instead of refusing the batch, which is what lets
 * this dialog keep doing the useful thing on a partial run: stay open on exactly
 * what failed, tell the page behind it about what did go, and leave retrying as
 * one more click that cannot re-share a file already shared.
 *
 * `files.service` and the transport under it are real here, so the request body,
 * the `ApiError` handling and the sentence the user reads all execute. Only the
 * bulk endpoint is registered, so a return to a per-file loop fails as an
 * unmatched request rather than quietly passing. The matter/task lookups are
 * faked because they are not the subject.
 *
 * WHAT BREAKS THESE: reading the selection under `item.objectPath` anywhere in
 * the row leaves a ticked file blank; storing the object path instead of the row
 * id sends an address the route cannot resolve; one request per file (the call
 * count, and the unmatched `/client-visibility`); ignoring the `errors` map and
 * treating a 200 as "all of them shared"; closing the picker on a run that only
 * half worked; sending one request for a selection that spans two scopes, which
 * would name one scope's files under another scope's authorization.
 */
jest.unmock('@/services/files.service');
jest.unmock('@/services/requestDeduplicator');

const mockLookupMatters = jest.fn();
const mockLookupTasks = jest.fn();

jest.mock('@/services/matters.service', () => ({
  __esModule: true,
  default: { lookupMatters: (...args: unknown[]) => mockLookupMatters(...args) },
}));
jest.mock('@/services/tasks.service', () => ({
  __esModule: true,
  default: { lookupTasks: (...args: unknown[]) => mockLookupTasks(...args) },
}));

import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import ClientShareFilePicker from '@/components/filesComp/ClientShareFilePicker';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installApiMock, type ApiMock, type RecordedCall } from '../../support/apiMock';
import { holdResponse } from '../../support/deferred';

const LAW_FIRM_ID = 'law-firm-1';
const CLIENT_ID = 'client-1';
const MATTER_ID = 'matter-1';
const LIST_FOLDER = '/files/list-folder';
const BULK_CLIENT_VISIBILITY = '/files/bulk-client-visibility';
const PICKED = 12;

let api: ApiMock;
let onShared: jest.Mock;
let onClose: jest.Mock;

/**
 * `id` and `objectPath` are equal here, which keeps the bulk-share fixtures
 * indifferent to which of the two the picker selects by. Production values
 * differ (`id` is stable across a rename, `objectPath` is where the bytes are);
 * the selection-key cases below use `SELECTION_FILES`, where they do.
 */
function makeFiles(count: number, prefix = `client/${CLIENT_ID}`) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}/doc-${i}.pdf`,
    objectPath: `${prefix}/doc-${i}.pdf`,
    name: `doc-${i}.pdf`,
    isFolder: false,
    size: 1024,
    clientVisible: false,
  }));
}

/** The route's own answer, built from the ids it could not apply. */
function bulkAnswer(call: RecordedCall, doomed: Set<string> = new Set()) {
  const { fileIds, clientVisible } = call.body as { fileIds: string[]; clientVisible: boolean };
  const failed = fileIds.filter((id) => doomed.has(id));
  return {
    message: 'Bulk visibility update completed',
    requested: fileIds.length,
    updated: fileIds.length - failed.length,
    failed,
    errors: Object.fromEntries(failed.map((id) => [id, 'File not found'])),
    clientVisible,
  };
}

/** Every id sent across every bulk PATCH this run made. */
const sharedFileIds = () =>
  api.calls('PATCH').flatMap((call) => (call.body as { fileIds: string[] }).fileIds);

/** Whether each file row currently draws its tick mark, in row order. */
const rowsShowingATick = () =>
  screen.getAllByTitle('Share this file').map((box) => box.querySelector('svg') !== null);

function renderPicker() {
  return renderWithProviders(
    <ClientShareFilePicker
      open
      onClose={onClose}
      lawFirmId={LAW_FIRM_ID}
      clientId={CLIENT_ID}
      onShared={onShared}
    />,
  );
}

/** Tick every file currently listed. */
async function tickEveryFile(user: ReturnType<typeof userEvent.setup>, count: number) {
  await waitFor(() => expect(screen.getAllByTitle('Share this file')).toHaveLength(count));
  for (const box of screen.getAllByTitle('Share this file')) await user.click(box);
}

/** Open the client's own files tab, tick every file, and confirm the share. */
async function pickEveryFileAndConfirm(user: ReturnType<typeof userEvent.setup>, count: number) {
  await user.click(await screen.findByRole('button', { name: /Client files/ }));
  await tickEveryFile(user, count);
  await screen.findByText(`${count} items selected`);
  await user.click(screen.getByRole('button', { name: 'Make visible to client' }));
}

beforeEach(() => {
  onShared = jest.fn();
  onClose = jest.fn();
  mockLookupMatters.mockResolvedValue({ items: [], hasMore: false });
  mockLookupTasks.mockResolvedValue({ items: [], hasMore: false });
  api = installApiMock();
});

afterEach(() => {
  mockLookupMatters.mockReset();
  mockLookupTasks.mockReset();
  api.restore();
});

describe('ClientShareFilePicker bulk share', () => {
  it('shares a twelve-file selection in one request, not twelve', async () => {
    const user = userEvent.setup();
    const files = makeFiles(PICKED);
    api.get(LIST_FOLDER, { files });
    api.patch(BULK_CLIENT_VISIBILITY, (call: RecordedCall) => bulkAnswer(call));

    renderPicker();
    await pickEveryFileAndConfirm(user, PICKED);

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // The whole point. A per-file loop reads 12 here, and its
    // `/client-visibility` requests are not registered at all, so it cannot pass
    // by accident.
    expect(api.calls('PATCH')).toHaveLength(1);
    expect(new Set(sharedFileIds())).toEqual(new Set(files.map((f) => f.id)));
    expect((api.calls('PATCH')[0].body as { clientId: string }).clientId).toBe(CLIENT_ID);

    // A clean run still closes the picker and tells the page behind it to reload.
    expect(onShared).toHaveBeenCalledTimes(1);
  });

  it('keeps the picker open on a partial run, names both counts, and still refreshes what did share', async () => {
    const user = userEvent.setup();
    const files = makeFiles(PICKED);
    api.get(LIST_FOLDER, { files });

    const doomed = new Set([files[2].id, files[5].id]);
    api.patch(BULK_CLIENT_VISIBILITY, (call: RecordedCall) => bulkAnswer(call, doomed));

    renderPicker();
    await pickEveryFileAndConfirm(user, PICKED);

    await screen.findByText(
      `${PICKED - doomed.size} of ${PICKED} files shared. ${doomed.size} could not be shared and stayed selected.`,
    );
    // Still one request: a partial answer is the route reporting per file, not
    // the dialog giving up part way through a loop.
    expect(api.calls('PATCH')).toHaveLength(1);
    expect(new Set(sharedFileIds())).toEqual(new Set(files.map((f) => f.id)));

    // The ten that went through really are visible to the client now, so the
    // page behind the picker has to be told even though the run was not clean.
    expect(onShared).toHaveBeenCalledTimes(1);
    // And the picker stays open on the two that failed, so retrying is one more
    // click and cannot re-share a file that already went.
    expect(onClose).not.toHaveBeenCalled();
    await screen.findByText(`${doomed.size} items selected`);
  });

  it('says so plainly when nothing could be shared, and does not claim a refresh', async () => {
    const user = userEvent.setup();
    const files = makeFiles(3);
    api.get(LIST_FOLDER, { files });
    api.patch(BULK_CLIENT_VISIBILITY, { status: 403, body: { error: 'Forbidden' } });

    renderPicker();
    await pickEveryFileAndConfirm(user, 3);

    await screen.findByText('None of the 3 files could be shared.');
    expect(api.calls('PATCH')).toHaveLength(1);
    // Nothing changed, so nothing behind the picker needs reloading and the
    // selection is left exactly as the user built it.
    expect(onShared).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('3 items selected')).toBeInTheDocument();
  });

  // A selection survives a tab switch, so it can name files in a matter AND in
  // the client's own area at once. Each request carries ONE scope, because the
  // scope is what the server authorizes the whole batch against; sending them
  // together would ask for a matter's files under the client area's permission.
  it('sends one request per scope when the selection spans two of them', async () => {
    const user = userEvent.setup();
    const clientFiles = makeFiles(2);
    const matterFiles = makeFiles(3, `matter/${MATTER_ID}`);
    mockLookupMatters.mockResolvedValue({ items: [{ id: MATTER_ID, label: 'Smith v. Jones' }], hasMore: false });
    api.get(LIST_FOLDER, (call: RecordedCall) => ({
      files: call.query.matterId?.[0] === MATTER_ID ? matterFiles : clientFiles,
    }));
    api.patch(BULK_CLIENT_VISIBILITY, (call: RecordedCall) => bulkAnswer(call));

    renderPicker();

    await user.click(await screen.findByText('Smith v. Jones'));
    await tickEveryFile(user, matterFiles.length);
    await user.click(screen.getByRole('button', { name: /Client files/ }));
    await tickEveryFile(user, clientFiles.length);
    await screen.findByText('5 items selected');
    await user.click(screen.getByRole('button', { name: 'Make visible to client' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.calls('PATCH')).toHaveLength(2);
    expect(new Set(sharedFileIds())).toEqual(
      new Set([...matterFiles, ...clientFiles].map((f) => f.id)),
    );

    const bodies = api.calls('PATCH').map((call) => call.body as { matterId?: string; clientId?: string; fileIds: string[] });
    const matterCall = bodies.find((b) => b.matterId === MATTER_ID);
    const clientCall = bodies.find((b) => b.clientId === CLIENT_ID);
    expect(new Set(matterCall?.fileIds)).toEqual(new Set(matterFiles.map((f) => f.id)));
    expect(new Set(clientCall?.fileIds)).toEqual(new Set(clientFiles.map((f) => f.id)));
    expect(onShared).toHaveBeenCalledTimes(1);
  });
});

describe('ClientShareFilePicker selection key', () => {
  /**
   * Two files whose row id and storage path disagree, the way they do after any
   * rename. Sharing addresses the row; the object path is opaque.
   */
  const SELECTION_FILES = [
    {
      id: 'file-row-a',
      objectPath: `firms/${LAW_FIRM_ID}/client/${CLIENT_ID}/uploaded-2024-03-11.pdf`,
      name: 'Deposition summary.pdf',
      isFolder: false,
      size: 2048,
      clientVisible: false,
    },
    {
      id: 'file-row-b',
      objectPath: `firms/${LAW_FIRM_ID}/client/${CLIENT_ID}/uploaded-2024-04-02.pdf`,
      name: 'Retainer agreement.pdf',
      isFolder: false,
      size: 4096,
      clientVisible: false,
    },
  ];

  beforeEach(() => {
    api.get(LIST_FOLDER, { files: SELECTION_FILES });
    api.patch(BULK_CLIENT_VISIBILITY, (call: RecordedCall) => bulkAnswer(call));
  });

  /** Open the client's own files tab and wait for both rows. */
  async function openClientFiles(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: /Client files/ }));
    await waitFor(() =>
      expect(screen.getAllByTitle('Share this file')).toHaveLength(SELECTION_FILES.length));
  }

  it('ticks the row it picked, counts one, and shares that same file', async () => {
    const user = userEvent.setup();
    renderPicker();
    await openClientFiles(user);
    expect(rowsShowingATick()).toEqual([false, false]);

    await user.click(screen.getAllByTitle('Share this file')[0]);

    // The row the user clicked is the row that shows a tick. Reading the
    // selection under the object path left this [false, false].
    expect(rowsShowingATick()).toEqual([true, false]);
    await screen.findByText('1 item selected');

    await user.click(screen.getByRole('button', { name: 'Make visible to client' }));

    // The tick, the count and the request all name the same file, addressed by
    // its row id rather than by where its bytes happen to sit.
    await waitFor(() => expect(api.calls('PATCH')).toHaveLength(1));
    expect(sharedFileIds()).toEqual([SELECTION_FILES[0].id]);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onShared).toHaveBeenCalledTimes(1);
  });

  it('unticks the row on a second click and drops it from the share', async () => {
    const user = userEvent.setup();
    renderPicker();
    await openClientFiles(user);

    const boxes = () => screen.getAllByTitle('Share this file');
    await user.click(boxes()[0]);
    await user.click(boxes()[1]);
    expect(rowsShowingATick()).toEqual([true, true]);

    // Untick the first. Storing and reading under different keys made this
    // unobservable: the count fell but no row ever changed.
    await user.click(boxes()[0]);
    expect(rowsShowingATick()).toEqual([false, true]);
    await screen.findByText('1 item selected');

    await user.click(screen.getByRole('button', { name: 'Make visible to client' }));

    await waitFor(() => expect(api.calls('PATCH')).toHaveLength(1));
    expect(sharedFileIds()).toEqual([SELECTION_FILES[1].id]);
  });
});

describe('ClientShareFilePicker Escape while the share is in flight', () => {
  // Red if: the picker stays dismissible (or Cancel stays enabled) while the
  // bulk PATCH is pending, so Escape closes it and a partial or refused share
  // reports into a closed dialog instead of leaving the failed files selected.
  it('keeps the picker open and Cancel disabled until the share settles', async () => {
    const user = userEvent.setup();
    const files = makeFiles(2);
    api.get(LIST_FOLDER, { files });
    const patch = holdResponse();
    api.patch(BULK_CLIENT_VISIBILITY, patch.handler);

    renderPicker();
    await pickEveryFileAndConfirm(user, 2);
    await patch.untilRequested();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await act(async () => patch.release(bulkAnswer(api.calls('PATCH')[0])));
    // The one close is the picker's own, after a clean run.
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onShared).toHaveBeenCalledTimes(1);
  });
});
