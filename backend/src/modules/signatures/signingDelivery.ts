/**
 * Handing the finished document to everyone entitled to a copy.
 *
 * Delivery is the sender's notification, the signers' copies (when the session
 * asked for them), and a post into each portal signer's conversation thread.
 * All three are driven by the DELIVERY artifact: the sealed executed PDF
 * without the certificate page, whose hash is the one printed on the
 * certificate as the value a recipient can reproduce against the file they
 * hold.
 *
 * What changed here is that there is no delivery BUFFER any more. The artifact
 * is a stored object, and the pipeline that produced it never held it. Reading
 * it back in full per recipient would put the whole document in the process
 * once for the sender, once per signer and once per portal thread, which is the
 * cost the pipeline exists to remove and would reintroduce at the last step.
 *
 * So the size decides the medium. Below the threshold the artifact is read ONCE
 * and attached to every message, which is what recipients get today and is the
 * behaviour worth keeping for the documents most firms send. Above it, each
 * recipient is sent a link bound to that recipient and to that exact version of
 * that artifact, and the bytes never enter this process at all.
 *
 * Every branch is best-effort and self-contained: a signature has already been
 * collected and the document is already filed, so no delivery failure may
 * propagate. Each is logged instead.
 */
import { mintSigningArtifactUrl } from './signingDownloads';

const crypto = require('crypto');
const { adjustStorageUsageByDelta } = require('../../shared/utils/storageUsage');
const {
  postFirmMessageToClient,
  sendDocumentSignedEmail,
  sendSignedCopyToSigners,
} = require('./signingNotifications');

function bucket() {
  const { admin } = require('../../shared/database/firebase');
  return admin.storage().bucket(process.env.GCS_BUCKET || 'lawfirms');
}

/**
 * The largest executed document still delivered as an email attachment.
 *
 * Five MiB, and the number comes from what a mailbox will take rather than from
 * what this process can hold. An attachment is base64 in transit, so 5 MiB of
 * PDF is close to 6.8 MiB on the wire, and every mainstream provider (Gmail,
 * Outlook, most corporate gateways) refuses a message somewhere between 20 and
 * 25 MiB total. Staying under a third of the smallest of those leaves room for
 * the message itself and for a gateway that re-encodes, so a document under
 * this size is one the recipient actually receives rather than one that bounces
 * after the session is already closed.
 *
 * It also bounds this process. One read of at most this many bytes serves every
 * recipient of one session, and a drain running one job at a time therefore
 * never holds more than this on account of delivery.
 */
export const SIGNING_ATTACHMENT_MAX_BYTES =
  Number(process.env.SIGNING_ATTACHMENT_MAX_BYTES) || 5 * 1024 * 1024;

/** The executed copy recipients receive, as it sits in storage. */
export interface DeliveryArtifact {
  objectPath: string;
  generation?: string | null;
  sizeBytes: number;
}

/**
 * The delivery copy's bytes, or null when it is too large to carry.
 *
 * Read once per session and shared by every recipient. A read that fails is
 * reported as "no attachment" rather than thrown: the recipients still get a
 * link, which is strictly better than getting nothing.
 */
async function readAttachment(artifact: DeliveryArtifact): Promise<Buffer | null> {
  if (Number(artifact.sizeBytes) > SIGNING_ATTACHMENT_MAX_BYTES) return null;
  try {
    const handle = artifact.generation
      ? bucket().file(artifact.objectPath, { generation: String(artifact.generation) })
      : bucket().file(artifact.objectPath);
    const [buffer] = await handle.download();
    return buffer?.length ? buffer : null;
  } catch (err: any) {
    console.error('[signing] Could not read the delivery copy for attachment:', err.message);
    return null;
  }
}

/**
 * A link to the executed copy for one participant, or null.
 *
 * Minted per recipient rather than once per session, because the capability is
 * bound to the participant: a link handed to one signer names that signer, and
 * minting is the check. A recipient who is not a completed participant of this
 * session cannot be given one at all.
 */
async function linkFor(options: {
  lawFirmId: string;
  token: string;
  participantId: string;
  objectPath: string;
  fileName: string;
}): Promise<string | null> {
  try {
    const minted = await mintSigningArtifactUrl(options);
    return minted.url;
  } catch (err: any) {
    console.error('[signing] Could not mint a delivery link:', err.message);
    return null;
  }
}

export async function deliverCompletedSession({
  sessionId,
  data,
  participants,
  delivery,
  signedFileName,
  safeName,
}: {
  sessionId: any;
  data: any;
  participants: any[];
  delivery: DeliveryArtifact | null;
  signedFileName: string;
  safeName: string;
}) {
  if (!delivery?.objectPath) {
    console.error('[signing] No delivery copy to send for session', sessionId);
    return { delivered: false };
  }

  let delivered = true;
  const attachmentBuffer = await readAttachment(delivery);
  const lawFirmId = data.lawFirmId;

  // The sender is not a participant, so there is no participant-scoped link to
  // give them. They reach the executed copy through the firm's own routes, which
  // already authorize them, so a large document simply arrives without an
  // attachment and the notification points at the session.
  if (data.notifyEmail) {
    const result = await sendDocumentSignedEmail({
      to: data.notifyEmail,
      signerName: data.signerName || 'A signer',
      fileName: data.fileName,
      signedFileName,
      attachmentBuffer,
      variant: 'final',
    }).catch((err: any) => console.error('[signing] Sender notification email failed:', err.message));
    if (!result?.sent) delivered = false;
  }

  if (data.emailSignersOnComplete) {
    if (attachmentBuffer) {
      const result = await sendSignedCopyToSigners({
        participants,
        fileName: data.fileName,
        signedFileName,
        attachmentBuffer,
        replyTo: data.notifyEmail || undefined,
      }).catch((err: any) => console.error('[signing] Signed-copy email failed:', err.message));
      if (!result?.sent) delivered = false;
    } else {
      // One signer at a time, because each link names one signer. Sending the
      // group one shared link would hand every signer a credential minted for
      // somebody else, which is the difference this branch exists to preserve.
      for (const participant of participants || []) {
        if (participant.status !== 'completed' || !participant.email) continue;
        // eslint-disable-next-line no-await-in-loop -- one minted link per recipient
        const downloadUrl = await linkFor({
          lawFirmId,
          token: sessionId,
          participantId: participant.participantId,
          objectPath: delivery.objectPath,
          fileName: signedFileName,
        });
        if (!downloadUrl) {
          delivered = false;
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const result = await sendSignedCopyToSigners({
          participants: [participant],
          fileName: data.fileName,
          signedFileName,
          attachmentBuffer: null,
          downloadUrl,
          replyTo: data.notifyEmail || undefined,
        }).catch((err: any) => console.error('[signing] Signed-copy email failed:', err.message));
        if (!result?.sent) delivered = false;
      }
    }
  }

  // Portal identity is tracked per participant (clientUserId), so iterating
  // participants covers both a single portal client and sessions with several
  // portal signers. Deduped by client so a client acting as more than one signer
  // only gets one thread post.
  const seenClientIds = new Set();
  const portalRecipients = (participants || []).filter((p: any) => {
    if (p.deliveryMethod !== 'portal' || !p.clientUserId) return false;
    if (seenClientIds.has(p.clientUserId)) return false;
    seenClientIds.add(p.clientUserId);
    return true;
  });

  for (const portalParticipant of portalRecipients) {
    const clientUserId = portalParticipant.clientUserId;
    let attachmentPath: string | undefined;
    let copied = false;
    let charged = false;
    try {
      const conversationId = `${lawFirmId}_${clientUserId}`;

      // Unique per post, exactly like every other messaging attachment. The name
      // came from the source document alone, so signing the same document twice
      // for the same client aimed both copies at one path and the second
      // overwrote the first: the older message kept its attachment row while the
      // bytes behind it silently became the newer document. Nothing in a
      // conversation is ever addressed by name, so there is no reason for two
      // posts to share a path.
      const uniqueAttachmentName = `${crypto.randomBytes(8).toString('hex')}_${safeName}`;
      attachmentPath = `lawfirmids/${lawFirmId}/messaging/${conversationId}/${uniqueAttachmentName}`;

      // A server-side copy, so the thread gets its own object without the
      // document passing through here. The source generation is pinned: a
      // conversation attachment that silently became a different document is
      // the failure this closes.
      const source = delivery.generation
        ? bucket().file(delivery.objectPath, { generation: String(delivery.generation) })
        : bucket().file(delivery.objectPath);
      await source.copy(bucket().file(attachmentPath), {
        contentType: 'application/pdf',
      });
      copied = true;

      // Conversation attachments are ordinary firm storage (the messaging upload
      // routes reserve quota for them), so this copy is charged too. Charged
      // after the write for the same reason the filed copy is: the signature has
      // already happened and cannot be refused over a quota.
      await adjustStorageUsageByDelta(lawFirmId, delivery.sizeBytes).then(() => { charged = true; }).catch((err: any) =>
        console.error('[signing] Storage usage adjust failed for', attachmentPath, err.message));

      // No signed URL here: messaging strips the url on write and re-signs a fresh
      // short-lived one from objectPath on every read, so persisting one is
      // pointless (and would expire in 7 days, the GCS v4 max).
      //
      // Posted as a system notice, not as the client. A message whose sender is
      // the client is one the client can edit or delete, and this one is the
      // firm's record that the document was executed.
      await postFirmMessageToClient(
        lawFirmId,
        clientUserId,
        `All parties have signed "${data.fileName}". Your signed copy is attached.`,
        [{
          name: safeName,
          objectPath: attachmentPath,
          mimeType: 'application/pdf',
          size: delivery.sizeBytes,
        }],
      );
    } catch (msgErr) {
      delivered = false;
      // A refused message has no attachment owner. Remove its private copy and
      // reverse only a charge that succeeded, leaving the executed source intact.
      if (copied && attachmentPath) {
        try {
          await bucket().file(attachmentPath).delete({ ignoreNotFound: true });
          if (charged) await adjustStorageUsageByDelta(lawFirmId, -delivery.sizeBytes);
        } catch (cleanupErr) {
          console.error('[signing] Failed to clean up unattached portal copy:', attachmentPath, cleanupErr);
        }
      }
      console.error('Failed to send signed document message to portal signer:', clientUserId, msgErr);
    }
  }
  return { delivered };
}
