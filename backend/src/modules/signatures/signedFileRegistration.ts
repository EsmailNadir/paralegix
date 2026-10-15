const filesRepo = require('../files/files.repository');

/** What a filing attempt claimed, and what it must not charge for twice. */
export interface FiledDocument {
  id: string;
  objectPath: string;
  deletedAt?: string | null;
  /** Bytes an earlier attempt already put on the firm's usage. */
  reusedSizeBytes: number | null;
}

/**
 * The scope a session's chosen folder sits in, for the matter-level access
 * checks the signing routes run before serving a session's outputs.
 *
 * Firm scope for a session that chose nothing, so a caller reading a HISTORIC
 * session still gets an answer rather than an exception.
 */
export async function destinationScope(lawFirmId: string, destinationFolderId: any) {
  if (!lawFirmId || !destinationFolderId) return { scope: 'firm' };
  const folder = await filesRepo.findById(lawFirmId, destinationFolderId);
  if (!folder) return { scope: 'firm' };
  return {
    scope: folder.scope,
    matterId: folder.matterId || null,
    taskId: folder.taskId || null,
    clientId: folder.clientId || null,
  };
}

/**
 * The folder a completed session's executed copy should actually be filed into.
 *
 * The chosen folder when it is still there, and the firm's General Files root
 * otherwise: a document the firm can find beats one filed correctly into a
 * folder that is gone. The fallback is logged, because it means the executed
 * copy is not where the sender put it.
 *
 * A folder can disappear two ways, and both end here. Deleting the matter
 * cascades the whole subtree away and nulls the session pointer; deleting the
 * folder alone leaves the row with `deleted_at` set. Neither is a place to file.
 */
export async function resolveFilingFolder(lawFirmId: string, destinationFolderId: any) {
  if (destinationFolderId) {
    const folder = await filesRepo.findById(lawFirmId, destinationFolderId);
    if (folder && !folder.deletedAt && folder.kind === 'folder') return folder.id;
    console.error(
      '[signing] Filing folder no longer exists, filing to General Files instead:',
      destinationFolderId,
    );
  }
  return filesRepo.ensureScopeRoot(lawFirmId, { scope: 'firm' });
}

/**
 * File an executed document that is ALREADY a stored object.
 *
 * Three steps, in this order: claim the row, put the bytes at the object the row
 * names, stamp it. A row is not listable, searchable or counted until the stamp,
 * so a failure between them leaves nothing visible. Step 2 is the one to note.
 * The executed artifact was produced by the appending pipeline and lives in
 * storage, so filing it is a server-side COPY over a pinned generation rather
 * than an upload of bytes this process would first have to hold. A document
 * larger than the container can be filed; one that changed since it was sealed
 * cannot, because the pinned generation refuses.
 *
 * The claim is what makes a retry safe: `signed_via_session` ties every attempt
 * for one session to one row, so the copy lands on its own earlier object and
 * `reusedSizeBytes` reports what the firm was already charged.
 */
export async function fileSignedArtifact({
  lawFirmId, destinationFolderId, sessionId, name, artifact, uploadedBy, bucket,
}: {
  lawFirmId: string;
  destinationFolderId: any;
  sessionId: any;
  name: string;
  artifact: { objectPath: string; generation?: string | null; sizeBytes: number };
  uploadedBy?: string | null;
  bucket: any;
}): Promise<FiledDocument | null> {
  if (!lawFirmId || !destinationFolderId) return null;

  const existing = await filesRepo.findBySigningSession(lawFirmId, sessionId);

  // Filed once already and since deleted by the firm. That is their decision
  // about their own document; a retry is not a reason to undo it or to file a
  // second copy beside it. The archive copy is the durable record. Nothing is
  // written and nothing is charged: the whole size is reported as reused so the
  // caller's delta comes to zero.
  if (existing?.deletedAt) {
    return { ...existing, reusedSizeBytes: artifact.sizeBytes };
  }

  const row = existing || await filesRepo.createFile(lawFirmId, {
    parentId: destinationFolderId,
    name,
    mimeType: 'application/pdf',
    uploadedBy: uploadedBy || null,
    signedViaSession: sessionId,
  });

  // Overwriting is correct here and create-only is not: the destination object
  // belongs to this row and to no other, so a retry replacing its own earlier
  // copy is the intended outcome. The SOURCE generation is what is pinned.
  const source = artifact.generation
    ? bucket.file(artifact.objectPath, { generation: String(artifact.generation) })
    : bucket.file(artifact.objectPath);
  await source.copy(bucket.file(row.objectPath), {
    contentType: 'application/pdf',
    cacheControl: 'no-store, max-age=0',
  });

  const stamped = await filesRepo.finalize(lawFirmId, row.id, {
    sizeBytes: artifact.sizeBytes, mimeType: 'application/pdf',
  });
  return { ...row, reusedSizeBytes: stamped.previouslyCounted || null };
}
