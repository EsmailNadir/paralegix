/**
 * The signatures service, tested OFFLINE against a fake transport.
 *
 * `signatures.service.ts` reports 0%. It is the only part of the app that
 * produces a legally executed document, and two of its payloads are ORDERED
 * lists whose order is the meaning:
 *
 * - `signers` carries an explicit `order`, and under sequential routing it
 *   decides who is emailed first and who waits. Reordered, the wrong person is
 *   asked to sign first and the intended first signer is never invited.
 * - `fields` binds each placed box to a signer through `signerId`. Reordered or
 *   re-bound, a signature block lands on another person's line, and the
 *   resulting PDF looks entirely normal.
 *
 * So the tests assert the exact array that leaves the browser, element by
 * element, rather than its length.
 *
 * THE OTHER THING THIS FILE WATCHES
 * Where an identity ends up. `getPendingForUser` puts the firm in the PATH and
 * `getPendingForClient` puts it in the QUERY; `cancelSigningSession` needs no
 * firm at all while `resendParticipant` needs the firm, the session AND the
 * participant. These are all opaque strings, so a misplacement type-checks.
 *
 * The `/signing/*` routes are reachable by an external signer holding only a
 * token, so several of them are checked for what they must NOT do.
 */
jest.unmock('@/services/signatures.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, sequence, type ApiMock } from '../../support/apiMock';
import { installXhrMock, formDataValues, type XhrMock } from '../../support/xhrMock';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import signaturesService from '@/services/signatures.service';
import { UploadCancelledError } from '@/lib/files/resumableUpload';
import { runWithUploadLimit } from '@/lib/files/uploadConcurrency';
import { installWebLocks, type WebLocksMock } from '../../support/webLocks';
import type { SignatureField, SigningParticipant } from '@/types/signature';

const LAW_FIRM_ID = 'firm-1';
const TOKEN = 'sess-tok-1';
const TEMPLATE_ID = 'tpl-3';

let api: ApiMock;
let xhr: XhrMock;
let locks: WebLocksMock;
let clickedLinks: HTMLAnchorElement[];
let savedBlobs: Array<Blob | MediaSource>;
let clickSpy: jest.SpyInstance;

/** Query parameters of a recorded call, read back the way a server reads them. */
const paramsOf = (url: string): URLSearchParams => new URL(url, 'http://x').searchParams;

/** The parsed JSON body of a recorded call. */
const bodyOf = (call: { body: unknown }): Record<string, unknown> =>
  call.body as Record<string, unknown>;

/** Two signers whose ORDER is the routing order. */
const SIGNERS: SigningParticipant[] = [
  { participantId: 'p-client', roleLabel: 'Client', order: 1, deliveryMethod: 'email', name: 'Pat Person', email: 'pat@example.com' },
  { participantId: 'p-partner', roleLabel: 'Managing Partner', order: 2, deliveryMethod: 'internal_dashboard', name: 'Sam Partner' },
];

/** One field per signer, bound by `signerId`. */
const FIELDS: SignatureField[] = [
  { id: 'f-client', page: 1, xPercent: 10, yPercent: 80, widthPercent: 20, heightPercent: 6, fieldType: 'signature', signerId: 'p-client' },
  { id: 'f-partner', page: 2, xPercent: 60, yPercent: 80, widthPercent: 20, heightPercent: 6, fieldType: 'signature', signerId: 'p-partner' },
];

beforeEach(() => {
  // A signing upload remembers its session per file identity, and jsdom's
  // localStorage persists across specs in a file, so one left open would make a
  // later spec skip its init call.
  window.localStorage.clear();
  api = installApiMock();
  xhr = installXhrMock();
  // jsdom has no Web Locks, and without them the service refuses to adopt a
  // remembered session at all, because it cannot prove no other tab is driving
  // it. One tab in a browser that HAS the API is the ordinary case.
  locks = installWebLocks();
  // The dev-only duplicate-GET guard warns when a spec hits the same endpoint
  // twice inside its window, which is normal here and would otherwise bury the
  // real output.
  __resetDuplicateRequestGuard();

  // jsdom implements neither object urls nor a navigating anchor click, and both
  // download paths use them. Capturing them is also how a spec proves the
  // document was saved under the right name.
  clickedLinks = [];
  savedBlobs = [];
  window.URL.createObjectURL = ((blob: Blob | MediaSource) => {
    savedBlobs.push(blob);
    return 'blob:test/1';
  }) as typeof window.URL.createObjectURL;
  window.URL.revokeObjectURL = (() => {}) as typeof window.URL.revokeObjectURL;
  clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
    function click(this: HTMLAnchorElement) { clickedLinks.push(this); },
  );
});

afterEach(() => {
  clickSpy.mockRestore();
  locks.restore();
  api.restore();
  xhr.restore();
});

describe('preparing a stored document for signing', () => {
  it('POSTs the object path to the firm PREPARE route', async () => {
    api.post('/signature-links/prepare', { objectPath: 'firm/1/ready.pdf', fileName: 'ready.pdf' });

    await signaturesService.prepareForSigning(LAW_FIRM_ID, 'firm/1/draft.docx', 'draft.docx');

    const call = api.calls('POST')[0];
    expect(call.pathname)
      .toMatch(new RegExp(`/lawfirms/${LAW_FIRM_ID}/signature-links/prepare$`));
    // The object path is the whole instruction: the server converts and freezes
    // whatever it names. A wrong path either 404s or prepares another document.
    expect(bodyOf(call).objectPath).toBe('firm/1/draft.docx');
    expect(bodyOf(call).fileName).toBe('draft.docx');
    expect(bodyOf(call).requireFlatteningConfirmation).toBe(false);
  });

  it('requests flattening confirmation for a File Manager document', async () => {
    api.post('/signature-links/prepare', { objectPath: 'firm/1/form.pdf', fileName: 'form.pdf' });

    await signaturesService.prepareForSigning(LAW_FIRM_ID, 'firm/1/form.pdf', 'form.pdf', true);

    expect(bodyOf(api.calls('POST')[0]).requireFlatteningConfirmation).toBe(true);
  });

  it('does NOT repeat the firm id in the body', async () => {
    api.post('/signature-links/prepare', { objectPath: 'p', fileName: 'f' });

    await signaturesService.prepareForSigning(LAW_FIRM_ID, 'p', 'f');

    // The firm is in the path, and only the path is authorised. A second copy
    // gives the server two sources for one fact that can disagree.
    expect(bodyOf(api.calls('POST')[0]).lawFirmId).toBeUndefined();
  });

  it('throws when preparation is refused', async () => {
    api.post('/signature-links/prepare', {
      status: 415, body: { error: 'That file type cannot be signed' },
    });

    // A swallowed failure would hand the next step an undefined objectPath and
    // produce a signing session against no document.
    await expect(signaturesService.prepareForSigning(LAW_FIRM_ID, 'p', 'f'))
      .rejects.toThrow(/cannot be signed/i);
  });
});

describe('generating a signing link', () => {
  const LINK = { link: 'https://api.example.com/sign/abc?x=1', token: 'abc' };

  it('POSTs to the firm GENERATE route', async () => {
    api.post('/signature-links/generate', LINK);

    await signaturesService.generateLink(LAW_FIRM_ID, 'firm/1/a.pdf', 'a.pdf');

    expect(api.calls('POST')[0].pathname)
      .toMatch(new RegExp(`/lawfirms/${LAW_FIRM_ID}/signature-links/generate$`));
  });

  it('sends the signer list IN ORDER, participant by participant', async () => {
    api.post('/signature-links/generate', LINK);

    await signaturesService.generateLink(
      LAW_FIRM_ID, 'firm/1/a.pdf', 'a.pdf', FIELDS, SIGNERS,
    );

    const signers = bodyOf(api.calls('POST')[0]).signers as SigningParticipant[];
    // Under sequential routing the first entry is emailed and everyone after it
    // waits. Reversed, the managing partner is asked to sign a document the
    // client has not seen, and the client is never invited at all.
    expect(signers.map((s) => s.participantId)).toEqual(['p-client', 'p-partner']);
    expect(signers.map((s) => s.order)).toEqual([1, 2]);
    expect(signers[0].deliveryMethod).toBe('email');
    expect(signers[1].deliveryMethod).toBe('internal_dashboard');
  });

  it('sends the field list IN ORDER with each signerId binding intact', async () => {
    api.post('/signature-links/generate', LINK);

    await signaturesService.generateLink(
      LAW_FIRM_ID, 'firm/1/a.pdf', 'a.pdf', FIELDS, SIGNERS,
    );

    const fields = bodyOf(api.calls('POST')[0]).fields as SignatureField[];
    // `signerId` is what puts each block on the right person's line. Re-bound,
    // the executed PDF carries one person's signature above another's name and
    // looks completely normal.
    expect(fields.map((f) => f.id)).toEqual(['f-client', 'f-partner']);
    expect(fields.map((f) => f.signerId)).toEqual(['p-client', 'p-partner']);
    // The coordinates are percentages of the page, so a dropped one silently
    // moves a block to the top-left corner.
    expect(fields[1].page).toBe(2);
    expect(fields[1].xPercent).toBe(60);
    expect(fields[1].yPercent).toBe(80);
  });

  it('keeps a SINGLE signer as an array', async () => {
    api.post('/signature-links/generate', LINK);

    await signaturesService.generateLink(
      LAW_FIRM_ID, 'firm/1/a.pdf', 'a.pdf', [FIELDS[0]], [SIGNERS[0]],
    );

    // One signer is the most common request there is. Unwrapping it into a bare
    // object changes the request shape for the default case.
    expect(bodyOf(api.calls('POST')[0]).signers).toEqual([SIGNERS[0]]);
    expect(bodyOf(api.calls('POST')[0]).fields).toEqual([FIELDS[0]]);
  });

  it('OMITS signers and fields entirely when none were placed', async () => {
    api.post('/signature-links/generate', LINK);

    await signaturesService.generateLink(LAW_FIRM_ID, 'firm/1/a.pdf', 'a.pdf');

    // An unplaced document is signed freehand. Sending `null` here would be read
    // as an explicit empty layout rather than as no layout.
    const body = bodyOf(api.calls('POST')[0]);
    expect('signers' in body).toBe(false);
    expect('fields' in body).toBe(false);
  });

  it('does NOT send a blank access code', async () => {
    api.post('/signature-links/generate', LINK);

    await signaturesService.generateLink(
      LAW_FIRM_ID, 'firm/1/a.pdf', 'a.pdf', undefined, undefined,
      undefined, undefined, undefined, '',
    );

    // An empty string stored as an access code gates the link behind a code
    // nobody can type, and the signer is locked out of their own document.
    expect('accessCode' in bodyOf(api.calls('POST')[0])).toBe(false);
  });

  it('sends a real access code and the routing mode when given', async () => {
    api.post('/signature-links/generate', LINK);

    await signaturesService.generateLink(
      LAW_FIRM_ID, 'firm/1/a.pdf', 'a.pdf', FIELDS, SIGNERS,
      'firm/1/signed', 'Signed', 'client-2', 's3cret', 'sequential', true,
    );

    const body = bodyOf(api.calls('POST')[0]);
    // Routing mode decides whether signers are invited one at a time or all at
    // once. Dropped, the server default applies and every signer is emailed
    // immediately on a request the firm asked to sequence.
    expect(body.routingMode).toBe('sequential');
    expect(body.accessCode).toBe('s3cret');
    expect(body.destinationPath).toBe('firm/1/signed');
    expect(body.destinationLabel).toBe('Signed');
    expect(body.clientId).toBe('client-2');
    expect(body.emailSignersOnComplete).toBe(true);
  });

  it('CHARACTERISATION: drops emailSignersOnComplete when it is false', async () => {
    api.post('/signature-links/generate', LINK);

    await signaturesService.generateLink(
      LAW_FIRM_ID, 'firm/1/a.pdf', 'a.pdf', undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, false,
    );

    // `|| undefined` cannot express "explicitly off": an opt-out and an unset
    // value leave the browser identically, so the server's default decides. That
    // default currently agrees with the caller, which is the only reason this is
    // not a live bug. Recorded rather than asserted as correct.
    expect('emailSignersOnComplete' in bodyOf(api.calls('POST')[0])).toBe(false);
  });

  it('rewrites the returned link onto THIS origin', async () => {
    api.post('/signature-links/generate', {
      link: 'https://api-staging.paralegix.com/sign/abc?utm=1#top', token: 'abc',
    });

    const { link } = await signaturesService.generateLink(LAW_FIRM_ID, 'p', 'f');

    // The server answers with its own api origin. Handed to a signer unchanged
    // it opens the backend rather than the signing page, so the path, query and
    // hash are kept and only the origin is replaced.
    expect(link).toBe(`${window.location.origin}/sign/abc?utm=1#top`);
  });

  it('leaves an unparseable link alone rather than blanking it', async () => {
    api.post('/signature-links/generate', { link: '/sign/abc', token: 'abc' });

    // A relative link is already same-origin. Returning '' instead would hand
    // the firm a copy button that copies nothing.
    expect((await signaturesService.generateLink(LAW_FIRM_ID, 'p', 'f')).link)
      .toBe('/sign/abc');
  });

  it('throws when the link cannot be generated', async () => {
    api.post('/signature-links/generate', {
      status: 403, body: { error: 'You cannot send documents for signature' },
    });

    await expect(signaturesService.generateLink(LAW_FIRM_ID, 'p', 'f'))
      .rejects.toThrow(/cannot send documents/i);
  });
});

describe('sending a signing request', () => {
  const SENT = { sent: true, sessionToken: TOKEN };

  it('POSTs to /send, not to /generate or /send-email', async () => {
    api.post('/signature-links/send', SENT);

    await signaturesService.sendSigningRequest(LAW_FIRM_ID, {
      objectPath: 'p', fileName: 'f', fields: FIELDS, signers: SIGNERS,
    });

    // Three near-identical routes on the same router. `/generate` returns a link
    // and emails nobody; `/send` emails the signers. Crossed, either nothing is
    // delivered or a document goes out that the firm meant to hand over itself.
    expect(api.calls('POST')[0].pathname).toMatch(/\/signature-links\/send$/);
  });

  it('sends signers and fields in order', async () => {
    api.post('/signature-links/send', SENT);

    await signaturesService.sendSigningRequest(LAW_FIRM_ID, {
      objectPath: 'p', fileName: 'f', fields: FIELDS, signers: SIGNERS,
      routingMode: 'sequential',
    });

    const body = bodyOf(api.calls('POST')[0]);
    expect((body.signers as SigningParticipant[]).map((s) => s.participantId))
      .toEqual(['p-client', 'p-partner']);
    expect((body.fields as SignatureField[]).map((f) => f.signerId))
      .toEqual(['p-client', 'p-partner']);
    expect(body.routingMode).toBe('sequential');
  });

  it('rewrites every copy link onto this origin, keeping the participants paired', async () => {
    api.post('/signature-links/send', {
      sent: true,
      sessionToken: TOKEN,
      copyLinks: [
        { participantId: 'p-client', name: 'Pat Person', link: 'https://api.example.com/sign/aaa' },
        { participantId: 'p-partner', name: 'Sam Partner', link: 'https://api.example.com/sign/bbb' },
      ],
    });

    const { copyLinks } = await signaturesService.sendSigningRequest(LAW_FIRM_ID, {
      objectPath: 'p', fileName: 'f', fields: FIELDS, signers: SIGNERS,
    });

    // Each link is single-use and personal. Pairing them with the wrong name in
    // the copy dialog hands one signer another signer's link, and the first
    // person to open it signs as them.
    expect(copyLinks).toEqual([
      { participantId: 'p-client', name: 'Pat Person', link: `${window.location.origin}/sign/aaa` },
      { participantId: 'p-partner', name: 'Sam Partner', link: `${window.location.origin}/sign/bbb` },
    ]);
  });

  it('leaves copyLinks alone when the server did not send an array', async () => {
    api.post('/signature-links/send', { sent: true, sessionToken: TOKEN });

    // Not every delivery method produces copy links. Fabricating an empty array
    // would render a copy dialog with no rows instead of no dialog.
    expect((await signaturesService.sendSigningRequest(LAW_FIRM_ID, {
      objectPath: 'p', fileName: 'f', fields: FIELDS, signers: SIGNERS,
    })).copyLinks).toBeUndefined();
  });

  it('sends an emailed request through /send-email with the recipient in the body', async () => {
    api.post('/signature-links/send-email', { sent: true, messageId: 'm-1' });

    await signaturesService.sendSigningEmail(LAW_FIRM_ID, {
      recipientEmail: 'pat@example.com',
      recipientName: 'Pat Person',
      objectPath: 'p',
      fileName: 'f',
      fields: FIELDS,
      replyToEmail: 'clerk@firm.example',
    });

    const call = api.calls('POST')[0];
    expect(call.pathname).toMatch(/\/signature-links\/send-email$/);
    // The recipient address is who actually receives a document. There is no
    // second source for it, so a dropped or wrong value delivers privileged
    // material to whoever the server falls back to.
    expect(bodyOf(call).recipientEmail).toBe('pat@example.com');
    expect(bodyOf(call).replyToEmail).toBe('clerk@firm.example');
    expect((bodyOf(call).fields as SignatureField[]).map((f) => f.id))
      .toEqual(['f-client', 'f-partner']);
  });

  it('throws when the send is refused', async () => {
    api.post('/signature-links/send', {
      status: 400, body: { error: 'Every signer needs an email address' },
    });

    // Silence here shows a "sent" confirmation for a request that never left.
    await expect(signaturesService.sendSigningRequest(LAW_FIRM_ID, {
      objectPath: 'p', fileName: 'f', fields: FIELDS, signers: SIGNERS,
    })).rejects.toThrow(/needs an email address/i);
  });
});

describe('the recipient picker', () => {
  const RECIPIENTS = { items: [], hasMore: false };

  it('passes each filter under its own key', async () => {
    api.get('/signature-links/recipients', RECIPIENTS);

    await signaturesService.listSigningRecipients(LAW_FIRM_ID, {
      search: 'Pat Person', clientId: 'client-2', limit: 10,
    });

    const params = paramsOf(api.calls('GET')[0].url);
    // Read back through URLSearchParams, not decodeURIComponent: a query string
    // encodes a space as `+`, which decodeURIComponent leaves as a literal plus.
    expect(params.get('search')).toBe('Pat Person');
    expect(params.get('clientId')).toBe('client-2');
    expect(params.get('limit')).toBe('10');
  });

  it('sends no query string when nothing was asked for', async () => {
    api.get('/signature-links/recipients', RECIPIENTS);

    await signaturesService.listSigningRecipients(LAW_FIRM_ID);

    // `clientId=undefined` narrows the picker to a client of that name, which is
    // none, and the firm sees an empty recipient list.
    expect(api.calls('GET')[0].url).not.toContain('?');
  });

  it('CHARACTERISATION: drops a limit of zero', async () => {
    api.get('/signature-links/recipients', RECIPIENTS);

    await signaturesService.listSigningRecipients(LAW_FIRM_ID, { limit: 0 });

    // Guarded on truthiness, so `limit=0` is indistinguishable from no limit and
    // the server's default page size applies. Harmless here, and recorded so it
    // is not mistaken for clamping.
    expect(api.calls('GET')[0].url).not.toContain('limit');
  });

  it('throws when the picker read is refused', async () => {
    api.get('/signature-links/recipients', { status: 403, body: { error: 'Forbidden' } });

    // An empty picker and a forbidden picker must not look the same: the firm
    // would conclude the client has no portal account.
    await expect(signaturesService.listSigningRecipients(LAW_FIRM_ID)).rejects.toBeDefined();
  });
});

describe('the public signing session', () => {
  it('GETs the session by token, ENCODED', async () => {
    api.get('/signing/weird%20tok%2F1', { fileName: 'a.pdf', status: 'pending' });

    await signaturesService.getSigningSession('weird tok/1');

    // The token is the only credential an external signer holds. Left unencoded,
    // a token containing a slash becomes an extra path segment and reaches a
    // different route.
    expect(api.calls('GET')[0].pathname).toMatch(/\/signing\/weird%20tok%2F1$/);
  });

  it('polls STATUS through a separate, lighter route', async () => {
    api.get(`/signing/${TOKEN}`, { fileName: 'a.pdf', status: 'pending' });
    api.get(`/signing/${TOKEN}/status`, {
      sessionStatus: 'pending', participantStatus: null,
      totalParticipants: 2, completedParticipants: 1,
    });

    await signaturesService.getSigningSession(TOKEN);
    await signaturesService.getSigningStatus(TOKEN);

    // The waiting screen polls while a signer waits their turn. Polling the full
    // session read instead would re-run its writes on every tick.
    const paths = api.calls('GET').map((c) => c.pathname);
    expect(paths[0]).toMatch(/\/signing\/sess-tok-1$/);
    expect(paths[1]).toMatch(/\/signing\/sess-tok-1\/status$/);
  });

  it('builds the file url from the token without requesting anything', async () => {
    const url = signaturesService.getSigningFileUrl('weird tok/1');

    expect(url).toMatch(/\/signing\/weird%20tok%2F1\/file$/);
    expect(api.calls()).toHaveLength(0);
  });

  it('reads signed document metadata directly through getSigningReadMetadata', async () => {
    api.get(`/signing/${TOKEN}/file`, { url: 'https://storage.googleapis.com/doc.pdf', fileName: 'contract.pdf' });

    const meta = await signaturesService.getSigningReadMetadata(TOKEN, 'inline');
    expect(meta).toEqual({ url: 'https://storage.googleapis.com/doc.pdf', fileName: 'contract.pdf' });

    const params = paramsOf(api.calls('GET')[0].url);
    expect(params.get('disposition')).toBe('inline');
    // A session's source is a PDF at admission. A `format` parameter here asks
    // the API to convert a document it already refused to accept unconverted.
    expect(params.get('format')).toBeNull();
  });

  it('answers a WRONG access code with a verdict instead of throwing', async () => {
    api.post(`/signing/${TOKEN}/verify-access-code`, {
      status: 401,
      body: { error: 'Incorrect code', attemptsRemaining: 2, lockedSeconds: 0 },
    });

    const result = await signaturesService.verifyAccessCode(TOKEN, '0000');

    // Deliberately unlike the rest of this service: the signer is mid-flow on a
    // page with no error boundary, and the attempt counter has to be shown. A
    // throw here would replace the code prompt with a generic failure screen.
    expect(result.verified).toBe(false);
    expect(result.attemptsRemaining).toBe(2);
    expect(result.error).toBe('Incorrect code');
  });

  it('answers verified for an accepted code', async () => {
    api.post(`/signing/${TOKEN}/verify-access-code`, { ok: true });

    // The positive half: a verifier that always reported failure would lock every
    // signer out of a correctly gated document.
    expect(await signaturesService.verifyAccessCode(TOKEN, '1234'))
      .toEqual({ verified: true });
  });

  it('puts the access code in the BODY, never in the url', async () => {
    api.post(`/signing/${TOKEN}/verify-access-code`, { ok: true });

    await signaturesService.verifyAccessCode(TOKEN, 's3cret');

    // A code in the query string lands in server logs, proxy logs and browser
    // history, and it is the only thing gating the document.
    const call = api.calls('POST')[0];
    expect(bodyOf(call).code).toBe('s3cret');
    expect(call.url).not.toContain('s3cret');
  });

  it('declines with the reason in the body', async () => {
    api.post(`/signing/${TOKEN}/decline`, {});

    await signaturesService.declineToSign(TOKEN, 'The figures are wrong');

    const call = api.calls('POST')[0];
    expect(call.pathname).toMatch(/\/signing\/sess-tok-1\/decline$/);
    // The reason is recorded on the audit trail and shown to the firm. Dropped,
    // the firm sees a refusal with no explanation.
    expect(bodyOf(call).reason).toBe('The figures are wrong');
  });

  it('declines with an EMPTY body when no reason was given', async () => {
    api.post(`/signing/${TOKEN}/decline`, {});

    await signaturesService.declineToSign(TOKEN);

    // Giving no reason is allowed. Sending `reason: ""` would record an empty
    // explanation as though the signer had typed one.
    expect(bodyOf(api.calls('POST')[0])).toEqual({});
  });

  it('throws when a decline is refused', async () => {
    api.post(`/signing/${TOKEN}/decline`, {
      status: 409, body: { error: 'This session is already complete' },
    });

    // A swallowed failure tells the signer they declined a document that is
    // still waiting on them.
    await expect(signaturesService.declineToSign(TOKEN)).rejects.toThrow(/already complete/i);
  });
});

describe('submitting the signed document', () => {
  // A FIELDLESS session only. Its marks are drawn freehand in the browser, so
  // nothing on the server can reproduce them and the bytes have to come from
  // here. What changed is where they go: to STORAGE on their own leg, with the
  // completion naming the object. As a multipart body they made this the last
  // route in the signatures module holding a whole document in the API.
  const SIGNED_PATH = 'lawfirmids/firm-1/signing-work/sess-tok-1/completion/abc.pdf';
  const SESSION_URL = 'https://storage.googleapis.com/upload/signed-session';
  const CONSENT = {
    consentAgreed: true,
    consentName: 'Pat Person',
    consentTimestamp: '2026-05-01T10:00:00.000Z',
    sourceRevision: 'rev-1',
    idempotencyKey: 'idem-0123456789',
  };

  const arrangeSuccess = () => {
    api.post(`/signing/${TOKEN}/complete-upload-init`, { uploadUrl: SESSION_URL, objectPath: SIGNED_PATH });
    xhr.onExact('PUT', SESSION_URL, { status: 200 });
    api.post(`/signing/${TOKEN}/complete`, { success: true, state: 'completed', completed: true });
  };

  it('declares the name and size before asking for a session', async () => {
    arrangeSuccess();

    await signaturesService.submitSignedDocument(TOKEN, new Uint8Array([1, 2, 3]), 'executed.pdf', CONSENT);

    const [init] = api.callsTo(`/signing/${TOKEN}/complete-upload-init`);
    expect(init.body).toMatchObject({ fileName: 'executed.pdf', size: 3 });
  });

  it('sends the document to storage, not through the API', async () => {
    arrangeSuccess();

    await signaturesService.submitSignedDocument(TOKEN, new Uint8Array([1, 2, 3]), 'executed.pdf', CONSENT);

    expect(xhr.calls().some((call) => call.url === SESSION_URL && call.method === 'PUT')).toBe(true);
  });

  it('does not attach the API credential to the storage request', async () => {
    arrangeSuccess();

    await signaturesService.submitSignedDocument(TOKEN, new Uint8Array([1]), 'a.pdf', CONSENT);

    // The session url IS the authorization. Sending a bearer token to a storage
    // host widens where that credential has been for no gain.
    const put = xhr.calls().find((call) => call.url === SESSION_URL);
    const headers = Object.keys(put?.headers ?? {}).map((header) => header.toLowerCase());
    expect(headers).not.toContain('authorization');
  });

  it('completes by NAMING the object, carrying no document in the body', async () => {
    arrangeSuccess();

    await signaturesService.submitSignedDocument(TOKEN, new Uint8Array([1]), 'a.pdf', CONSENT);

    const [complete] = api.callsTo(`/signing/${TOKEN}/complete`);
    expect(complete.body).toMatchObject({
      signedObjectPath: SIGNED_PATH,
      // Consent is what makes the signature enforceable and it is recorded on
      // the audit trail. Dropped, the certificate is issued without it.
      consentAgreed: true,
      consentName: 'Pat Person',
      consentTimestamp: '2026-05-01T10:00:00.000Z',
      // The revision the signer's document was loaded at. Without it a document
      // replaced mid-session would take these marks anyway.
      sourceRevision: 'rev-1',
    });
    expect(complete.headers['content-type']).toMatch(/json/);
    expect(JSON.stringify(complete.body).length).toBeLessThan(1000);
  });

  it('does NOT complete when the upload failed', async () => {
    // A 410 is the session being gone, which the uploader treats as terminal.
    api.post(`/signing/${TOKEN}/complete-upload-init`, { uploadUrl: SESSION_URL, objectPath: SIGNED_PATH });
    xhr.onExact('PUT', SESSION_URL, { status: 410 });
    api.allowUnhandled();

    await expect(
      signaturesService.submitSignedDocument(TOKEN, new Uint8Array([1]), 'a.pdf', CONSENT),
    ).rejects.toThrow();

    // Reached anyway, this records a signature against an object that is not
    // there, and the executed document cannot be opened by anyone.
    expect(api.callsTo(`/signing/${TOKEN}/complete`)).toEqual([]);
  });

  it('treats a recorded signature whose document is still being produced as recorded, not as a failure', async () => {
    api.post(`/signing/${TOKEN}/complete-upload-init`, { uploadUrl: SESSION_URL, objectPath: SIGNED_PATH });
    xhr.onExact('PUT', SESSION_URL, { status: 200 });
    api.post(`/signing/${TOKEN}/complete`, {
      status: 503,
      body: {
        success: false, state: 'recoverable_failure', consentRecorded: true,
        code: 'FINALIZE_RETRYING', error: 'Your signature was recorded. The executed document is still being produced.',
      },
    });

    const result = await signaturesService.submitSignedDocument(TOKEN, new Uint8Array([1]), 'a.pdf', CONSENT);

    expect(result).toMatchObject({ state: 'recoverable_failure', consentRecorded: true });
  });

  it('reports the uploaded object before completing, so a retry can name it again', async () => {
    arrangeSuccess();
    const onUploaded = jest.fn();

    await signaturesService.submitSignedDocument(TOKEN, new Uint8Array([1]), 'a.pdf', CONSENT, { onUploaded });

    expect(onUploaded).toHaveBeenCalledWith(SIGNED_PATH);
  });

  it('completes with an object uploaded earlier without opening another upload', async () => {
    // A consumed token answers complete-upload-init with 404, so a retry that
    // asked again would tell a signer whose signature landed that the link expired.
    api.post(`/signing/${TOKEN}/complete`, { success: true, state: 'completed', completed: true });

    await signaturesService.submitSignedDocument(TOKEN, new Uint8Array([1]), 'a.pdf', CONSENT, {
      signedObjectPath: SIGNED_PATH,
    });

    expect(api.callsTo(`/signing/${TOKEN}/complete-upload-init`)).toEqual([]);
    expect(xhr.calls()).toEqual([]);
    expect(bodyOf(api.callsTo(`/signing/${TOKEN}/complete`)[0])).toMatchObject({
      signedObjectPath: SIGNED_PATH, idempotencyKey: CONSENT.idempotencyKey,
    });
  });

  it('asks whether a completion that timed out landed before sending it again', async () => {
    api.post(`/signing/${TOKEN}/complete-upload-init`, { uploadUrl: SESSION_URL, objectPath: SIGNED_PATH });
    xhr.onExact('PUT', SESSION_URL, { status: 200 });
    api.post(`/signing/${TOKEN}/complete`, { status: 504, body: { error: 'upstream request timeout' } });
    api.get(`/signing/${TOKEN}/status`, {
      sessionStatus: 'in_progress', participantStatus: 'completed', totalParticipants: 1, completedParticipants: 1,
    });

    const result = await signaturesService.submitSignedDocument(TOKEN, new Uint8Array([1]), 'a.pdf', CONSENT);

    expect(result).toMatchObject({ consentRecorded: true, state: 'processing' });
    expect(api.callsTo(`/signing/${TOKEN}/complete`)).toHaveLength(1);
  });

  it('surfaces a refused init without uploading anything', async () => {
    api.post(`/signing/${TOKEN}/complete-upload-init`, {
      status: 422, body: { error: 'This session is completed from its field values.' },
    });

    await expect(
      signaturesService.submitSignedDocument(TOKEN, new Uint8Array([1]), 'a.pdf', CONSENT),
    ).rejects.toThrow(/field values/i);

    expect(xhr.calls()).toEqual([]);
  });
});

describe('completing a field-driven signature when the answer is lost', () => {
  // The server may have recorded the signature before the gateway gave up on
  // the request. Telling the signer it failed sends them back to sign a
  // document they have already signed, or away believing they have not.
  const PAYLOAD = {
    consentAgreed: true,
    consentName: 'Pat Person',
    consentTimestamp: '2026-05-01T10:00:00.000Z',
    sourceRevision: 'rev-1',
    idempotencyKey: 'idem-abcdef0123',
    fieldValues: [{ fieldId: 'f-client', value: 'Pat' }],
  };
  const COMPLETE = `/signing/${TOKEN}/complete`;
  const STATUS = `/signing/${TOKEN}/status`;

  it.each([
    ['a gateway timeout', () => ({ status: 504, body: { error: 'upstream request timeout' } })],
    ['a lost connection', () => { throw new TypeError('Failed to fetch'); }],
  ])('reports the signature as recorded after %s when the status says so, without sending it again', async (_label, failure) => {
    api.post(COMPLETE, failure);
    api.get(STATUS, { sessionStatus: 'in_progress', participantStatus: 'completed', totalParticipants: 2, completedParticipants: 1 });

    const result = await signaturesService.completeSigning(TOKEN, PAYLOAD);

    expect(result).toMatchObject({ consentRecorded: true, state: 'waiting_for_others', waitingForNextSigner: true });
    expect(api.callsTo(COMPLETE)).toHaveLength(1);
  });

  it('reads a fully signed session as completed', async () => {
    api.post(COMPLETE, { status: 504, body: {} });
    api.get(STATUS, { sessionStatus: 'completed', participantStatus: 'completed', totalParticipants: 1, completedParticipants: 1 });

    await expect(signaturesService.completeSigning(TOKEN, PAYLOAD))
      .resolves.toMatchObject({ success: true, state: 'completed', completed: true });
  });

  it('sends the completion once more, with the SAME idempotency key, when the signature did not land', async () => {
    api.post(COMPLETE, sequence(
      { status: 504, body: {} },
      { success: true, state: 'completed', completed: true, consentRecorded: true },
    ));
    api.get(STATUS, { sessionStatus: 'in_progress', participantStatus: 'active', totalParticipants: 1, completedParticipants: 0 });

    const result = await signaturesService.completeSigning(TOKEN, PAYLOAD);

    expect(result).toMatchObject({ state: 'completed' });
    const posts = api.callsTo(COMPLETE);
    expect(posts).toHaveLength(2);
    expect(bodyOf(posts[1]).idempotencyKey).toBe(PAYLOAD.idempotencyKey);
  });

  it('does not ask or retry after a refusal, which is an answer', async () => {
    api.post(COMPLETE, { status: 409, body: { error: 'The document changed since you opened it.', code: 'REVISION_MISMATCH' } });

    await expect(signaturesService.completeSigning(TOKEN, PAYLOAD)).rejects.toThrow(/document changed/);
    expect(api.callsTo(COMPLETE)).toHaveLength(1);
    expect(api.callsTo(STATUS)).toEqual([]);
  });
});

describe('a completion retry that races the request it repeats', () => {
  // The first request may still be running on the server when the gateway gives
  // up on it. The retry carries the same idempotency key, but if it reaches the
  // consent write while the first holds the row lock it loses inside the
  // transaction and is answered 409 "already completed", not with the replay.
  // That 409 describes a signature that went through.
  const PAYLOAD = {
    consentAgreed: true,
    consentName: 'Pat Person',
    consentTimestamp: '2026-05-01T10:00:00.000Z',
    sourceRevision: 'rev-1',
    idempotencyKey: 'idem-race-0123',
    fieldValues: [{ fieldId: 'f-client', value: 'Pat' }],
  };
  const COMPLETE = `/signing/${TOKEN}/complete`;
  const STATUS = `/signing/${TOKEN}/status`;
  const NOT_YET = { sessionStatus: 'in_progress', participantStatus: 'active', totalParticipants: 2, completedParticipants: 0 };
  const RECORDED = { sessionStatus: 'in_progress', participantStatus: 'completed', totalParticipants: 2, completedParticipants: 1 };
  const TURN_TAKEN = { status: 409, body: { error: 'This signer has already completed their turn', code: 'CONFLICT' } };
  const DOC_DONE = { status: 409, body: { error: 'This document has already been completed', code: 'CONFLICT' } };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  /** Run a completion to its end, letting every wait inside it elapse. */
  async function settle<T>(promise: Promise<T>): Promise<T> {
    const outcome = promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await jest.advanceTimersByTimeAsync(10_000);
    const result = await outcome;
    if ('error' in result) throw result.error;
    return result.value;
  }

  it('reports the recorded outcome when the retry loses the race with a 409', async () => {
    api.post(COMPLETE, sequence({ status: 504, body: {} }, TURN_TAKEN));
    api.get(STATUS, sequence(NOT_YET, NOT_YET, RECORDED));

    const result = await settle(signaturesService.completeSigning(TOKEN, PAYLOAD));

    expect(result).toMatchObject({ consentRecorded: true, state: 'waiting_for_others', waitingForNextSigner: true });
    expect(api.callsTo(COMPLETE)).toHaveLength(2);
  });

  it('gives the first request a moment to finish before sending the retry', async () => {
    api.post(COMPLETE, sequence({ status: 504, body: {} }, { success: true, state: 'completed', completed: true, consentRecorded: true }));
    api.get(STATUS, NOT_YET);

    const pending = signaturesService.completeSigning(TOKEN, PAYLOAD);
    await jest.advanceTimersByTimeAsync(100);
    expect(api.callsTo(COMPLETE)).toHaveLength(1);

    await expect(settle(pending)).resolves.toMatchObject({ state: 'completed' });
    expect(api.callsTo(COMPLETE)).toHaveLength(2);
  });

  it('does not send the retry at all when the first request lands during that moment', async () => {
    api.post(COMPLETE, { status: 504, body: {} });
    api.get(STATUS, sequence(NOT_YET, RECORDED));

    const result = await settle(signaturesService.completeSigning(TOKEN, PAYLOAD));

    expect(result).toMatchObject({ consentRecorded: true, state: 'waiting_for_others' });
    expect(api.callsTo(COMPLETE)).toHaveLength(1);
    expect(api.callsTo(STATUS)).toHaveLength(2);
  });

  it('reads a first-attempt "document already completed" 409 as the recorded outcome when the status confirms it', async () => {
    api.post(COMPLETE, DOC_DONE);
    api.get(STATUS, { sessionStatus: 'completed', participantStatus: 'completed', totalParticipants: 1, completedParticipants: 1 });

    const result = await settle(signaturesService.completeSigning(TOKEN, PAYLOAD));

    expect(result).toMatchObject({ success: true, state: 'completed', completed: true });
    expect(api.callsTo(COMPLETE)).toHaveLength(1);
  });

  it('surfaces the 409 when the status does not show this signer as recorded', async () => {
    api.post(COMPLETE, sequence({ status: 504, body: {} }, TURN_TAKEN));
    api.get(STATUS, NOT_YET);

    await expect(settle(signaturesService.completeSigning(TOKEN, PAYLOAD)))
      .rejects.toThrow('This signer has already completed their turn');
    expect(api.callsTo(COMPLETE)).toHaveLength(2);
    expect(api.callsTo(STATUS)).toHaveLength(3);
  });

  it('recovers the same way for a fieldless submission', async () => {
    const SIGNED_PATH = 'lawfirmids/firm-1/signing-work/sess-tok-1/completion/race.pdf';
    api.post(COMPLETE, sequence({ status: 504, body: {} }, TURN_TAKEN));
    api.get(STATUS, sequence(NOT_YET, NOT_YET, RECORDED));

    const { idempotencyKey, consentAgreed, consentName, consentTimestamp, sourceRevision } = PAYLOAD;
    const result = await settle(signaturesService.submitSignedDocument(
      TOKEN, new Uint8Array([1]), 'a.pdf',
      { idempotencyKey, consentAgreed, consentName, consentTimestamp, sourceRevision },
      { signedObjectPath: SIGNED_PATH },
    ));

    expect(result).toMatchObject({ consentRecorded: true, state: 'waiting_for_others' });
  });
});

describe('the outcome reported for a signer the status route says is recorded', () => {
  // Reached when a completion got no answer and the status read shows the
  // signature landed. Each state drives a different screen, so a wrong one
  // tells the signer their document is ready when it is not, or that it is
  // still coming when it never will.
  const PAYLOAD = {
    consentAgreed: true,
    consentName: 'Pat Person',
    consentTimestamp: '2026-05-01T10:00:00.000Z',
    sourceRevision: 'rev-1',
    idempotencyKey: 'idem-map-0123',
    fieldValues: [],
  };
  const COMPLETE = `/signing/${TOKEN}/complete`;
  const STATUS = `/signing/${TOKEN}/status`;

  it('reads every signer recorded on an unsealed session as processing, not as a failure', async () => {
    api.post(COMPLETE, { status: 504, body: {} });
    api.get(STATUS, { sessionStatus: 'in_progress', participantStatus: 'completed', totalParticipants: 2, completedParticipants: 2 });

    const result = await signaturesService.completeSigning(TOKEN, PAYLOAD);

    expect(result).toEqual({
      success: false,
      state: 'processing',
      consentRecorded: true,
      completed: false,
      waitingForNextSigner: false,
      nextSignerName: null,
    });
  });

  it.each(['cancelled', 'expired'])(
    'reads a %s session as a recorded signature the sender has to act on',
    async (sessionStatus) => {
      api.post(COMPLETE, { status: 504, body: {} });
      api.get(STATUS, { sessionStatus, participantStatus: 'completed', totalParticipants: 2, completedParticipants: 1 });

      const result = await signaturesService.completeSigning(TOKEN, PAYLOAD);

      // The session will never be sealed, so neither "waiting for the others"
      // nor "still being produced" is true.
      expect(result).toEqual({
        success: false,
        state: 'permanent_refusal',
        consentRecorded: true,
        completed: false,
        waitingForNextSigner: false,
        nextSignerName: null,
      });
      expect(api.callsTo(COMPLETE)).toHaveLength(1);
    },
  );
});

describe('the firm signing history', () => {
  const SESSIONS = { totalItems: 0, sessions: [] };

  it('passes each filter under its own key', async () => {
    api.get('/signature-links/sessions', SESSIONS);

    await signaturesService.listSigningSessions(LAW_FIRM_ID, {
      page: 2, limit: 25, status: 'completed', search: 'retainer agreement',
    });

    const params = paramsOf(api.calls('GET')[0].url);
    expect(params.get('page')).toBe('2');
    expect(params.get('limit')).toBe('25');
    expect(params.get('status')).toBe('completed');
    expect(params.get('search')).toBe('retainer agreement');
  });

  it('OMITS a filter that was not given', async () => {
    api.get('/signature-links/sessions', SESSIONS);

    await signaturesService.listSigningSessions(LAW_FIRM_ID, { page: 2 });

    // `status=undefined` matches no session, so the history renders empty rather
    // than unfiltered.
    const url = api.calls('GET')[0].url;
    expect(url).not.toContain('status');
    expect(url).not.toContain('search');
  });

  it('CHARACTERISATION: does NOT clamp the page size', async () => {
    api.get('/signature-links/sessions', SESSIONS);

    await signaturesService.listSigningSessions(LAW_FIRM_ID, { limit: 100000 });

    // Unlike the list services built on `applyListWindow`, this one has no
    // ceiling of its own and relies entirely on the endpoint's schema to reject
    // an oversized page. Recorded so the difference is visible rather than
    // assumed.
    expect(paramsOf(api.calls('GET')[0].url).get('limit')).toBe('100000');
  });

  it('reads the status counts from a SEPARATE summary route', async () => {
    api.get('/signature-links/sessions', SESSIONS);
    api.get('/signature-links/sessions/summary', { counts: { completed: 3 }, total: 5, notCompleted: 2 });

    await signaturesService.listSigningSessions(LAW_FIRM_ID);
    const summary = await signaturesService.getSigningSessionSummary(LAW_FIRM_ID);

    // The filter labels count the whole history, not the filtered page, which is
    // why it cannot come from the list response. Sourced from the list, every
    // label would change as soon as a filter was applied.
    expect(api.calls('GET')[1].pathname).toMatch(/\/sessions\/summary$/);
    expect(summary.total).toBe(5);
  });

  it('throws when the history is refused', async () => {
    api.get('/signature-links/sessions', { status: 403, body: { error: 'Forbidden' } });

    await expect(signaturesService.listSigningSessions(LAW_FIRM_ID)).rejects.toBeDefined();
  });
});

describe('where the firm id ends up', () => {
  it('puts the firm in the PATH for a firm member pending list', async () => {
    api.get('/signature-links/pending-for-user', { needsMySignature: [], createdByMe: [] });

    await signaturesService.getPendingForUser(LAW_FIRM_ID);

    const call = api.calls('GET')[0];
    expect(call.pathname)
      .toMatch(new RegExp(`/lawfirms/${LAW_FIRM_ID}/signature-links/pending-for-user$`));
    expect(call.url).not.toContain('lawFirmId=');
  });

  it('puts the firm in the QUERY for a client pending list', async () => {
    api.get('/signing/pending-for-client', {
      pendingDocuments: [], totalItems: 0, singleLawFirmId: null,
    });

    await signaturesService.getPendingForClient({ lawFirmId: LAW_FIRM_ID, limit: 5 });

    const call = api.calls('GET')[0];
    // A portal client signs for several firms at once, so the firm is an
    // optional NARROWING filter rather than the scope of the route. Moved into
    // the path it would stop being optional and the cross-firm list would break.
    expect(call.pathname).not.toContain('/lawfirms/');
    expect(paramsOf(call.url).get('lawFirmId')).toBe(LAW_FIRM_ID);
    expect(paramsOf(call.url).get('limit')).toBe('5');
  });

  it('asks for EVERY firm when the client list is unnarrowed', async () => {
    api.get('/signing/pending-for-client', {
      pendingDocuments: [], totalItems: 0, singleLawFirmId: null,
    });

    await signaturesService.getPendingForClient();

    // The absence IS the instruction: no firm means all of them. A stray
    // `lawFirmId=undefined` would narrow to a firm of that name, which is none,
    // and the client's waiting list would always read zero.
    expect(api.calls('GET')[0].url).not.toContain('?');
  });

  it('sends a zero offset rather than dropping it', async () => {
    api.get('/signing/pending-for-client', {
      pendingDocuments: [], totalItems: 0, singleLawFirmId: null,
    });

    await signaturesService.getPendingForClient({ offset: 0, page: 1 });

    // Guarded with `!= null`, so page one is expressible. A truthiness guard
    // would drop `offset=0` and let a stale page value win.
    const params = paramsOf(api.calls('GET')[0].url);
    expect(params.get('offset')).toBe('0');
    expect(params.get('page')).toBe('1');
  });

  it('cancels a session by TOKEN alone, with no firm in the path', async () => {
    api.post(`/signing/${TOKEN}/cancel`, { success: true, status: 'cancelled' });

    await signaturesService.cancelSigningSession(TOKEN);

    const call = api.calls('POST')[0];
    expect(call.pathname).toMatch(/\/signing\/sess-tok-1\/cancel$/);
    expect(call.pathname).not.toContain('/lawfirms/');
  });

  it('resends to ONE participant, naming the firm, session and participant', async () => {
    api.post('/resend-participant/p-client', { sent: true, participantId: 'p-client' });

    await signaturesService.resendParticipant(LAW_FIRM_ID, TOKEN, 'p-client');

    // Three ids in one path, all opaque strings. The participant id is the last
    // segment and decides who gets the reminder email; swapped with the session
    // token the request 404s, or worse reminds the wrong signer.
    expect(api.calls('POST')[0].pathname).toMatch(
      new RegExp(`/lawfirms/${LAW_FIRM_ID}/signature-links/${TOKEN}/resend-participant/p-client$`),
    );
  });

  it('throws when a cancel is refused', async () => {
    api.post(`/signing/${TOKEN}/cancel`, {
      status: 409, body: { error: 'This session is already complete' },
    });

    // A swallowed refusal removes the row from the list while the signer's link
    // still works.
    await expect(signaturesService.cancelSigningSession(TOKEN))
      .rejects.toThrow(/already complete/i);
  });
});

describe('the audit trail', () => {
  it('GETs the audit route WITH a credential', async () => {
    api.get(`/signing/${TOKEN}/audit`, { session: {}, events: [] });

    await signaturesService.getAuditTrail(TOKEN);

    const call = api.calls('GET')[0];
    expect(call.pathname).toMatch(/\/signing\/sess-tok-1\/audit$/);
    // The trail carries every signer's IP and user agent. Unlike the rest of the
    // `/signing/*` routes it is firm-only, so the credential is required rather
    // than optional.
    expect(call.headers.authorization).toMatch(/^Bearer /);
  });

  it('throws when the audit trail is refused', async () => {
    api.get(`/signing/${TOKEN}/audit`, { status: 403, body: { error: 'Forbidden' } });

    await expect(signaturesService.getAuditTrail(TOKEN)).rejects.toBeDefined();
  });
});

describe('downloading the finished documents', () => {
  it('downloads the certificate directly from storage', async () => {
    api.get(`/signing/${TOKEN}/certificate`, {
      url: 'https://storage.test/certificate.pdf', fileName: 'Certificate of Completion.pdf',
    });

    await signaturesService.downloadCertificate(TOKEN);

    expect(api.calls('GET')[0].pathname).toMatch(/\/signing\/sess-tok-1\/certificate$/);
    expect(clickedLinks[0].download).toBe('Certificate of Completion.pdf');
    expect(savedBlobs).toHaveLength(0);
  });

  it('downloads the signed document as an ATTACHMENT with the certificate page', async () => {
    api.get(`/signing/${TOKEN}/signed-document`, {
      url: 'https://storage.test/signed.pdf', fileName: 'Signed Document.pdf',
    });

    await signaturesService.downloadSignedDocument(TOKEN);

    const params = paramsOf(api.calls('GET')[0].url);
    // The filed copy is the one with the Signature Certificate appended, so the
    // download must NOT ask for the copy without it.
    expect(params.get('disposition')).toBe('attachment');
    expect(params.has('copy')).toBe(false);
    expect(clickedLinks[0].download).toBe('Signed Document.pdf');
  });

  it('fetches direct download metadata via getSignedDocumentUrl with JSON format', async () => {
    api.get(`/signing/${TOKEN}/signed-document`, { url: 'https://storage.googleapis.com/final.pdf', fileName: 'Agreement-signed.pdf' });

    const meta = await signaturesService.getSignedDocumentUrl(TOKEN, 'attachment');
    expect(meta).toEqual({ url: 'https://storage.googleapis.com/final.pdf', fileName: 'Agreement-signed.pdf' });

    const params = paramsOf(api.calls('GET')[0].url);
    expect(params.get('disposition')).toBe('attachment');
    expect(params.get('format')).toBe('json');
  });

  it('gets an INLINE preview URL without the certificate page', async () => {
    api.get(`/signing/${TOKEN}/signed-document`, {
      url: 'https://storage.test/signed.pdf', fileName: 'Signed Document.pdf',
    });

    await signaturesService.getSignedDocumentUrl(TOKEN, 'inline', 'without-certificate');

    const params = paramsOf(api.calls('GET')[0].url);
    // On-screen reading shows the executed document alone; the certificate has
    // its own button. Reading the filed copy here appends a page the reader did
    // not ask for and did not expect.
    expect(params.get('disposition')).toBe('inline');
    expect(params.get('copy')).toBe('without-certificate');
    expect(clickedLinks).toHaveLength(0);
  });

  it('throws rather than saving an error page as a PDF', async () => {
    api.get(`/signing/${TOKEN}/signed-document`, {
      status: 404, body: { error: 'No signed document for this session' },
    });

    await expect(signaturesService.downloadSignedDocument(TOKEN))
      .rejects.toThrow(/no signed document/i);
    // Nothing must reach the downloads folder on a failure.
    expect(clickedLinks).toHaveLength(0);
  });
});

describe('verifying an uploaded document', () => {
  it('POSTs to the public verify route with NO credential', async () => {
    api.post('/signing/verify', { valid: true, matchedCopy: 'filed' });

    await signaturesService.verifyDocument(new File(['x'], 'maybe.pdf', { type: 'application/pdf' }));

    const call = api.calls('POST')[0];
    expect(call.pathname).toMatch(/\/signing\/verify$/);
    // Anyone holding a document may check it, including a counterparty with no
    // Paralegix account. Attaching the current user's bearer token here would
    // send a firm credential on a request that does not need one.
    expect(call.headers.authorization).toBeUndefined();
  });

  it('verifies by a locally computed hash and uploads no bytes', async () => {
    api.post('/signing/verify', { valid: true });
    const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
    const file = new File([bytes], 'signed.pdf', { type: 'application/pdf' });

    const result = await signaturesService.verifyDocument(file);

    expect(result.valid).toBe(true);
    const [call] = api.callsTo('/signing/verify');
    // The SHA-256 of those eight bytes, pinned as a value rather than a shape.
    // A body carrying the document itself, or a different digest, fails here.
    expect(call.body).toEqual({
      hash: '86edbaa24831badfa0a8b04bb410141e2ee4182b6d0014493fe262a7a331c20b',
    });
    expect(call.headers['content-type']).toMatch(/json/);
  });

  it('reports WHICH sealed copy was recognised', async () => {
    api.post('/signing/verify', { valid: true, matchedCopy: 'delivered' });

    // A completed session produces two genuine PDFs that hash differently. The
    // answer has to say which one, or a valid delivered copy reads as a
    // mismatch against the filed one.
    expect((await signaturesService.verifyDocument(new File(['x'], 'a.pdf'))).matchedCopy)
      .toBe('delivered');
  });

  it('throws when verification itself fails', async () => {
    api.post('/signing/verify', { status: 400, body: { error: 'Not a PDF' } });

    // Distinct from a valid request answering `valid: false`: an unreadable
    // upload must not be reported as a tampered document.
    await expect(signaturesService.verifyDocument(new File(['x'], 'a.txt')))
      .rejects.toThrow(/not a pdf/i);
  });
});

describe('converting and uploading a document', () => {
  let storageFetch: jest.Mock;
  const CONVERT_SESSION = 'https://storage.googleapis.com/upload/convert-a';
  const CONVERT_RESULT = 'https://storage.googleapis.com/signed/converted.pdf';

  /** Answer the three legs: init, the storage PUT, and the run. */
  function arrangeConvert() {
    api.post('/signatures/convert/upload-init', {
      uploadUrl: CONVERT_SESSION, objectPath: 'document-conversion/callers/u1/x/source',
    });
    xhr.onExact('PUT', CONVERT_SESSION, { status: 200 });
    api.post('/signatures/convert/run', {
      signedUrl: CONVERT_RESULT, fileName: 'draft.pdf', contentType: 'application/pdf', size: 10,
    });
    // Only the storage url is intercepted. `installApiMock` owns `global.fetch`
    // for the API legs, so replacing it outright would take the api fake with it
    // and every assertion here would be about a mock that is no longer running.
    const throughApiMock = global.fetch;
    storageFetch = jest.fn(async (input: any, init?: any) => (
      String(input) === CONVERT_RESULT
        ? new Response('converted', { headers: { 'Content-Type': 'application/pdf' } })
        : (throughApiMock as any)(input, init)
    ));
    global.fetch = storageFetch as never;
  }

  it('declares the file and the target format, then converts from storage', async () => {
    // Conversion used to be one multipart POST that answered with the bytes, so
    // BOTH directions passed through the API container: a large input and its
    // output resident at once, per caller.
    arrangeConvert();

    await signaturesService.convertDocument(new Blob(['x']), 'pdf', 'draft.docx');

    const init = api.callsTo('/signatures/convert/upload-init')[0].body as any;
    // The filename carries the source extension the converter switches on.
    expect(init.fileName).toBe('draft.docx');
    const run = api.callsTo('/signatures/convert/run')[0].body as any;
    expect(run.format).toBe('pdf');
    expect(run.objectPath).toBe('document-conversion/callers/u1/x/source');
  });

  it('sends the credential to the API and NOT to storage', async () => {
    arrangeConvert();

    await signaturesService.convertDocument(new Blob(['x']), 'pdf', 'a.docx');

    // The API routes reject an unauthenticated caller outright, which is how
    // every in-app conversion once failed silently.
    for (const call of api.calls('POST')) {
      expect(call.headers.authorization).toMatch(/^Bearer /);
    }
    // The storage leg is authorized by the signed url itself. A bearer token
    // there sends the user's credential to a host that never needed it.
    const put = xhr.calls('PUT')[0];
    expect(Object.keys(put.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
  });

  it('fetches the result from storage rather than through the API', async () => {
    arrangeConvert();

    const out = await signaturesService.convertDocument(new Blob(['x']), 'pdf', 'a.docx');

    // `publicFetch` passes its own options through, so the url is the first
    // argument and the deadline the second.
    expect(storageFetch).toHaveBeenCalledWith(CONVERT_RESULT, expect.anything());
    // Asserted by behaviour, not by constructor: node and jsdom each define a
    // Blob, so `toBeInstanceOf` compares two classes with the same name.
    expect(await out.text()).toBe('converted');
  });

  it('uploads a NON-PDF to storage before asking the API to convert it', async () => {
    const session = 'https://storage.googleapis.com/upload/signing-docx-1';
    const input = 'signing-uploads/firm-1/source.docx';
    api.post('/signing/convert-upload-init', { uploadUrl: session, objectPath: input });
    xhr.onExact('PUT', session, { status: 200 });
    api.post('/signing/convert-upload-finalize', { objectPath: 'signing-uploads/firm-1/converted.pdf', fileName: 'a.pdf' });

    // The conversion worker reads the uploaded object from storage. A PDF takes
    // the direct signing route below, while a DOCX takes this direct conversion
    // route and neither sends a multipart body through the API.
    await signaturesService.uploadForSigning(
      new File(['x'], 'a.docx', { type: 'application/msword' }), LAW_FIRM_ID,
    );

    expect(api.callsTo('/signing/convert-upload-init')[0].body).toEqual({
      lawFirmId: LAW_FIRM_ID, name: 'a.docx', contentType: 'application/msword', size: 1,
    });
    expect(xhr.calls('PUT')[0].url).toBe(session);
    expect(xhr.calls('PUT')[0].headers.authorization).toBeUndefined();
    expect(api.callsTo('/signing/convert-upload-finalize')[0].body).toEqual({
      lawFirmId: LAW_FIRM_ID, objectPath: input, name: 'a.docx',
    });
  });

  it('REFUSES an empty firm id rather than uploading anywhere', async () => {
    // This used to fall back to a route that posted the file to the API, which
    // then had to guard against `FormData` stringifying an empty firm id into
    // the permission check. That route is gone. Every remaining path needs the
    // firm: it is the storage prefix the object lands under and the tenant the
    // source row belongs to, so an absent one is refused before anything moves.
    await expect(signaturesService.uploadForSigning(new File(['x'], 'a.pdf'), ''))
      .rejects.toThrow(/law firm is required/i);

    expect(api.calls()).toEqual([]);
    expect(xhr.calls()).toEqual([]);
  });

  it('throws when a converting upload is refused', async () => {
    api.post('/signing/convert-upload-init', { status: 413, body: { error: 'File is too large' } });

    // The next step is handed this objectPath. A swallowed failure would build a
    // signing session against a document that was never stored.
    await expect(signaturesService.uploadForSigning(new File(['x'], 'a.docx'), LAW_FIRM_ID))
      .rejects.toThrow(/too large/i);
  });

  describe('a converter that is busy', () => {
    const SESSION = 'https://storage.googleapis.com/upload/signing-docx-busy';
    const INPUT = 'signing-uploads/firm-1/source.docx';
    const docx = () => new File(['x'], 'a.docx', { type: 'application/msword' });

    function arrangeUpload() {
      api.post('/signing/convert-upload-init', { uploadUrl: SESSION, objectPath: INPUT });
      xhr.onExact('PUT', SESSION, { status: 200 });
    }

    it('converts again when the server said it was busy, and returns the converted document', async () => {
      arrangeUpload();
      // Retry-After 0 keeps the case off the clock; the helper's own spec owns timing.
      api.post('/signing/convert-upload-finalize', sequence(
        { status: 503, headers: { 'Retry-After': '0' }, body: { error: 'busy', code: 'CONVERSION_BUSY' } },
        { objectPath: 'signing-uploads/firm-1/converted.pdf', fileName: 'a.pdf' },
      ));

      const result = await signaturesService.uploadForSigning(docx(), LAW_FIRM_ID);

      expect(result).toEqual({ objectPath: 'signing-uploads/firm-1/converted.pdf', fileName: 'a.pdf' });
      expect(api.callsTo('/signing/convert-upload-finalize')).toHaveLength(2);
    });

    it.each([
      ['a gateway timeout', { status: 504, body: { error: 'upstream request timeout' } }],
      ['a 503 that did not say busy', { status: 503, headers: { 'Retry-After': '0' }, body: { error: 'Conversion failed.' } }],
    ])('does NOT convert again after %s, because a failed finalize deletes its source', async (_label, failure) => {
      arrangeUpload();
      api.post('/signing/convert-upload-finalize', sequence(
        failure,
        { objectPath: 'signing-uploads/firm-1/converted.pdf', fileName: 'a.pdf' },
      ));

      await expect(signaturesService.uploadForSigning(docx(), LAW_FIRM_ID)).rejects.toThrow();
      expect(api.callsTo('/signing/convert-upload-finalize')).toHaveLength(1);
    });
  });

  it('reports a cancelled converting upload as cancellation rather than a request failure', async () => {
    api.post('/signing/convert-upload-init', { delayMs: 50, uploadUrl: 'https://storage/upload', objectPath: 'p' });
    const controller = new AbortController();
    const pending = signaturesService.uploadForSigning(
      new File(['x'], 'a.docx', { type: 'application/msword' }),
      LAW_FIRM_ID,
      { signal: controller.signal },
    );
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(UploadCancelledError);
  });

  it('reports a cancelled PDF upload as cancellation rather than a request failure', async () => {
    api.post('/signing/upload-init', {
      delayMs: 50,
      objectPath: 'p',
      fileName: 'a.pdf',
      uploadUrl: 'https://storage/upload',
    });
    const controller = new AbortController();
    const pending = signaturesService.uploadForSigning(
      new File(['x'], 'a.pdf', { type: 'application/pdf' }),
      LAW_FIRM_ID,
      { signal: controller.signal },
    );
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(UploadCancelledError);
  });

  it('sends a PDF straight to storage: init, one chunk, finalize', async () => {
    const objectPath = 'signing-uploads/firm-1/abc123/a.pdf';
    api.post('/signing/upload-init', {
      objectPath, fileName: 'a.pdf', uploadUrl: 'https://storage.googleapis.com/upload/sig-1',
    });
    api.post('/signing/upload-finalize', { objectPath, fileName: 'a.pdf' });
    xhr.on('PUT', 'sig-1', { status: 200 });

    const result = await signaturesService.uploadForSigning(
      new File(['x'], 'a.pdf', { type: 'application/pdf' }), LAW_FIRM_ID,
    );

    // Init declares the file so the route can refuse it before a byte moves.
    const init = api.callsTo('/signing/upload-init')[0];
    expect(bodyOf(init)).toEqual({ lawFirmId: LAW_FIRM_ID, name: 'a.pdf', size: 1, contentType: 'application/pdf' });

    // The bytes go to the session url with NO credential: it is already signed,
    // and an Authorization header would hand the firm's token to storage.
    const [put] = xhr.calls('PUT');
    expect(put.url).toBe('https://storage.googleapis.com/upload/sig-1');
    expect(put.headers.authorization).toBeUndefined();
    expect(put.headers['content-type']).toBe('application/pdf');
    expect(put.headers['content-range']).toBe('bytes 0-0/1');

    // Finalize names the path init handed back, and its answer is the result.
    expect(bodyOf(api.callsTo('/signing/upload-finalize')[0])).toEqual({ lawFirmId: LAW_FIRM_ID, objectPath });
    expect(result).toEqual({ objectPath, fileName: 'a.pdf' });

    // Nothing went through the converting route.
    expect(api.callsTo('/signing/upload')).toHaveLength(0);
  });

  it('surfaces a refused init instead of uploading anything', async () => {
    api.post('/signing/upload-init', {
      status: 413, body: { error: 'larger than the 100 MB limit', code: 'FILE_TOO_LARGE' },
    });

    await expect(signaturesService.uploadForSigning(
      new File(['x'], 'a.pdf', { type: 'application/pdf' }), LAW_FIRM_ID,
    )).rejects.toThrow(/100 MB limit/i);

    expect(xhr.calls('PUT')).toHaveLength(0);
    expect(api.callsTo('/signing/upload-finalize')).toHaveLength(0);
  });

  it('reports an expired session and does not finalize', async () => {
    api.post('/signing/upload-init', {
      objectPath: 'signing-uploads/firm-1/abc/a.pdf', fileName: 'a.pdf',
      uploadUrl: 'https://storage.googleapis.com/upload/sig-1',
    });
    xhr.on('PUT', 'sig-1', { status: 403 });

    // A 403 from the session url is the session being gone, and finalizing an
    // object that never landed would only turn one clear error into a 404.
    await expect(signaturesService.uploadForSigning(
      new File(['x'], 'a.pdf', { type: 'application/pdf' }), LAW_FIRM_ID,
    )).rejects.toThrow(/upload link expired/i);

    expect(api.callsTo('/signing/upload-finalize')).toHaveLength(0);
  });

  it('surfaces a refused finalize', async () => {
    api.post('/signing/upload-init', {
      objectPath: 'signing-uploads/firm-1/abc/a.pdf', fileName: 'a.pdf',
      uploadUrl: 'https://storage.googleapis.com/upload/sig-1',
    });
    api.post('/signing/upload-finalize', { status: 400, body: { error: 'The uploaded file is not a PDF.' } });
    xhr.on('PUT', 'sig-1', { status: 200 });

    await expect(signaturesService.uploadForSigning(
      new File(['x'], 'a.pdf', { type: 'application/pdf' }), LAW_FIRM_ID,
    )).rejects.toThrow(/not a PDF/i);
  });

  describe('a signing upload that outlives the page', () => {
    const OBJECT_PATH = 'signing-uploads/firm-1/abc123/a.pdf';
    const SESSION_URL = 'https://storage.googleapis.com/upload/sig-1';

    /** A PDF with a fixed mtime, so a spec can build a twin of it. */
    const pdf = (body = 'abcd', name = 'a.pdf') =>
      new File([body], name, { type: 'application/pdf', lastModified: 1_700_000_000_000 });

    function arrangeInit(over: Record<string, unknown> = {}) {
      api.post('/signing/upload-init', {
        objectPath: OBJECT_PATH, fileName: 'a.pdf', uploadUrl: SESSION_URL, ...over,
      });
    }

    async function waitFor(condition: () => boolean, turns = 500) {
      for (let i = 0; i < turns && !condition(); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    }

    it('reports progress while the bytes move and 100 only once finalized', async () => {
      arrangeInit();
      api.post('/signing/upload-finalize', { objectPath: OBJECT_PATH, fileName: 'a.pdf' });
      xhr.on('PUT', 'sig-1', { status: 200, progress: [{ loaded: 2, total: 4 }] });
      const seen: number[] = [];

      await signaturesService.uploadForSigning(pdf(), LAW_FIRM_ID, {
        onProgress: (percent) => seen.push(percent),
      });

      // A signing upload showed an indeterminate spinner for the whole of a
      // 90 MB scan, so the user could not tell a slow upload from a stuck one
      // and cancelled a working transfer. The scripted transfer reports 2 of 4
      // bytes sent, so 50 is what has to arrive DURING it: asserting only that
      // something was reported, or only that it ended at 100, is satisfied by
      // the single call made after finalize and proves nothing about the bar.
      expect(seen).toEqual([50, 99, 100]);
    });

    it('remembers the session BEFORE the first byte, so a refresh can resume', async () => {
      arrangeInit();
      api.post('/signing/upload-finalize', { objectPath: OBJECT_PATH, fileName: 'a.pdf' });
      let sawDescriptor = false;
      xhr.on('PUT', 'sig-1', () => {
        sawDescriptor = Object.keys(window.localStorage)
          .some((k) => k.startsWith('plx:upload-session:')
            && String(window.localStorage.getItem(k)).includes(SESSION_URL));
        return { status: 200 };
      });

      await signaturesService.uploadForSigning(pdf(), LAW_FIRM_ID);

      // Saved after the bytes would be no use at all: the window in which a
      // refresh loses the upload is exactly the window in which they are in
      // flight.
      expect(sawDescriptor).toBe(true);
    });

    it('resumes after a refresh instead of opening a second session', async () => {
      const file = pdf();
      // First page load: init, then the tab is closed mid-transfer.
      arrangeInit();
      xhr.on('PUT', 'sig-1', { networkError: true });
      await signaturesService.uploadForSigning(file, LAW_FIRM_ID, {
        // One attempt, so the spec is not waiting out a real backoff schedule.
        retryDelaysMs: [],
      }).catch(() => {});
      api.reset();
      xhr.restore();
      xhr = installXhrMock();

      // Second page load: the same document picked again.
      api.post('/signing/upload-finalize', { objectPath: OBJECT_PATH, fileName: 'a.pdf' });
      xhr.on('PUT', 'sig-1', (call) => (
        call.headers['content-range'] === 'bytes */4'
          ? { status: 308, headers: { Range: 'bytes=0-1' } }
          : { status: 200 }
      ));

      const result = await signaturesService.uploadForSigning(pdf(), LAW_FIRM_ID);

      // A second init mints a NEW transient object, so the bytes already in
      // storage are abandoned and the whole document is sent again. On a 90 MB
      // scan over a firm's uplink that is minutes, twice.
      expect(api.callsTo('/signing/upload-init')).toHaveLength(0);
      const data = xhr.calls('PUT').filter((c) => !/^bytes \*\//.test(c.headers['content-range'] || ''));
      expect(data.map((c) => c.headers['content-range'])).toEqual(['bytes 2-3/4']);
      expect(result.objectPath).toBe(OBJECT_PATH);
    });

    it('forgets the session once the API has vouched for it', async () => {
      arrangeInit();
      api.post('/signing/upload-finalize', { objectPath: OBJECT_PATH, fileName: 'a.pdf' });
      xhr.on('PUT', 'sig-1', { status: 200 });

      await signaturesService.uploadForSigning(pdf(), LAW_FIRM_ID);

      // A finalized session cannot take another byte. Keeping the descriptor
      // makes the NEXT upload of the same document skip init and PUT into a
      // finished object.
      expect(Object.keys(window.localStorage).filter((k) => k.startsWith('plx:upload-session:')))
        .toHaveLength(0);
    });

    it('KEEPS the session when every retry is spent, and says so', async () => {
      arrangeInit();
      xhr.on('PUT', 'sig-1', { status: 503 });

      await expect(signaturesService.uploadForSigning(pdf(), LAW_FIRM_ID, { retryDelaysMs: [0, 0] }))
        .rejects.toThrow(/could not be uploaded to storage/i);

      // A 503 is transient, so the session is still worth resuming. Discarding
      // it turns a retry into a fresh upload from byte zero.
      expect(Object.keys(window.localStorage).filter((k) => k.startsWith('plx:upload-session:')))
        .toHaveLength(1);
      expect(api.callsTo('/signing/upload-finalize')).toHaveLength(0);
    });

    it('reopens a session that died between page loads', async () => {
      const file = pdf();
      arrangeInit();
      xhr.on('PUT', 'sig-1', { networkError: true });
      await signaturesService.uploadForSigning(file, LAW_FIRM_ID, { retryDelaysMs: [] }).catch(() => {});
      api.reset();
      xhr.restore();
      xhr = installXhrMock();

      // The remembered session has expired on the GCS side in the meantime.
      const secondPath = 'signing-uploads/firm-1/def456/a.pdf';
      api.post('/signing/upload-init', {
        objectPath: secondPath, fileName: 'a.pdf',
        uploadUrl: 'https://storage.googleapis.com/upload/sig-2',
      });
      api.post('/signing/upload-finalize', { objectPath: secondPath, fileName: 'a.pdf' });
      xhr.on('PUT', 'sig-1', { status: 410 });
      xhr.on('PUT', 'sig-2', { status: 200 });

      const result = await signaturesService.uploadForSigning(pdf(), LAW_FIRM_ID);

      // "The upload link expired" for something the user did not do just now is
      // an error about the app's own bookkeeping. It reopens instead.
      expect(api.callsTo('/signing/upload-init')).toHaveLength(1);
      expect(result.objectPath).toBe(secondPath);
    });

    it('stops on cancellation without finalizing', async () => {
      const controller = new AbortController();
      arrangeInit();
      xhr.on('PUT', 'sig-1', () => {
        controller.abort();
        return { aborted: true };
      });

      await expect(signaturesService.uploadForSigning(pdf('abcdefgh'), LAW_FIRM_ID, {
        signal: controller.signal,
        chunkSize: 4,
      })).rejects.toBeInstanceOf(UploadCancelledError);

      // Finalizing what the user cancelled admits a half-written object as a
      // document to be signed, and the refusal that follows blames the file.
      expect(api.callsTo('/signing/upload-finalize')).toHaveLength(0);
    });

    it('does not share a session with another tab', async () => {
      const file = pdf();
      arrangeInit();
      xhr.on('PUT', 'sig-1', { networkError: true });
      await signaturesService.uploadForSigning(file, LAW_FIRM_ID, { retryDelaysMs: [] }).catch(() => {});
      api.reset();
      xhr.restore();
      xhr = installXhrMock();

      locks.holdElsewhere();
      const secondPath = 'signing-uploads/firm-1/def456/a.pdf';
      api.post('/signing/upload-init', {
        objectPath: secondPath, fileName: 'a.pdf',
        uploadUrl: 'https://storage.googleapis.com/upload/sig-2',
      });
      api.post('/signing/upload-finalize', { objectPath: secondPath, fileName: 'a.pdf' });
      xhr.on('PUT', 'sig-2', { status: 200 });

      await signaturesService.uploadForSigning(pdf(), LAW_FIRM_ID);

      // Two tabs PUTting into one session from the same offset interleave their
      // bytes, and the document that reaches the signer is corrupt with nothing
      // on either screen to say so.
      expect(api.callsTo('/signing/upload-init')).toHaveLength(1);
    });

    it('does not resume a session opened for different bytes', async () => {
      const first = pdf('abcd');
      arrangeInit();
      xhr.on('PUT', 'sig-1', { networkError: true });
      await signaturesService.uploadForSigning(first, LAW_FIRM_ID, { retryDelaysMs: [] }).catch(() => {});
      api.reset();
      xhr.restore();
      xhr = installXhrMock();

      const secondPath = 'signing-uploads/firm-1/def456/a.pdf';
      api.post('/signing/upload-init', {
        objectPath: secondPath, fileName: 'a.pdf',
        uploadUrl: 'https://storage.googleapis.com/upload/sig-2',
      });
      api.post('/signing/upload-finalize', { objectPath: secondPath, fileName: 'a.pdf' });
      xhr.on('PUT', 'sig-2', { status: 200 });

      // Same name, same length, same mtime, different document.
      await signaturesService.uploadForSigning(pdf('wxyz'), LAW_FIRM_ID);

      // Resuming across this would append the second document's tail to the
      // first document's head and send THAT for signature.
      expect(api.callsTo('/signing/upload-init')).toHaveLength(1);
    });

    it('waits for a free upload slot before sending bytes', async () => {
      let releaseFirst!: () => void;
      let releaseSecond!: () => void;
      const held = [
        runWithUploadLimit(() => new Promise<void>((r) => { releaseFirst = r; })),
        runWithUploadLimit(() => new Promise<void>((r) => { releaseSecond = r; })),
      ];
      arrangeInit();
      api.post('/signing/upload-finalize', { objectPath: OBJECT_PATH, fileName: 'a.pdf' });
      xhr.on('PUT', 'sig-1', { status: 200 });

      const upload = signaturesService.uploadForSigning(pdf(), LAW_FIRM_ID);
      try {
        await waitFor(() => api.callsTo('/signing/upload-init').length === 1);
        for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 1));

        // A document sent for signature and a batch dropped on the files page
        // share one uplink, so they share one gate. Counting them separately
        // would let four run and defeat the cap.
        expect(xhr.calls('PUT')).toHaveLength(0);
      } finally {
        releaseFirst();
        releaseSecond();
        await Promise.all(held);
        await upload.catch(() => {});
      }

      expect(xhr.calls('PUT')).toHaveLength(1);
    });
  });

  it('recognises a PDF by its type when the name has no extension', async () => {
    const objectPath = 'signing-uploads/firm-1/abc/scan';
    api.post('/signing/upload-init', {
      objectPath, fileName: 'scan', uploadUrl: 'https://storage.googleapis.com/upload/sig-1',
    });
    api.post('/signing/upload-finalize', { objectPath, fileName: 'scan' });
    xhr.on('PUT', 'sig-1', { status: 200 });

    await signaturesService.uploadForSigning(new File(['x'], 'scan', { type: 'application/pdf' }), LAW_FIRM_ID);

    expect(api.callsTo('/signing/upload-init')).toHaveLength(1);
  });
});

describe('signing templates', () => {
  it('lists templates from the firm signing-templates route', async () => {
    api.get('/signing-templates', { templates: [] });

    await signaturesService.listSigningTemplates(LAW_FIRM_ID);

    expect(api.calls('GET')[0].pathname)
      .toMatch(new RegExp(`/lawfirms/${LAW_FIRM_ID}/signing-templates$`));
  });

  it('reads one template by id, ENCODED', async () => {
    api.get('/signing-templates/tpl%2F3', { template: { templateId: 'tpl/3' } });

    await signaturesService.getSigningTemplate(LAW_FIRM_ID, 'tpl/3');

    expect(api.calls('GET')[0].pathname).toMatch(/\/signing-templates\/tpl%2F3$/);
  });

  it('creates a template with its fields and roles IN ORDER', async () => {
    api.post('/signing-templates', { template: { templateId: TEMPLATE_ID } });

    await signaturesService.createSigningTemplate(LAW_FIRM_ID, {
      name: 'Engagement letter',
      fields: FIELDS,
      signerRoles: [
        { roleLabel: 'Client', order: 1, deliveryMethod: 'email' },
        { roleLabel: 'Managing Partner', order: 2, deliveryMethod: 'internal_dashboard' },
      ],
      routingMode: 'sequential',
    });

    const body = bodyOf(api.calls('POST')[0]);
    // A template is a saved layout reused for every future send, so a mis-ordered
    // role list keeps producing the wrong routing until someone notices.
    expect((body.signerRoles as Array<{ roleLabel: string }>).map((r) => r.roleLabel))
      .toEqual(['Client', 'Managing Partner']);
    expect((body.fields as SignatureField[]).map((f) => f.signerId))
      .toEqual(['p-client', 'p-partner']);
    expect(body.routingMode).toBe('sequential');
  });

  it('updates with PUT on the template url and deletes with DELETE', async () => {
    api.put(`/signing-templates/${TEMPLATE_ID}`, { template: { templateId: TEMPLATE_ID } });
    api.delete(`/signing-templates/${TEMPLATE_ID}`, { success: true });

    await signaturesService.updateSigningTemplate(LAW_FIRM_ID, TEMPLATE_ID, { name: 'Renamed' });
    await signaturesService.deleteSigningTemplate(LAW_FIRM_ID, TEMPLATE_ID);

    // Same url, and the verb is all that separates a rename from removing a
    // layout the whole firm sends from.
    expect(api.calls('PUT')[0].pathname).toMatch(/\/signing-templates\/tpl-3$/);
    expect(api.calls('DELETE')[0].pathname).toMatch(/\/signing-templates\/tpl-3$/);
    expect(api.calls('DELETE')[0].body).toBeNull();
  });

  it('sends only the changed keys on a partial update', async () => {
    api.put(`/signing-templates/${TEMPLATE_ID}`, { template: { templateId: TEMPLATE_ID } });

    await signaturesService.updateSigningTemplate(LAW_FIRM_ID, TEMPLATE_ID, { name: 'Renamed' });

    // Padding the body with an empty `fields` array would wipe the saved layout
    // on a rename.
    expect(Object.keys(bodyOf(api.calls('PUT')[0]))).toEqual(['name']);
  });

  it('throws when a template read is refused', async () => {
    api.get('/signing-templates', { status: 403, body: { error: 'Forbidden' } });

    // An empty template grid and a forbidden one must not look the same.
    await expect(signaturesService.listSigningTemplates(LAW_FIRM_ID)).rejects.toBeDefined();
  });
});
