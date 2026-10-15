/**
 * The four reads the Signatures page opens with, as plain functions.
 *
 * Each one is the body of a standalone route (`GET /signature-links/sessions`,
 * `/sessions/summary`, `/pending-for-user` and `GET /signing-templates`), lifted
 * out so the combined `GET /signature-links/workspace` answers with exactly what
 * those routes answer instead of a second copy that could drift. The routes
 * call these too. Permission and plan gating stay on the routes.
 */
const repo = require('./signatures.repository');
const { getSessionProgress, ts } = require('./signingSessions');
const { toMs } = require('./timeUtils');
const { normalizeSignatureFields } = require('./fieldNormalization');

function getDisplaySignerName(sessionData: any, progress: any) {
  const participants = sessionData?.participants || [];
  const completedParticipants = participants
    .filter((participant: any) => participant.status === 'completed')
    .sort((a: any, b: any) => toMs(b.completedAt) - toMs(a.completedAt));

  const latestCompleted = completedParticipants[0] || null;
  return latestCompleted?.signerName
    || latestCompleted?.name
    || progress.currentParticipant?.signerName
    || progress.currentParticipant?.name
    || sessionData?.signerName
    || null;
}

function getDisplaySignerEmail(sessionData: any, progress: any) {
  const participants = sessionData?.participants || [];
  const completedParticipants = participants
    .filter((participant: any) => participant.status === 'completed')
    .sort((a: any, b: any) => toMs(b.completedAt) - toMs(a.completedAt));

  const latestCompleted = completedParticipants[0] || null;
  return latestCompleted?.email
    || progress.currentParticipant?.email
    || sessionData?.participants?.[0]?.email
    || null;
}

/**
 * The window and filters arrive straight from a query string that
 * `listSessionsSchema` has already coerced and bounded, so they are passed
 * through to the repository untouched.
 */
interface SessionListInput {
  lawFirmId: string;
  userId: string;
  limit?: unknown;
  offset?: unknown;
  page?: unknown;
  status?: unknown;
  search?: unknown;
}

/**
 * One page of the firm's signing history, paged, filtered and counted in SQL.
 * Answers `{ sessions, totalItems }`.
 */
export async function listFirmSigningSessions({ lawFirmId, userId, limit, offset, page, status, search }: SessionListInput) {
  const { sessions: pageSessions, totalItems } = await repo.listForFirmPaged(lawFirmId, {
    limit, offset, page, status, search,
  });

  const filingLocations = await repo.filingLocationsFor(
    lawFirmId, pageSessions.map((d: any) => d.token));

  const sessions = pageSessions.map((d: any) => {
    const progress = getSessionProgress(d);
    const currentUserParticipant = (d.participants || []).find(
      (participant: any) => participant.memberUserId === userId || participant.clientUserId === userId
    ) || null;
    const facilitatorCanSign = d.createdBy === userId
      && progress.currentParticipant?.deliveryMethod === 'in_person';

    return {
      token: d.token,
      sessionToken: d.token,
      fileName: d.fileName,
      status: d.status,
      signerName: getDisplaySignerName(d, progress),
      recipientEmail: getDisplaySignerEmail(d, progress),
      createdAt: ts(d.createdAt),
      completedAt: ts(d.completedAt),
      expiresAt: ts(d.expiresAt),
      destinationLabel: d.destinationLabel || null,
      destination: filingLocations.get(d.token) || null,
      routingMode: d.routingMode || 'sequential',
      totalParticipants: progress.totalParticipants,
      completedParticipants: progress.completedParticipants,
      currentSignerOrder: d.currentSignerOrder || null,
      currentSignerName: progress.currentParticipant?.name || null,
      currentSignerRole: progress.currentParticipant?.roleLabel || null,
      signers: (d.participants || []).map((participant: any) => ({
        participantId: participant.participantId,
        roleLabel: participant.roleLabel,
        name: participant.signerName || participant.name,
        email: participant.email,
        status: participant.status,
        order: participant.order,
        deliveryMethod: participant.deliveryMethod,
        // When this signer signed, which on a multi-signer document is a
        // different question from when the document completed.
        completedAt: ts(participant.completedAt),
        // Whether this signer is the caller, so the UI can point them at
        // their own row. A flag rather than the user id: the client only
        // needs to know "this one is you", not who everyone else is.
        isCurrentUser: participant.memberUserId === userId
          || participant.clientUserId === userId,
      })),
      readyForCurrentUser: currentUserParticipant?.status === 'active' || facilitatorCanSign,
      currentUserSigningToken: facilitatorCanSign ? d.token : (currentUserParticipant?.publicToken || null),
    };
  });

  return { sessions, totalItems };
}

/**
 * How many sessions sit in each status over the firm's whole history, not the
 * page on screen. Answers `{ counts, total, notCompleted }`.
 */
export async function getFirmSigningSessionSummary({ lawFirmId }: { lawFirmId: string }) {
  const counts = await repo.countByStatusForFirm(lawFirmId);
  const total = Object.values(counts).reduce((sum: number, count: any) => sum + Number(count), 0);

  return {
    counts,
    total,
    // The synthetic "still outstanding" filter, counted here so the client
    // doesn't have to know which statuses it spans.
    notCompleted: total - (counts.completed || 0),
  };
}

/**
 * The open sessions the caller is personally involved in, split into the ones
 * waiting on their signature and the ones they sent.
 * Answers `{ needsMySignature, createdByMe }`, each newest first.
 */
export async function getPendingForUser({ lawFirmId, userId }: { lawFirmId: string; userId: string }) {
  // Sessions with an active participant slot of the caller's own, or that the
  // caller sent, so each lands in one bucket, the other, or both.
  const sessions = await repo.listPendingOrInProgressForUser(lawFirmId, userId, { includeCreatedBy: true });

  const needsMySignature = [];
  const createdByMe = [];

  for (const data of sessions) {
    const myActiveParticipant = (data.participants || []).find(
      (participant: any) => participant.memberUserId === userId && participant.status === 'active'
    );

    if (myActiveParticipant) {
      needsMySignature.push({
        sessionToken: data.token,
        fileName: data.fileName,
        routingMode: data.routingMode || 'sequential',
        createdAt: ts(data.createdAt),
        participantId: myActiveParticipant.participantId,
        participantRole: myActiveParticipant.roleLabel,
        publicToken: myActiveParticipant.publicToken || null,
        totalParticipants: (data.participants || []).length,
        completedParticipants: (data.participants || []).filter((participant: any) => participant.status === 'completed').length,
      });
    }

    if (data.createdBy === userId) {
      createdByMe.push({
        sessionToken: data.token,
        fileName: data.fileName,
        status: data.status,
        routingMode: data.routingMode || 'sequential',
        createdAt: ts(data.createdAt),
        totalParticipants: (data.participants || []).length,
        completedParticipants: (data.participants || []).filter((participant: any) => participant.status === 'completed').length,
      });
    }
  }

  const sortByCreatedAtDesc = (a: any, b: any) => {
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return bTime - aTime;
  };

  needsMySignature.sort(sortByCreatedAtDesc);
  createdByMe.sort(sortByCreatedAtDesc);

  return { needsMySignature, createdByMe };
}

// Stored timestamps are ISO strings from Postgres.
function templateTs(value: any) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** A `signature_templates` row in the shape every template route answers with. */
export function serializeSigningTemplate(row: any) {
  const normalizedFields = normalizeSignatureFields(row.fields).fields;
  return {
    templateId: row.id,
    name: row.name || '',
    description: row.description || '',
    fields: normalizedFields,
    signerRoles: Array.isArray(row.signer_roles) ? row.signer_roles : [],
    sourceFileName: row.source_file_name || null,
    sourceObjectPath: row.source_object_path || null,
    // The admitted source this template was built on. A caller applying the
    // template names it, so the session uses the PREPARED copy rather than
    // re-inspecting and re-flattening the same bytes per session.
    sourceId: row.source_id || null,
    routingMode: row.routing_mode || 'sequential',
    createdBy: row.created_by || null,
    createdAt: templateTs(row.created_at),
    updatedAt: templateTs(row.updated_at),
  };
}

/** Every signing template the firm holds. Answers `{ templates }`. */
export async function listSigningTemplates({ lawFirmId }: { lawFirmId: string }) {
  const rows = await repo.listTemplates(lawFirmId);
  return { templates: rows.map(serializeSigningTemplate) };
}
