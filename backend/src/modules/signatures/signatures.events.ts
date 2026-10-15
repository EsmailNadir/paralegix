const nodeCrypto = require('crypto');
const eventBus = require('../../shared/events/eventBus');
const { LAWFIRM_DELETED, CLIENT_DELETED, SIGNING_PARTICIPANT_REMOVED } = require('../../shared/events/eventTypes');
const { sweepFirm, sweepSession } = require('./signingWorkspace');
const repo = require('./signatures.repository');
const { cancelParticipantSlot } = require('./signingSessions');
const { writeAuditEvent, AUDIT_EVENTS } = require('./audit');
const { sendCancellationNotifications } = require('./signingNotifications');
const { destinationScope } = require('./signedFileRegistration');

/**
 * Remove the transient signing storage a deleted firm owned.
 *
 * The files module's LAWFIRM_DELETED handler clears `lawfirmids/{firmId}/`,
 * which is everything the firm could see. Signing also writes outside that tree:
 * uploaded sources live at the bucket root under `signing-uploads/{firmId}/`, so
 * nothing scoped to the firm prefix would ever reach them. Without this, the
 * documents a firm sent for signature outlive the erasure of the firm itself.
 */
eventBus.on(LAWFIRM_DELETED, async ({ lawFirmId }: any) => {
  try {
    await sweepFirm(lawFirmId);
  } catch (err: any) {
    console.error('signatures.events: LAWFIRM_DELETED handler failed:', err.message);
  }
});

/**
 * Close out a deleted client's open signing sessions.
 *
 * A participant's `client_user_id` is the client's portal user id and carries no FK, so
 * deleting a client left every open session's public signing token live: the
 * former client (or anyone holding the link) could still sign a document into a
 * firm that no longer has them on file. Cancelling — rather than deleting — kills
 * the link while keeping the audit trail, which is the point of that table.
 *
 * A client is bound to a session on their OWN participant row
 * (`signature_participants.client_user_id`). Left unhandled, deleting a client
 * bound as one signer among several left that signer's link live inside an
 * otherwise still-open multi-party session. `cancelParticipantSlot` cancels
 * only that ONE participant's slot; a session with several signers keeps
 * functioning for whoever else is left, unless nobody actionable remains, in
 * which case it decides the whole session has to end too (see its own doc
 * comment for the exact rules).
 *
 * `userId` is a person client's own portal uid. A company client never carries
 * one of its own (Phase 1 invariant) - its former roster contacts' uids come
 * separately as `rosterUserIds` (organization-clients plan Phase 8), collected
 * by clients.service.ts before the roster links are cascade-deleted. Without
 * this, deleting a company left every one of its roster contacts' open
 * signing links live, the exact hole this handler exists to close for a
 * person client.
 *
 * Deliberately post-delete, not a pre-delete block: the participant's
 * `client_user_id` column carries no FK to `clients`, so a live open session
 * cannot make the delete fail or
 * orphan a row the way the `conversations.client_record_id` FK does (see
 * clients.service.ts's `removeClient`, which blocks instead, for that reason).
 * The only cost of cancelling here rather than blocking is the brief window
 * between commit and this handler running where an open link stays
 * technically usable - the same window every other CLIENT_DELETED
 * cache/cleanup listener in this codebase already accepts. Blocking deletion
 * on any open signing session would be a stricter product decision than that,
 * and isn't warranted by a referential-integrity risk here the way the
 * conversation case is.
 */
eventBus.on(CLIENT_DELETED, async ({ lawFirmId, userId, rosterUserIds }: any) => {
  const targetUserIds = [...new Set([userId, ...(rosterUserIds || [])].filter(Boolean))];
  if (!targetUserIds.length) return;
  try {
    for (const targetUserId of targetUserIds) {
      // Participant-level client_user_id: one slot among several.
      // eslint-disable-next-line no-await-in-loop
      const participantSlots = await repo.listOpenParticipantSessionsForClient(lawFirmId, targetUserId);
      for (const { token, participantId } of participantSlots) {
        const tokenRef = nodeCrypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12);
        try {
          // eslint-disable-next-line no-await-in-loop
          const result = await cancelParticipantSlot(token, participantId);
          // Already terminal (a concurrent /complete or /decline beat us to
          // it, or a prior run of this same handler already handled it) -
          // nothing left to do for this slot.
          if (!result) continue;

          // eslint-disable-next-line no-await-in-loop
          await writeAuditEvent(token, AUDIT_EVENTS.PARTICIPANT_REMOVED, {
            metadata: { participantId, reason: 'client_deleted', sessionCancelled: result.sessionCancelled },
          }).catch((auditErr: any) => console.error('signatures.events: PARTICIPANT_REMOVED audit failed:', tokenRef, auditErr.message));

          if (!result.sessionCancelled) {
            // The session keeps running for the remaining signers. No email to
            // anyone and no firm-facing notification here: an account deletion
            // is an administrative event, not something the other signers need
            // to be told mid-flow, and this codebase already reserves firm
            // notifications for terminal, session-level transitions (compare
            // SIGNING_COMPLETED / SIGNING_DECLINED, both fired only once the
            // whole session resolves, never per intermediate signer). The audit
            // event above still records exactly what happened, for anyone who
            // looks at this session's history later.
            continue;
          }

          // Terminal for the whole session now, same as a full /cancel or
          // /decline: sweep its scratch copies and notify whoever was still
          // owed a turn, the same way those two paths already do.
          // eslint-disable-next-line no-await-in-loop
          await sweepSession(lawFirmId, token);

          sendCancellationNotifications({
            sessionData: result.sessionData,
            senderName: result.sessionData.notifyName || 'Someone',
            senderEmail: result.sessionData.notifyEmail || null,
          }).catch((notifyErr: any) => console.error('signatures.events: cancellation notifications failed:', tokenRef, notifyErr.message));

          try {
            const { matterId } = await destinationScope(lawFirmId, result.sessionData.destinationFolderId);
            eventBus.emit(SIGNING_PARTICIPANT_REMOVED, {
              lawFirmId,
              sessionId: token,
              fileName: result.sessionData.fileName,
              initiatorUserId: result.sessionData.createdBy || null,
              matterId: matterId || null,
              participantName: result.participant?.name || null,
            });
          } catch (emitErr: any) {
            console.error('signatures.events: SIGNING_PARTICIPANT_REMOVED emit failed:', tokenRef, emitErr.message);
          }
        } catch (err: any) {
          console.error('signatures.events: failed to cancel participant slot', tokenRef, err.message);
        }
      }
    }
  } catch (err: any) {
    console.error('signatures.events: CLIENT_DELETED handler failed:', err.message);
  }
});
