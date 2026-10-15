const crypto = require('crypto');
const repo = require('./signatures.repository');
// Shared timestamp coercion (consolidated module-wide helper).
const { toIso, toMs } = require('./timeUtils');

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function createId(bytes = 12) {
  return crypto.randomBytes(bytes).toString('hex');
}

// `ts` is kept as a thin alias to the shared `toIso` so its importers
// (signatureLinks.routes) stay unchanged.
export const ts = toIso;

export function isPdfFileName(name = '') {
  return name.toLowerCase().endsWith('.pdf');
}

export function toPdfFileName(name = 'document') {
  return /\.[^.]+$/.test(name) ? name.replace(/\.[^.]+$/, '.pdf') : `${name}.pdf`;
}

export function isSessionExpired(data: any) {
  if (!data?.expiresAt) return false;
  const expiresMs = toMs(data.expiresAt);
  return expiresMs > 0 && Date.now() > expiresMs;
}

export function maskEmail(email: any) {
  if (!email || !email.includes('@')) return '';
  const [local, domain] = email.split('@');
  return `${local[0] || ''}***@${domain}`;
}

export function hashAccessCode(code: any) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function normalizeDeliveryMethod(method: any) {
  switch (method) {
    case 'portal':
    case 'internal_dashboard':
    case 'internal_email':
    case 'in_person':
    case 'copy_link':
    case 'email':
      return method;
    default:
      return 'email';
  }
}

/**
 * Give every signer a participant id minted here, and repoint each field's
 * `signerId` from the id the client sent to the one minted for that signer.
 *
 * A participant id is a row key, unique across every session of every firm,
 * and a client's id is only its name for a signer within one request: the
 * placer mints draft ids in the browser and reuses them when a session is sent
 * from a saved template. Trusting them made the second send of a template
 * collide with the first. Callers reject a request whose signers share an id
 * before this runs, so the mapping is one to one. A field whose signerId names
 * no signer keeps it unchanged.
 */
export function assignServerParticipantIds(signers: any, fields: any) {
  if (!Array.isArray(signers) || signers.length === 0) return { signers, fields };
  const serverIdFor = new Map<string, string>();
  const ownSigners = signers.map((signer: any) => {
    const participantId = createId(10);
    if (typeof signer?.participantId === 'string' && signer.participantId) {
      serverIdFor.set(signer.participantId, participantId);
    }
    return { ...signer, participantId };
  });
  const ownFields = Array.isArray(fields)
    ? fields.map((field: any) => (serverIdFor.has(field?.signerId)
      ? { ...field, signerId: serverIdFor.get(field.signerId) }
      : field))
    : fields;
  return { signers: ownSigners, fields: ownFields };
}

function buildParticipant(input: any = {}, index = 0, activeOrder = 1, routingMode = 'sequential') {
  const order = Number.isInteger(input.order) && input.order > 0 ? input.order : index + 1;
  const deliveryMethod = normalizeDeliveryMethod(input.deliveryMethod);
  const accessCode = typeof input.accessCode === 'string' ? input.accessCode.trim() : '';
  const normalizedRoutingMode = routingMode === 'parallel' ? 'parallel' : 'sequential';

  return {
    // Already minted by assignServerParticipantIds for a signers[] request;
    // the single-recipient routes supply none, so one is minted here.
    participantId: input.participantId || createId(10),
    roleLabel: (input.roleLabel || input.role || `Signer ${index + 1}`).trim(),
    order,
    deliveryMethod,
    name: input.name?.trim() || null,
    email: input.email?.trim() || null,
    memberUserId: input.memberUserId || null,
    clientUserId: input.clientUserId || null,
    status: normalizedRoutingMode === 'parallel' ? 'active' : (order === activeOrder ? 'active' : 'waiting'),
    accessCodeHash: accessCode ? hashAccessCode(accessCode) : null,
    accessCodeVerified: false,
    accessCodeLock: null,
    startedAt: null,
    completedAt: null,
    consent: null,
    signerUid: null,
    signerName: null,
    signerIp: null,
    facilitatedBy: null,
    fieldValues: null,
    workingObjectPath: input.workingObjectPath || null,
    lastReminderSentAt: input.lastReminderSentAt || null,
    reminderCount: input.reminderCount || 0,
  };
}

/**
 * Normalize a session's signers into participant records.
 *
 * `soleRecipient` covers the single-signer routes (`/signature-links/send-email`),
 * which name one recipient directly instead of supplying a `signers` array. It is
 * used only when `signers` is empty.
 */
export function buildParticipants(signers: any[] = [], soleRecipient: any = {}, routingMode = 'sequential') {
  const source = Array.isArray(signers) && signers.length > 0
    ? signers
    : [{
        roleLabel: soleRecipient.roleLabel || 'Signer',
        order: 1,
        deliveryMethod: soleRecipient.deliveryMethod || (soleRecipient.clientId ? 'portal' : 'email'),
        name: soleRecipient.recipientName || null,
        email: soleRecipient.recipientEmail || null,
        clientUserId: soleRecipient.clientId || null,
        accessCode: soleRecipient.accessCode || null,
      }];

  const orders = source
    .map((signer, index) => (Number.isInteger(signer.order) && signer.order > 0 ? signer.order : index + 1))
    .sort((a, b) => a - b);
  const activeOrder = orders[0] || 1;

  return source
    .map((signer, index) => buildParticipant(signer, index, activeOrder, routingMode))
    .sort((a, b) => a.order - b.order);
}

function buildSessionRecord({
  sourceId,
  preparedObjectPath,
  fileName,
  fields,
  lawFirmId,
  createdBy,
  destinationFolderId,
  destinationLabel,
  clientId,
  notifyEmail,
  notifyName,
  documentHash,
  signers,
  routingMode,
  soleRecipientName,
  soleRecipientEmail,
  accessCode,
  emailSignersOnComplete,
}: any) {
  const normalizedRoutingMode = routingMode === 'parallel' ? 'parallel' : 'sequential';
  const assigned = assignServerParticipantIds(signers, fields);
  const participants = buildParticipants(assigned.signers, {
    recipientName: soleRecipientName,
    recipientEmail: soleRecipientEmail,
    clientId,
    accessCode,
  }, normalizedRoutingMode);
  const activeParticipant = participants.find((participant) => participant.status === 'active') || participants[0] || null;
  const activeOrder = normalizedRoutingMode === 'parallel' ? null : (activeParticipant?.order || null);

  return {
    routingMode: normalizedRoutingMode,
    // The admitted source this session was built from. Recorded here rather
    // than claimed later, so finalization reads the PREPARED copy and its saved
    // hash state instead of pinning the upload and streaming it again.
    sourceId,
    objectPath: preparedObjectPath,
    workingObjectPath: preparedObjectPath,
    finalObjectPath: null,
    fileName,
    fields: assigned.fields || null,
    participants,
    lawFirmId,
    createdBy,
    destinationFolderId: destinationFolderId || null,
    destinationLabel: destinationLabel || null,
    status: 'pending',
    currentSignerOrder: activeOrder,
    documentHash,
    signedDocumentHash: null,
    notifyEmail: notifyEmail || null,
    notifyName: notifyName || null,
    emailSignersOnComplete: !!emailSignersOnComplete,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  };
}

export async function createSigningSession({
  sourceId,
  preparedObjectPath,
  fileName,
  fields,
  lawFirmId,
  createdBy,
  destinationFolderId,
  destinationLabel,
  clientId,
  notifyEmail,
  notifyName,
  documentHash,
  signers,
  routingMode,
  soleRecipientName,
  soleRecipientEmail,
  accessCode,
  emailSignersOnComplete,
}: any) {
  const sessionId = createId(24);
  const sessionRecord = buildSessionRecord({
    sourceId,
    preparedObjectPath,
    fileName,
    fields,
    lawFirmId,
    createdBy,
    destinationFolderId,
    destinationLabel,
    clientId,
    notifyEmail,
    notifyName,
    documentHash,
    signers,
    routingMode,
    soleRecipientName,
    soleRecipientEmail,
    accessCode,
    emailSignersOnComplete,
  });

  const publicTokens: Record<string, any> = {};
  const participantsWithTokens = sessionRecord.participants.map((participant) => {
    const publicToken = createId(24);
    publicTokens[participant.participantId] = publicToken;
    return { ...participant, publicToken };
  });

  await repo.createSession({
    token: sessionId,
    sessionRecord,
    participantsWithTokens,
    fields: sessionRecord.fields,
  });

  const recordWithTokens = {
    ...sessionRecord,
    participants: participantsWithTokens,
  };
  const firstActiveParticipant = recordWithTokens.participants.find((participant) => participant.status === 'active') || null;

  return {
    sessionId,
    sessionRecord: recordWithTokens,
    publicTokens,
    firstParticipantToken: firstActiveParticipant ? publicTokens[firstActiveParticipant.participantId] : null,
  };
}

export function getParticipantById(data: any, participantId: string) {
  return (data?.participants || []).find((participant: any) => participant.participantId === participantId) || null;
}

export function getParticipantForUser(data: any, userId: string) {
  if (!userId) return null;
  return (data?.participants || []).find(
    (participant: any) => participant.memberUserId === userId || participant.clientUserId === userId
  ) || null;
}

export function getActiveParticipant(data: any) {
  return (data?.participants || []).find((participant: any) => participant.status === 'active') || null;
}

export function getNextWaitingParticipant(data: any) {
  return (data?.participants || [])
    .filter((participant: any) => participant.status === 'waiting')
    .sort((a: any, b: any) => a.order - b.order)[0] || null;
}

// In-memory array transform: used by routes to compute the next participants[]
// state before persisting it via the repo.
export function updateParticipant(data: any, participantId: string, updater: any) {
  return (data?.participants || []).map((participant: any) => {
    if (participant.participantId !== participantId) return participant;
    return typeof updater === 'function'
      ? updater(participant)
      : { ...participant, ...updater };
  });
}

export function getSessionProgress(data: any) {
  const participants = data?.participants || [];
  const completedParticipants = participants.filter((participant: any) => participant.status === 'completed');
  return {
    totalParticipants: participants.length,
    completedParticipants: completedParticipants.length,
    currentParticipant: getActiveParticipant(data),
  };
}

/**
 * A thin session reference exposing the small surface the routes use today:
 *   .id        -> the session token
 *   .update()  -> repo.updateSession(token, patch)  (supports dotted paths)
 *   .delete()  -> repo.deleteSession(token)
 * This keeps the ~47 call sites (`resolved.sessionRef.update(...)`) unchanged.
 */
export function makeSessionRef(token: any) {
  return {
    id: token,
    get token() { return token; },
    update: (patch: any) => repo.updateSession(token, patch),
    delete: () => repo.deleteSession(token),
  };
}

export async function resolveSigningContext(token: any, userId: string) {
  const directSessionData = await repo.getSessionByToken(token);
  if (directSessionData) {
    const participant = getParticipantForUser(directSessionData, userId);
    return {
      sessionId: token,
      sessionRef: makeSessionRef(token),
      sessionData: directSessionData,
      participant,
      participantToken: null,
    };
  }

  const sessionData = await repo.getSessionByParticipantToken(token);
  if (!sessionData) return null;

  const sessionId = sessionData.token;

  // Find the participant whose public token equals the resolved token.
  const participant = (sessionData.participants || []).find((p: any) => p.publicToken === token) || null;

  return {
    sessionId,
    sessionRef: makeSessionRef(sessionId),
    sessionData,
    participant,
    participantToken: token,
  };
}

/**
 * Force-cancel ONE participant's slot within a session - used by the
 * CLIENT_DELETED cleanup (signatures.events.ts), not the public /decline
 * endpoint. A /decline is an active refusal by the signer themselves, which
 * this codebase already treats as terminal for the WHOLE session (see the
 * `/decline` route in signing.routes.ts). A deleted client's account
 * disappearing is a different, administrative event: it should not, by
 * itself, kill a document the OTHER signers are still able to complete, so
 * this only ever touches the one slot unless nobody is left who can act.
 *
 * Runs inside `repo.runSessionTransaction` (locks the session + its
 * participants FOR UPDATE), so it composes safely with a concurrent
 * /complete or /decline on the same session the same way those two already
 * compose with each other.
 *
 * Sequential routing: if the cancelled participant held the active turn
 * (`routingMode !== 'parallel'` and their status was 'active'), the next
 * lowest-order 'waiting' participant is promoted to 'active' and
 * `currentSignerOrder` advances to them - mirrors the promotion `/complete`
 * already performs when a signer finishes their turn, so the session is
 * never left with zero actionable participants while someone else genuinely
 * could still act. A cancelled participant who was still 'waiting' (their
 * turn had not arrived yet) needs no promotion at all:
 * `getNextWaitingParticipant` only ever matches `status === 'waiting'`, so a
 * cancelled entry is already invisible to it once their turn does come around.
 *
 * Parallel routing has no "turn" to advance - every non-terminal participant
 * is independently 'active' from creation - so cancelling one never blocks
 * the others and no promotion is attempted.
 *
 * Last-pending case: if, after the cancellation (and any promotion), no
 * participant is left 'active' or 'waiting', the whole SESSION also moves to
 * 'cancelled' (matching what a full session cancel already leaves behind).
 * A signing session missing a required signer for good can never
 * legitimately reach 'completed', so leaving it 'pending'/'in_progress' with
 * nobody left who can act would just strand it - this is the same call the
 * `/decline` route already makes when a lone or final signer declines.
 *
 * Returns null when the participant is not found, is already terminal, or
 * the session itself is already terminal - a no-op, since the caller's list
 * of open slots is a snapshot that can race a concurrent transition (the
 * signer completing or declining moments before this runs).
 */
export async function cancelParticipantSlot(token: any, participantId: string) {
  return repo.runSessionTransaction(token, async (freshData: any, transaction: any) => {
    const participant = getParticipantById(freshData, participantId);
    if (!participant || ['completed', 'cancelled', 'declined', 'expired'].includes(participant.status)) {
      return null;
    }
    if (['completed', 'cancelled', 'expired'].includes(freshData.status)) {
      return null;
    }

    const wasActive = participant.status === 'active';
    const isSequential = freshData.routingMode !== 'parallel';
    const now = new Date().toISOString();

    await transaction.updateParticipant(participantId, { status: 'cancelled' });
    let participantsAfter = updateParticipant(freshData, participantId, { status: 'cancelled' });

    let promoted = null;
    if (isSequential && wasActive) {
      const next = getNextWaitingParticipant({ participants: participantsAfter });
      if (next) {
        promoted = next;
        const promotedStartedAt = next.startedAt || now;
        participantsAfter = updateParticipant({ participants: participantsAfter }, next.participantId, (entry: any) => ({
          ...entry,
          status: 'active',
          startedAt: promotedStartedAt,
        }));
        await transaction.updateParticipant(next.participantId, { status: 'active', startedAt: promotedStartedAt });
      }
    }

    const stillActionable = participantsAfter.some(
      (entry: any) => entry.status === 'active' || entry.status === 'waiting'
    );
    const sessionCancelled = !stillActionable;

    if (sessionCancelled) {
      await transaction.updateSession({ status: 'cancelled', currentSignerOrder: null });
    } else if (promoted) {
      await transaction.updateSession({ currentSignerOrder: promoted.order });
    }

    return {
      sessionCancelled,
      participant,
      promoted,
      sessionData: {
        ...freshData,
        participants: participantsAfter,
        status: sessionCancelled ? 'cancelled' : freshData.status,
      },
    };
  });
}
