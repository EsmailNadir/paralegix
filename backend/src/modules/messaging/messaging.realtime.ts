/**
 * Mints a short-lived Supabase-compatible JWT for the frontend to authenticate
 * its Realtime (postgres_changes) subscription. The token is signed with the
 * project's JWT secret and carries the Firebase uid as `sub`, so RLS policies on
 * conversations/messages can authorize by auth.uid() = the firebase uid stored
 * on members.user_id / conversations.client_id.
 */

const jwt = require('jsonwebtoken');

export const TTL_SECONDS = 15 * 60; // 15 minutes (client refreshes well within this)

export function signRealtimeToken(firebaseUid: any) {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    const err: any = new Error('Realtime is not configured (missing SUPABASE_JWT_SECRET)');
    err.statusCode = 503;
    throw err;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    sub: firebaseUid,
    role: 'authenticated',
    aud: 'authenticated',
    iat: nowSec,
    exp: nowSec + TTL_SECONDS,
  };
  return { token: jwt.sign(payload, secret, { algorithm: 'HS256' }), expiresIn: TTL_SECONDS };
}

/**
 * Fire a content-free Supabase Realtime Broadcast ping for a conversation.
 * A CLIENT is never streamed the raw `messages` row: in a group it carries a
 * plaintext sender_name a co-client must not see when the firm masks client
 * names, and in a direct thread it carries the real sender of a "send as firm"
 * message and the retained text of a deleted one. So a client's thread is told
 * "something changed, re-fetch" by this ping instead, and the actual (masked)
 * content comes from the REST refetch. The payload is ids only.
 *
 * Groups ping on every send, edit, delete and roster change. Direct threads
 * ping on what does not move the conversations row their client also watches:
 * an edit, a soft delete, and the firm reading the client's messages.
 *
 * The topic is `groupmsg:<conversationId>` for both kinds. The name predates
 * direct threads using it; it is the contract the browser subscribes to, so it
 * stays rather than breaking open group threads across a deploy.
 *
 * Best-effort and non-blocking: on any failure the client still catches up on
 * its next open/refetch, so a broadcast error must never fail the write.
 *
 * The topic is deliberately a NON-private ("public") broadcast channel. Nothing
 * confidential rides on it: the payload is ids only ({ conversationId, messageId }),
 * never message content, sender names, or participants. A non-participant cannot
 * learn anything useful from it either -- they would have to already know the exact
 * conversation UUID to subscribe to the right `groupmsg:<uuid>` topic, and all they
 * would observe is that *a* message occurred. The authoritative content path is the
 * RLS-gated REST refetch the ping triggers, which enforces participant access and
 * client-name masking. Making this a private channel would require Realtime
 * Authorization RLS policies on `realtime.messages` (no such policy exists yet) and
 * would silently break live updates for every participant if misconfigured, so
 * the metadata-only public channel is the deliberate, lower-risk choice.
 */
export async function broadcastConversationEvent(conversationId: string, payload = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || typeof fetch !== 'function') return;
  try {
    await fetch(`${url.replace(/\/$/, '')}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        messages: [{ topic: `groupmsg:${conversationId}`, event: 'new', payload, private: false }],
      }),
    });
  } catch {
    // Swallow: the client refetches on next open regardless.
  }
}
