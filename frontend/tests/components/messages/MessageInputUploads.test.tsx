/**
 * Uploading attachments from the message composer: cancelling an upload, and
 * the files the composer holds but has not uploaded yet.
 *
 * The composer uploads the moment files are picked, and the whole composer is
 * locked while it does: the box, the paperclip and Send. Without a way out, a
 * wrong 90 MB pick holds the conversation hostage until every byte lands, and
 * then the files arrive as attachments the user never meant to send.
 *
 * What a cancel owes the user:
 *
 *   The transfer stops, and nothing is attached: finalize never runs.
 *   The composer comes back usable: draft text kept, no error shown (the user
 *   asked for this), and the picked files kept as not-uploaded chips.
 *   Picking the same file again replaces its pending chip and attaches it once.
 *   Leaving mid-upload (the composer unmounting, or the portal switching
 *   thread under a composer that stays mounted) is a cancel too, not an upload
 *   that finishes into a thread nobody is looking at.
 *   Once finalize has gone out the control is withdrawn, since a cancel there
 *   could only discard attachments the server already verified.
 *   A real failure is still reported.
 *
 * Files kept after a cancelled or failed upload stay in the composer as chips
 * marked "not uploaded" instead of vanishing, so the user never has to pick
 * them again. Send uploads them first (same bar, same Cancel) and only then
 * sends the message with them. A cancel or a failure at that point keeps them
 * pending and sends nothing; the typed text survives all of it.
 *
 * Pinned against the real services over a fake transport (`apiMock` for the
 * JSON legs, `xhrMock` for the storage PUTs), on both composers: the firm side
 * and the client portal.
 */
jest.unmock('@/services/messages.service');
jest.unmock('@/services/client-portal.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { installApiMock, sequence, type ApiMock } from '../../support/apiMock';
import { installXhrMock, type XhrMock } from '../../support/xhrMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import MessageInput from '@/components/messagesComp/MessageInput';

const FIRM = 'firm-1';
const FIRM_BASE = `/lawfirms/${FIRM}/messaging/attachments`;
const PORTAL_BASE = `/client-portal/lawfirm/${FIRM}/messages/attachments`;
const SESSIONS = [
  'https://storage.googleapis.com/upload/a',
  'https://storage.googleapis.com/upload/b',
  'https://storage.googleapis.com/upload/c',
];
const [SESSION_A, SESSION_B] = SESSIONS;

let api: ApiMock;
let xhr: XhrMock;

beforeEach(() => {
  api = installApiMock();
  xhr = installXhrMock();
  // An upload stopped short of finalize gives back what init opened, without
  // the composer waiting on it.
  api.post(`${FIRM_BASE}/upload-cancel`, { cancelled: 0 });
  api.post(`${PORTAL_BASE}/upload-cancel`, { cancelled: 0 });
  // Removing an uploaded chip discards its object, without the composer
  // waiting on it.
  api.post(`${FIRM_BASE}/discard`, { discarded: 1 });
  api.post(`${PORTAL_BASE}/discard`, { discarded: 1 });
});

afterEach(() => {
  api.restore();
  xhr.restore();
});

const pdf = (name: string) => new File([new Uint8Array(1000)], name, { type: 'application/pdf' });

const opened = (names: string[]) => ({
  uploads: names.map((name, i) => ({ uploadUrl: SESSIONS[i], objectPath: `msg/${name}`, fileName: name })),
  reservedBytes: 1000 * names.length,
});

const finalized = (names: string[]) => ({
  attachments: names.map((name, i) => ({
    id: String(i), name, url: `https://signed/${name}`, objectPath: `msg/${name}`,
    mimeType: 'application/pdf', size: 1000,
  })),
  failures: [],
});

/** The file names the latest init call asked to open, in order. */
const lastInitNames = (base: string) => {
  const calls = api.callsTo(`${base}/upload-init`);
  const body = calls[calls.length - 1].body as { files: Array<{ fileName: string }> };
  return body.files.map((f) => f.fileName);
};

function renderComposer(
  props: Omit<Partial<React.ComponentProps<typeof MessageInput>>, 'onSend'> & { onSend?: jest.Mock } = {},
) {
  const onSend = props.onSend ?? jest.fn();
  const view = renderWithProviders(
    <MessageInput lawFirmId={FIRM} clientId="client-1" {...props} onSend={onSend} />,
  );
  return { ...view, onSend };
}

function pick(container: HTMLElement, files: File[]) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
}

const cancelButton = () => screen.queryByRole('button', { name: 'Cancel upload' });
const sendButton = () => screen.getByRole('button', { name: /^Send$/ });
const notUploaded = () => screen.queryAllByText('Not uploaded yet');
const settle = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

/** Pick the files, cancel their upload while init is still out, and let it settle. */
async function pickThenCancel(container: HTMLElement, files: File[]) {
  pick(container, files);
  fireEvent.click(cancelButton()!);
  await settle(250);
}

describe.each([
  { surface: 'firm side', base: FIRM_BASE, props: {} },
  { surface: 'client portal', base: PORTAL_BASE, props: { isClient: true, conversationId: 'conv-1' } },
])('cancelling an upload ($surface)', ({ base, props }) => {
  it('puts the composer back as it was and sends nothing further', async () => {
    const user = userEvent.setup();
    // Init is slow, so the cancel lands while the batch is still being opened.
    api.post(`${base}/upload-init`, { delayMs: 200, body: opened(['a.pdf']) });
    xhr.onExact('PUT', SESSION_A, { status: 200 });
    api.post(`${base}/upload-finalize`, finalized(['a.pdf']));
    const { container } = renderComposer(props);

    await user.type(screen.getByRole('textbox'), 'Draft to keep');
    pick(container, [pdf('a.pdf')]);

    // Red on a composer that offers no way out of an upload.
    fireEvent.click(cancelButton()!);
    await settle(300);

    // Nothing moved after the cancel: no storage leg, and above all no
    // finalize, which is what would have turned the pick into an attachment.
    expect(xhr.calls()).toEqual([]);
    expect(api.callsTo(`${base}/upload-finalize`)).toEqual([]);
    // The pick stays as a not-uploaded chip. Red on a composer that forgets
    // the pick on cancel.
    expect(screen.getByText('a.pdf')).toBeInTheDocument();
    expect(notUploaded()).toHaveLength(1);
    // A cancel is not a failure, so nothing is reported.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // Back to the pre-upload composer, with the draft untouched and usable.
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('Draft to keep');
    expect(screen.getByRole('textbox')).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Attach files' })).not.toBeDisabled();
    expect(sendButton()).not.toBeDisabled();
  });

  it('attaches the file exactly once when it is picked again', async () => {
    api.post(`${base}/upload-init`, sequence(
      { delayMs: 200, body: opened(['a.pdf']) },
      { delayMs: 100, body: opened(['a.pdf']) },
    ));
    xhr.onExact('PUT', SESSION_A, { status: 200 });
    api.post(`${base}/upload-finalize`, finalized(['a.pdf']));
    const { container } = renderComposer(props);

    pick(container, [pdf('a.pdf')]);
    fireEvent.click(cancelButton()!);
    pick(container, [pdf('a.pdf')]);
    await settle(20);

    // The cancelled attempt has settled by now. Red if its cleanup reaches the
    // new upload: the composer would unlock and lose its cancel control while
    // the second batch is still in flight.
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(cancelButton()).toBeInTheDocument();

    expect(await screen.findByText('a.pdf')).toBeInTheDocument();
    await settle(300);

    // The cancelled attempt must not come back to life when its init answers
    // late: one finalize, one chip. Red if the first attempt's result lands too.
    expect(api.callsTo(`${base}/upload-finalize`)).toHaveLength(1);
    expect(screen.getAllByText('a.pdf')).toHaveLength(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('the cancel control', () => {
  it('stops the storage transfer it interrupts', async () => {
    api.post(`${FIRM_BASE}/upload-init`, opened(['a.pdf', 'b.pdf']));
    // The user cancels while the first file's bytes are on the wire.
    xhr.onExact('PUT', SESSION_A, () => {
      const control = cancelButton();
      if (control) fireEvent.click(control);
      return { status: 200 };
    });
    xhr.onExact('PUT', SESSION_B, { status: 200 });
    api.post(`${FIRM_BASE}/upload-finalize`, finalized(['a.pdf', 'b.pdf']));
    const { container } = renderComposer();

    pick(container, [pdf('a.pdf'), pdf('b.pdf')]);
    await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());

    // Red if the click never reaches the PUT in flight: the second file would
    // go out and finalize would attach both.
    expect(xhr.calls('PUT').map((c) => c.url)).toEqual([SESSION_A]);
    expect(api.callsTo(`${FIRM_BASE}/upload-finalize`)).toEqual([]);
    expect(notUploaded()).toHaveLength(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('is withdrawn once finalize has gone out', async () => {
    api.post(`${FIRM_BASE}/upload-init`, opened(['a.pdf']));
    xhr.onExact('PUT', SESSION_A, { status: 200 });
    api.post(`${FIRM_BASE}/upload-finalize`, { delayMs: 200, body: finalized(['a.pdf']) });
    const { container } = renderComposer();

    pick(container, [pdf('a.pdf')]);
    await waitFor(() => expect(api.callsTo(`${FIRM_BASE}/upload-finalize`)).toHaveLength(1));

    // Still busy, but no longer cancellable: the server is already verifying
    // the files, and a cancel here would silently drop attachments it accepted.
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(cancelButton()).not.toBeInTheDocument();
    expect(await screen.findByText('a.pdf')).toBeInTheDocument();
  });

  it('still reports a real failure', async () => {
    api.post(`${FIRM_BASE}/upload-init`, {
      status: 413, body: { error: 'Storage limit reached', code: 'STORAGE_LIMIT_EXCEEDED' },
    });
    const { container } = renderComposer();

    pick(container, [pdf('a.pdf')]);

    // Red if the cancel handling swallows every rejection rather than only a
    // cancel: the user would see the upload silently vanish.
    expect(await screen.findByRole('alert')).toHaveTextContent(/Storage limit reached/);
    expect(cancelButton()).not.toBeInTheDocument();
  });
});

describe('leaving mid-upload', () => {
  it('abandons the upload when the composer unmounts', async () => {
    api.post(`${FIRM_BASE}/upload-init`, { delayMs: 100, body: opened(['a.pdf']) });
    xhr.onExact('PUT', SESSION_A, { status: 200 });
    api.post(`${FIRM_BASE}/upload-finalize`, finalized(['a.pdf']));
    const { container, unmount } = renderComposer();

    pick(container, [pdf('a.pdf')]);
    unmount();
    await settle(250);

    // Red if the upload outlives its composer: the bytes go out and finalize
    // runs for attachments no composer will ever send.
    expect(xhr.calls()).toEqual([]);
    expect(api.callsTo(`${FIRM_BASE}/upload-finalize`)).toEqual([]);
  });

  it('abandons the upload when the portal switches thread under it', async () => {
    api.post(`${PORTAL_BASE}/upload-init`, { delayMs: 100, body: opened(['a.pdf']) });
    xhr.onExact('PUT', SESSION_A, { status: 200 });
    api.post(`${PORTAL_BASE}/upload-finalize`, finalized(['a.pdf']));
    // The portal's thread picker re-renders one composer with a new
    // conversation rather than mounting a fresh one.
    const { container, rerender } = renderComposer({ isClient: true, conversationId: 'group-a' });

    pick(container, [pdf('a.pdf')]);
    rerender(
      <MessageInput onSend={jest.fn()} lawFirmId={FIRM} clientId="client-1" isClient conversationId="group-b" />,
    );
    await settle(250);

    // Red if the upload for thread A finishes into thread B's composer, where
    // Send would post files stored under A's folder into B.
    expect(xhr.calls()).toEqual([]);
    expect(api.callsTo(`${PORTAL_BASE}/upload-finalize`)).toEqual([]);
    expect(screen.queryByText('a.pdf')).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('starts the next thread with an empty composer', async () => {
    api.post(`${PORTAL_BASE}/upload-init`, opened(['a.pdf']));
    xhr.onExact('PUT', SESSION_A, { status: 200 });
    api.post(`${PORTAL_BASE}/upload-finalize`, finalized(['a.pdf']));
    const { container, rerender } = renderComposer({ isClient: true, conversationId: 'group-a' });

    pick(container, [pdf('a.pdf')]);
    await screen.findByText('a.pdf');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'For thread A only' } });

    rerender(
      <MessageInput onSend={jest.fn()} lawFirmId={FIRM} clientId="client-1" isClient conversationId="group-b" />,
    );

    // Red if the attachment and the draft carry over: Send in thread B would
    // post a document and words meant for the people in thread A.
    expect(screen.queryByText('a.pdf')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('');
  });
});

describe.each([
  { surface: 'firm side', base: FIRM_BASE, props: {} },
  { surface: 'client portal', base: PORTAL_BASE, props: { isClient: true, conversationId: 'conv-1' } },
])('files that have not uploaded yet ($surface)', ({ base, props }) => {
  it('uploads the pending files on Send, then sends the message with them', async () => {
    const user = userEvent.setup();
    api.post(`${base}/upload-init`, { delayMs: 200, body: opened(['a.pdf']) });
    xhr.onExact('PUT', SESSIONS[0], { status: 200 });
    api.post(`${base}/upload-finalize`, finalized(['a.pdf']));
    const { container, onSend } = renderComposer(props);

    await user.type(screen.getByRole('textbox'), 'Here it is');
    await pickThenCancel(container, [pdf('a.pdf')]);
    fireEvent.click(sendButton());

    // The same bar and Cancel as a pick, while the pending file uploads.
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(cancelButton()).toBeInTheDocument();
    // Red if Send posts the message before the file is uploaded, or without it.
    expect(onSend).not.toHaveBeenCalled();

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const [text, attachments] = onSend.mock.calls[0];
    expect(text).toBe('Here it is');
    expect(attachments.map((a: { name: string }) => a.name)).toEqual(['a.pdf']);
    expect(lastInitNames(base)).toEqual(['a.pdf']);
    // The composer is empty again, as after any send.
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.queryByText('a.pdf')).not.toBeInTheDocument();
  });

  it('keeps the files pending and sends nothing when the Send upload is cancelled', async () => {
    const user = userEvent.setup();
    api.post(`${base}/upload-init`, { delayMs: 200, body: opened(['a.pdf']) });
    const { container, onSend } = renderComposer(props);

    await user.type(screen.getByRole('textbox'), 'Draft to keep');
    await pickThenCancel(container, [pdf('a.pdf')]);
    fireEvent.click(sendButton());
    fireEvent.click(cancelButton()!);
    await settle(250);

    // Red if the cancelled Send still posts, or drops the file it was sending.
    expect(onSend).not.toHaveBeenCalled();
    expect(notUploaded()).toHaveLength(1);
    expect(screen.getByRole('textbox')).toHaveValue('Draft to keep');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(api.callsTo(`${base}/upload-finalize`)).toEqual([]);
    expect(sendButton()).not.toBeDisabled();
  });

  it('keeps the files pending and shows the error when the Send upload fails', async () => {
    const user = userEvent.setup();
    let initAnswer: object = { delayMs: 200, body: opened(['a.pdf']) };
    api.post(`${base}/upload-init`, () => initAnswer);
    const { container, onSend } = renderComposer(props);

    await user.type(screen.getByRole('textbox'), 'Draft to keep');
    await pickThenCancel(container, [pdf('a.pdf')]);
    initAnswer = { status: 413, body: { error: 'Storage limit reached', code: 'STORAGE_LIMIT_EXCEEDED' } };
    fireEvent.click(sendButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(/Storage limit reached/);
    // Red if a failed upload still sends the text alone, or loses the file.
    expect(onSend).not.toHaveBeenCalled();
    expect(notUploaded()).toHaveLength(1);
    expect(screen.getByRole('textbox')).toHaveValue('Draft to keep');
  });
});

describe('pending files beside other attachments', () => {
  it('sends already-uploaded attachments together with the pending ones it uploads', async () => {
    let initAnswer: object = opened(['b.pdf']);
    api.post(`${FIRM_BASE}/upload-init`, () => initAnswer);
    xhr.onExact('PUT', SESSIONS[0], { status: 200 });
    api.post(`${FIRM_BASE}/upload-finalize`, sequence(finalized(['b.pdf']), finalized(['a.pdf'])));
    const { container, onSend } = renderComposer();

    pick(container, [pdf('b.pdf')]);
    expect(await screen.findByText('b.pdf')).toBeInTheDocument();
    initAnswer = { delayMs: 200, body: opened(['a.pdf']) };
    await pickThenCancel(container, [pdf('a.pdf')]);
    fireEvent.click(sendButton());

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    // Red if Send uploads b.pdf a second time, or leaves it out of the message.
    expect(lastInitNames(FIRM_BASE)).toEqual(['a.pdf']);
    expect(onSend.mock.calls[0][1].map((a: { name: string }) => a.name)).toEqual(['b.pdf', 'a.pdf']);
  });

  it('leaves out an uploaded attachment removed while Send was uploading', async () => {
    let initAnswer: object = opened(['b.pdf']);
    api.post(`${FIRM_BASE}/upload-init`, () => initAnswer);
    xhr.onExact('PUT', SESSIONS[0], { status: 200 });
    api.post(`${FIRM_BASE}/upload-finalize`, sequence(finalized(['b.pdf']), finalized(['a.pdf'])));
    const { container, onSend } = renderComposer();

    pick(container, [pdf('b.pdf')]);
    expect(await screen.findByText('b.pdf')).toBeInTheDocument();
    initAnswer = { delayMs: 200, body: opened(['a.pdf']) };
    await pickThenCancel(container, [pdf('a.pdf')]);
    fireEvent.click(sendButton());
    fireEvent.click(screen.getByRole('button', { name: 'Remove b.pdf' }));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    // Red if Send sends the attachments as they were when it was clicked.
    expect(onSend.mock.calls[0][1].map((a: { name: string }) => a.name)).toEqual(['a.pdf']);
  });

  it('lets the user remove a pending file, so Send neither uploads nor sends it', async () => {
    const user = userEvent.setup();
    api.post(`${FIRM_BASE}/upload-init`, { delayMs: 200, body: opened(['a.pdf']) });
    const { container, onSend } = renderComposer();

    await user.type(screen.getByRole('textbox'), 'Just the text');
    await pickThenCancel(container, [pdf('a.pdf')]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.pdf' }));
    const initsBefore = api.callsTo(`${FIRM_BASE}/upload-init`).length;
    fireEvent.click(sendButton());

    // Red if the chip's remove control leaves the file queued for Send.
    expect(onSend).toHaveBeenCalledWith('Just the text', [], []);
    expect(api.callsTo(`${FIRM_BASE}/upload-init`)).toHaveLength(initsBefore);
  });

  it('sends a message made only of pending files', async () => {
    api.post(`${FIRM_BASE}/upload-init`, { delayMs: 200, body: opened(['a.pdf']) });
    xhr.onExact('PUT', SESSIONS[0], { status: 200 });
    api.post(`${FIRM_BASE}/upload-finalize`, finalized(['a.pdf']));
    const { container, onSend } = renderComposer();

    await pickThenCancel(container, [pdf('a.pdf')]);
    // Red if Send stays disabled with no text and no uploaded attachment.
    expect(sendButton()).not.toBeDisabled();
    fireEvent.click(sendButton());

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0]).toBe('');
    expect(onSend.mock.calls[0][1].map((a: { name: string }) => a.name)).toEqual(['a.pdf']);
  });

  it('counts pending files toward the five-attachment limit', async () => {
    api.post(`${FIRM_BASE}/upload-init`, { delayMs: 200, body: opened(['a.pdf', 'b.pdf', 'c.pdf']) });
    const { container } = renderComposer();

    await pickThenCancel(container, [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')]);
    const initsBefore = api.callsTo(`${FIRM_BASE}/upload-init`).length;
    pick(container, [pdf('d.pdf'), pdf('e.pdf'), pdf('f.pdf')]);

    // Three pending plus three more is six. Red if pending files are not
    // counted: the pick would go out and the message would exceed the cap.
    expect(await screen.findByRole('alert')).toHaveTextContent('Maximum 5 attachments per message');
    expect(api.callsTo(`${FIRM_BASE}/upload-init`)).toHaveLength(initsBefore);
    expect(notUploaded()).toHaveLength(3);
  });

  it('keeps the picked files pending when their upload fails on pick', async () => {
    api.post(`${FIRM_BASE}/upload-init`, {
      status: 413, body: { error: 'Storage limit reached', code: 'STORAGE_LIMIT_EXCEEDED' },
    });
    const { container } = renderComposer();

    pick(container, [pdf('a.pdf')]);

    expect(await screen.findByRole('alert')).toHaveTextContent(/Storage limit reached/);
    // Red if a failed pick throws the file away, as a cancelled one once did.
    expect(notUploaded()).toHaveLength(1);
  });
});

describe('leaving while Send uploads', () => {
  it('sends nothing into the thread the portal switched to', async () => {
    api.post(`${PORTAL_BASE}/upload-init`, { delayMs: 200, body: opened(['a.pdf']) });
    xhr.onExact('PUT', SESSIONS[0], { status: 200 });
    api.post(`${PORTAL_BASE}/upload-finalize`, finalized(['a.pdf']));
    const onSend = jest.fn();
    const { container, rerender } = renderWithProviders(
      <MessageInput onSend={onSend} lawFirmId={FIRM} clientId="client-1" isClient conversationId="group-a" />,
    );

    await pickThenCancel(container, [pdf('a.pdf')]);
    fireEvent.click(sendButton());
    rerender(
      <MessageInput onSend={onSend} lawFirmId={FIRM} clientId="client-1" isClient conversationId="group-b" />,
    );
    await settle(250);

    // Red if the Send upload for thread A completes and posts into thread B.
    expect(onSend).not.toHaveBeenCalled();
    expect(xhr.calls()).toEqual([]);
    expect(api.callsTo(`${PORTAL_BASE}/upload-finalize`)).toEqual([]);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});

describe.each([
  { surface: 'firm side', base: FIRM_BASE, props: {} },
  { surface: 'client portal', base: PORTAL_BASE, props: { isClient: true, conversationId: 'conv-1' } },
])('files finalize refuses ($surface)', ({ base, props }) => {
  it('names the refused file and keeps the one it accepted', async () => {
    api.post(`${base}/upload-init`, opened(['a.pdf', 'b.pdf']));
    xhr.onExact('PUT', SESSION_A, { status: 200 });
    xhr.onExact('PUT', SESSION_B, { status: 200 });
    api.post(`${base}/upload-finalize`, {
      attachments: finalized(['a.pdf']).attachments,
      failures: [{ objectPath: 'msg/b.pdf', fileName: 'b.pdf', error: 'This file type is not allowed.' }],
    });
    const { container } = renderComposer(props);

    pick(container, [pdf('a.pdf'), pdf('b.pdf')]);

    // Red on a composer that drops the refused file without a word.
    expect(await screen.findByText('Could not attach "b.pdf": This file type is not allowed.')).toBeInTheDocument();
    expect(screen.getByText('a.pdf')).toBeInTheDocument();
    expect(screen.queryByText('b.pdf')).not.toBeInTheDocument();
  });
});

describe.each([
  { surface: 'firm side', base: FIRM_BASE, props: {} },
  { surface: 'client portal', base: PORTAL_BASE, props: { isClient: true, conversationId: 'conv-1' } },
])('a send that fails ($surface)', ({ base, props }) => {
  it('gives the draft and its attachments back to the composer', async () => {
    const user = userEvent.setup();
    api.post(`${base}/upload-init`, opened(['a.pdf']));
    xhr.onExact('PUT', SESSION_A, { status: 200 });
    api.post(`${base}/upload-finalize`, finalized(['a.pdf']));
    const onSend = jest.fn().mockResolvedValue(false);
    const { container } = renderComposer({ ...props, onSend });

    pick(container, [pdf('a.pdf')]);
    expect(await screen.findByText('a.pdf')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox'), 'Keep me');
    await user.click(sendButton());

    expect(onSend).toHaveBeenCalledWith('Keep me', [expect.objectContaining({ name: 'a.pdf' })], []);
    // Red on a composer that clears the draft before it knows the send landed.
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Keep me'));
    expect(screen.getByText('a.pdf')).toBeInTheDocument();
  });
});

describe('the portal personal thread', () => {
  it('uploads with no conversation id rather than its firm-and-uid key', async () => {
    api.post(`${PORTAL_BASE}/upload-init`, opened(['a.pdf']));
    xhr.onExact('PUT', SESSION_A, { status: 200 });
    api.post(`${PORTAL_BASE}/upload-finalize`, finalized(['a.pdf']));
    const { container } = renderComposer({ isClient: true, conversationId: `${FIRM}_client-1` });

    pick(container, [pdf('a.pdf')]);
    expect(await screen.findByText('a.pdf')).toBeInTheDocument();

    // The route answers 404 to a key that is not a conversation id.
    expect(api.callsTo(`${PORTAL_BASE}/upload-init`)[0].body).not.toHaveProperty('conversationId');
    expect(api.callsTo(`${PORTAL_BASE}/upload-finalize`)[0].body).not.toHaveProperty('conversationId');
  });
});

describe('removing an uploaded attachment before sending', () => {
  /**
   * Finalize charges an attachment to the firm's storage the moment it lands.
   * A chip removed from the composer is never sent, so without a discard its
   * object stays in storage, counted against the quota, reachable by nobody.
   */
  it('discards the object on the firm side, scoped to the thread it was uploaded for', async () => {
    api.post(`${FIRM_BASE}/upload-init`, opened(['a.pdf']));
    xhr.onExact('PUT', SESSION_A, { status: 200 });
    api.post(`${FIRM_BASE}/upload-finalize`, finalized(['a.pdf']));
    const { container } = renderComposer();

    pick(container, [pdf('a.pdf')]);
    expect(await screen.findByText('a.pdf')).toBeInTheDocument();
    expect(api.callsTo(`${FIRM_BASE}/discard`)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.pdf' }));

    await waitFor(() => expect(api.callsTo(`${FIRM_BASE}/discard`)).toHaveLength(1));
    expect(api.callsTo(`${FIRM_BASE}/discard`)[0].body).toEqual({ clientId: 'client-1', objectPaths: ['msg/a.pdf'] });
    expect(screen.queryByText('a.pdf')).not.toBeInTheDocument();
  });

  it('scopes a group thread discard by its conversation', async () => {
    api.post(`${FIRM_BASE}/upload-init`, opened(['a.pdf']));
    xhr.onExact('PUT', SESSION_A, { status: 200 });
    api.post(`${FIRM_BASE}/upload-finalize`, finalized(['a.pdf']));
    const { container } = renderComposer({ clientId: '', conversationId: 'group-1' });

    pick(container, [pdf('a.pdf')]);
    expect(await screen.findByText('a.pdf')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.pdf' }));

    await waitFor(() => expect(api.callsTo(`${FIRM_BASE}/discard`)).toHaveLength(1));
    expect(api.callsTo(`${FIRM_BASE}/discard`)[0].body).toEqual({ conversationId: 'group-1', objectPaths: ['msg/a.pdf'] });
  });

  it('discards through the portal route, with no conversation id for the personal thread', async () => {
    api.post(`${PORTAL_BASE}/upload-init`, opened(['a.pdf']));
    xhr.onExact('PUT', SESSION_A, { status: 200 });
    api.post(`${PORTAL_BASE}/upload-finalize`, finalized(['a.pdf']));
    const { container } = renderComposer({ isClient: true, conversationId: `${FIRM}_client-1` });

    pick(container, [pdf('a.pdf')]);
    expect(await screen.findByText('a.pdf')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.pdf' }));

    await waitFor(() => expect(api.callsTo(`${PORTAL_BASE}/discard`)).toHaveLength(1));
    expect(api.callsTo(`${PORTAL_BASE}/discard`)[0].body).toEqual({ objectPaths: ['msg/a.pdf'] });
    expect(api.callsTo(`${FIRM_BASE}/discard`)).toHaveLength(0);
  });

  it('removes the chip and shows nothing when the discard fails', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    api.post(`${FIRM_BASE}/upload-init`, opened(['a.pdf']));
    xhr.onExact('PUT', SESSION_A, { status: 200 });
    api.post(`${FIRM_BASE}/upload-finalize`, finalized(['a.pdf']));
    api.post(`${FIRM_BASE}/discard`, { status: 500, body: { error: 'boom' } });
    const { container } = renderComposer();

    pick(container, [pdf('a.pdf')]);
    expect(await screen.findByText('a.pdf')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.pdf' }));

    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(screen.queryByText('a.pdf')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    consoleError.mockRestore();
  });

  it('sends no discard for a file that never uploaded', async () => {
    api.post(`${FIRM_BASE}/upload-init`, { delayMs: 200, body: opened(['a.pdf']) });
    const { container } = renderComposer();

    await pickThenCancel(container, [pdf('a.pdf')]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.pdf' }));
    await settle(50);

    expect(api.callsTo(`${FIRM_BASE}/discard`)).toHaveLength(0);
  });
});
