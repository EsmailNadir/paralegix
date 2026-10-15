/**
 * Read URLs for a signing document, minted for one recipient and one version.
 *
 * A signer's document used to reach them as a stream out of this process: the
 * route authorized the caller, opened the object, and piped it through. That
 * puts a whole document in one instance's memory per viewer, on the instance
 * that is also sealing PDFs, and it does it again for every range the viewer
 * asks for.
 *
 * Handing the browser a signed URL removes all of that, and moves one problem:
 * the URL outlives the request that minted it, so it has to carry its own
 * limits. Three do the work here.
 *
 * THE GATE. Nothing is signed until the same checks the streaming route ran
 * have passed: the link resolves to a live session, the session has not
 * expired, the caller resolves to a PARTICIPANT (or to the sender facilitating
 * an in-person signer), that participant has cleared their access code, and it
 * is their turn. A URL minted before any of those is a bearer credential for a
 * legal document handed to someone who was never authorized.
 *
 * THE GENERATION. The URL names one version of the object. Without that, a
 * document replaced between authorization and download serves bytes nobody
 * authorized under a URL that was legitimately issued, and nothing reports it.
 * Where the session recorded which version it admitted, a mismatch is REFUSED
 * rather than re-pinned: re-pinning would hand out the new document silently,
 * which is the failure the recorded generation exists to catch.
 *
 * THE CLOCK. Minutes, not hours. Nothing revokes a URL already handed out, so
 * its lifetime is the whole of its revocation story, and the viewer asks for a
 * fresh one (through the gate again) when it runs out.
 */
import { AppError, ForbiddenError } from '../../shared/errors/AppError';
import { SourceRefused } from './signingSources';

const { admin } = require('../../shared/database/firebase');
const repo = require('./signatures.repository');
const {
  isSessionExpired,
  resolveSigningContext,
  getActiveParticipant,
} = require('./signingSessions');

const BUCKET_NAME = process.env.GCS_BUCKET || 'lawfirms';

/**
 * Resolved on first use rather than at import, so requiring this module does
 * not depend on storage credentials being loadable.
 */
let cachedBucket: any = null;
function bucket() {
  if (!cachedBucket) cachedBucket = admin.storage().bucket(BUCKET_NAME);
  return cachedBucket;
}

/**
 * How long a minted URL is good for.
 *
 * Deliberately far shorter than the file module's hour: a signing URL needs no
 * credential to use, and the page holding it re-authorizes cheaply.
 */
export const SIGNING_READ_URL_TTL_MS = 5 * 60 * 1000;

export interface SigningReadUrl {
  url: string;
  /** The object version this URL can serve, and no other. */
  generation: string;
  objectPath: string;
  fileName: string;
  contentType: string;
  expiresAt: string;
}

/**
 * How long a DELIVERY link is good for.
 *
 * Days rather than the five minutes a viewer's link gets, and the difference is
 * the medium. A viewer holds a page that can ask for a fresh URL; an emailed
 * link is read whenever the recipient opens their mail, and one that expires
 * before then is a delivery that did not happen. Seven days is the ceiling a v4
 * signed URL can carry at all, and it is chosen deliberately: the link names one
 * immutable generation of one artifact, so its whole exposure is a copy of the
 * document its holder was already entitled to receive as an attachment.
 */
export const SIGNING_DELIVERY_URL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A download link for one completed participant's copy of one executed artifact.
 *
 * This is the capability that replaces attaching a large document to an email.
 * It deliberately does NOT go through the signing gate above: that gate asks
 * whether it is this participant's turn to SIGN, and reopening it so a finished
 * signer can fetch their copy would make every completed session signable again.
 * What is checked instead is what actually entitles someone to the executed
 * document: the session finished, and this participant is one of the people who
 * signed it.
 *
 * The generation is pinned on the handle, so the link serves the exact bytes
 * that were sealed and nothing that later lands at the same path.
 */
export async function mintSigningArtifactUrl(options: {
  lawFirmId: string;
  token: string;
  participantId: string;
  objectPath: string;
  fileName?: string;
  disposition?: 'inline' | 'attachment';
}): Promise<SigningReadUrl> {
  const { lawFirmId, token, participantId, objectPath, disposition = 'attachment' } = options;

  const sessionData = await repo.getSessionByToken(token);
  if (!sessionData || sessionData.lawFirmId !== lawFirmId) {
    throw new AppError('Signing session not found', 404, 'NOT_FOUND');
  }
  if (sessionData.status !== 'completed') {
    throw new ForbiddenError('This document is not finished yet');
  }

  const participant = (sessionData.participants || [])
    .find((entry: any) => entry.participantId === participantId);
  if (!participant || participant.status !== 'completed') {
    throw new ForbiddenError('You do not have access to this document');
  }

  // The artifact has to be one THIS session published. Without this the caller
  // chooses the path, and a completed participant becomes a way to read any
  // object in the bucket.
  const published = [sessionData.finalObjectPath, sessionData.signedObjectPath]
    .filter(Boolean);
  if (!published.includes(objectPath)) {
    throw new ForbiddenError('You do not have access to this document');
  }

  const handle = bucket().file(objectPath);
  const [exists] = await handle.exists();
  if (!exists) throw new AppError('File no longer exists', 404, 'NOT_FOUND');
  const [metadata] = await handle.getMetadata();
  const generation = String(metadata.generation ?? '');
  if (!generation) {
    throw new SourceRefused('SOURCE_CHANGED', `${objectPath} reported no generation.`);
  }

  const fileName = options.fileName || sessionData.fileName || 'document.pdf';
  const expires = Date.now() + SIGNING_DELIVERY_URL_TTL_MS;
  const [url] = await bucket().file(objectPath, { generation }).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires,
    responseDisposition: `${disposition}; filename="${encodeURIComponent(fileName)}"`,
  });

  return {
    url,
    generation,
    objectPath,
    fileName,
    contentType: metadata.contentType || 'application/pdf',
    expiresAt: new Date(expires).toISOString(),
  };
}

/**
 * The participant a link speaks for, or none.
 *
 * A participant token resolves to its own participant directly. The one other
 * way to hold a link legitimately is facilitated signing: the sender, in the
 * room, working the device for an in-person signer. Everything else, including
 * a firm member who can see the session in the app, resolves to nobody: the
 * signing link is the recipient's, not the firm's.
 */
export function resolveAuthorizedParticipant(resolved: any, userId: string | null) {
  if (resolved.participant) {
    return { participant: resolved.participant, facilitatedSigning: false };
  }

  const activeParticipant = getActiveParticipant(resolved.sessionData);
  if (
    userId
    && resolved.sessionData.createdBy === userId
    && activeParticipant
    && activeParticipant.deliveryMethod === 'in_person'
  ) {
    return { participant: activeParticipant, facilitatedSigning: true };
  }

  return { participant: null, facilitatedSigning: false };
}

/**
 * The version of `objectPath` the session admitted, or null when it never
 * recorded one.
 *
 * Only the source's two objects have a recorded version: the admitted upload
 * and the flattened copy the signer views. A participant's working copy is
 * written by this system for this session and is replaced by it, so there is no
 * earlier version to compare against and pinning the current one is the whole
 * of the guarantee.
 */
async function authorizedGenerationFor(sessionData: any, objectPath: string): Promise<string | null> {
  // Keyed off the session's admitted object path rather than its source id: the
  // session graph the routes read does not carry the id, and the path is unique
  // per firm by constraint, so the lookup lands on exactly one source.
  if (!sessionData?.lawFirmId || !sessionData?.objectPath) return null;
  const source = await repo.getSourceByObjectPath(sessionData.lawFirmId, sessionData.objectPath);
  if (!source) return null;
  if (source.objectPath === objectPath) return source.objectGeneration;
  if (source.preparedObjectPath === objectPath) return source.preparedGeneration;
  return null;
}

/**
 * Authorize a signing link, then mint a read URL for exactly what it may read.
 *
 * Throws rather than returning a refusal, so a caller cannot forget to check:
 * every path out of here either produces a URL or produces the error a route
 * would have returned.
 */
/**
 * A short-lived read url for an object an authenticated caller may preview.
 *
 * The authorization is the caller's and has already been decided by the route:
 * the uploader's own stamp for a signing upload, firm membership plus matter
 * access for a firm document. This pins the generation and signs it, so a route
 * that used to stream the object through the API hands out a link the viewer
 * reads by range instead.
 *
 * There is no session here, so there is no authorized generation to compare
 * against. What pinning still buys is that the url names the version that
 * existed when the caller was authorized, and cannot serve a later one.
 */
export async function mintPreviewReadUrl(options: {
  objectPath: string;
  fileName: string;
}): Promise<SigningReadUrl & { sizeBytes: number }> {
  const { objectPath, fileName } = options;

  const handle = bucket().file(objectPath);
  const [exists] = await handle.exists();
  if (!exists) throw new AppError('File no longer exists', 404, 'NOT_FOUND');

  const [metadata] = await handle.getMetadata();
  const generation = String(metadata.generation ?? '');
  if (!generation) {
    throw new SourceRefused('SOURCE_CHANGED', `${objectPath} reported no generation.`);
  }
  const contentType = metadata.contentType || 'application/pdf';
  const expires = Date.now() + SIGNING_READ_URL_TTL_MS;

  const [url] = await bucket().file(objectPath, { generation }).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires,
    responseDisposition: `inline; filename="${encodeURIComponent(fileName)}"`,
  });

  return {
    url,
    generation,
    objectPath,
    fileName,
    contentType,
    sizeBytes: Number(metadata.size || 0),
    expiresAt: new Date(expires).toISOString(),
  };
}

export async function mintSigningReadUrl(options: {
  token: string;
  userId?: string | null;
  /** `attachment` forces a download; the signer's viewer wants `inline`. */
  disposition?: 'inline' | 'attachment';
}): Promise<SigningReadUrl> {
  const { token, userId = null, disposition = 'inline' } = options;

  let resolved = await resolveSigningContext(token, userId);
  if (!resolved) {
    const completed = await repo.getCompletedSessionByParticipantToken(token);
    if (completed?.participant) {
      resolved = {
        sessionId: completed.sessionData.token,
        sessionData: completed.sessionData,
        participant: completed.participant,
        participantToken: token,
      };
    }
  }
  if (!resolved) throw new AppError('Signing session not found or expired', 404, 'NOT_FOUND');

  const sessionData = resolved.sessionData;
  if (isSessionExpired(sessionData)) {
    throw new AppError('This signing link has expired', 410, 'GONE');
  }

  const { participant } = resolveAuthorizedParticipant(resolved, userId);
  if (!participant) {
    throw new ForbiddenError('You do not have access to this document');
  }
  if (participant.accessCodeHash && !participant.accessCodeVerified) {
    throw new ForbiddenError('Access code verification required before accessing this document');
  }
  if (participant.status !== 'active') {
    if (participant.status === 'completed') {
      if (sessionData.status !== 'completed') {
        throw new ForbiddenError('This document is not finished yet');
      }
      const objectPath = sessionData.finalObjectPath || sessionData.signedObjectPath;
      if (!objectPath) {
        throw new AppError('File no longer exists', 404, 'NOT_FOUND');
      }
      return mintSigningArtifactUrl({
        lawFirmId: sessionData.lawFirmId,
        token: sessionData.token,
        participantId: participant.participantId,
        objectPath,
        fileName: sessionData.fileName,
        disposition,
      });
    }
    throw new ForbiddenError(participant.status === 'waiting'
      ? 'It is not your turn to sign yet'
      : 'This document is no longer editable for you');
  }

  const objectPath = participant.workingObjectPath
    || sessionData.workingObjectPath
    || sessionData.objectPath;
  if (!objectPath) {
    throw new AppError('File no longer exists', 404, 'NOT_FOUND');
  }

  const handle = bucket().file(objectPath);
  const [exists] = await handle.exists();
  if (!exists) {
    throw new AppError('File no longer exists', 404, 'NOT_FOUND');
  }
  const [metadata] = await handle.getMetadata();
  const generation = String(metadata.generation ?? '');
  if (!generation) {
    throw new SourceRefused('SOURCE_CHANGED', `${objectPath} reported no generation.`);
  }

  const authorized = await authorizedGenerationFor(sessionData, objectPath);
  if (authorized && authorized !== generation) {
    throw new SourceRefused(
      'SOURCE_CHANGED',
      `${objectPath} is now generation ${generation}, authorized at ${authorized}.`,
    );
  }

  const contentType = metadata.contentType || 'application/pdf';
  const fileName = sessionData.fileName || 'document.pdf';
  const expires = Date.now() + SIGNING_READ_URL_TTL_MS;

  // The generation goes on the HANDLE, which is what puts it in the signed
  // query string. Reading it into the response alone would report a version the
  // URL does not actually hold anyone to.
  const [url] = await bucket().file(objectPath, { generation }).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires,
    responseDisposition: `${disposition}; filename="${encodeURIComponent(fileName)}"`,
  });

  return {
    url,
    generation,
    objectPath,
    fileName,
    contentType,
    expiresAt: new Date(expires).toISOString(),
  };
}
