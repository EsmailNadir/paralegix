/**
 * Keeps conversation membership in step with firm membership.
 *
 * Subscribed rather than called inline for the same reason the other cascades
 * are: removing someone from a firm must not fail because a messaging write
 * failed.
 */

// Forces module scope (this file has no other top-level import/export), so
// its top-level `const`s don't collide with same-named ones in other
// require-only script files.
export {};

const eventBus = require('../../shared/events/eventBus');
const msgRepo = require('./messaging.repository');
const { MEMBER_ADDED, MEMBER_REMOVED } = require('../../shared/events/eventTypes');

/**
 * A member who leaves a firm leaves its conversations with them.
 *
 * Their access is already gone (every firm route checks membership, and the
 * client routes require a client account), so this is about the roster rather
 * than the wall: without it a departed colleague stayed listed as a participant
 * of every group they were on, indefinitely. Mirrors the matter_members and
 * task_assignees cleanup on the same event.
 */
eventBus.on(MEMBER_REMOVED, async ({ lawFirmId, userId }: any) => {
  try {
    await msgRepo.removeParticipantFromFirmConversations(lawFirmId, userId);
  } catch (err: any) {
    console.error('messaging.events MEMBER_REMOVED failed:', err?.message || err);
  }
});

/**
 * A member who joins a firm joins its company conversations.
 *
 * The mirror of the removal above, and the reason it has to exist: a company's
 * canonical conversation copies the firm roster in once, at creation, and group
 * threads are participant-gated for firm members too. See
 * `addMemberToCompanyConversations` for why only company threads are touched.
 */
eventBus.on(MEMBER_ADDED, async ({ lawFirmId, userId }: any) => {
  try {
    await msgRepo.addMemberToCompanyConversations(lawFirmId, userId);
  } catch (err: any) {
    console.error('messaging.events MEMBER_ADDED failed:', err?.message || err);
  }
});
