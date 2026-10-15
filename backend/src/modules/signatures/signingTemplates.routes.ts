const crypto = require('crypto');
const express = require('express');
const filesRepo = require('../files/files.repository');
const router = express.Router({ mergeParams: true });

const repo = require('./signatures.repository');
const { admin } = require('../../shared/database/firebase');
const { verifyToken } = require('../../shared/middleware/auth');
const { NotFoundError, ForbiddenError } = require('../../shared/errors/AppError');
const { openGcsPdfSource } = require('./pdf/gcsSource');
const { admitStoredUpload, inspectStoredPdf } = require('./signingSources');
const { runJobNow } = require('./signingJobs');
const { SIGNING_INLINE_PREPARE_BYTES } = require('./signing.validation');
const { validate } = require('../../shared/middleware/validate');
const { requirePermission } = require('../lawfirms/roles/requirePermission');
const { assertMatterMembership } = require('../../shared/utils/membership');
const { isUuid } = require('../../shared/utils/isUuid');
const {
  createSigningTemplateSchema,
  updateSigningTemplateSchema,
} = require('./signingTemplates.validation');
const { normalizeSignatureFields } = require('./fieldNormalization');
import { handler } from '../../shared/http/handler';
import { listSigningTemplates, serializeSigningTemplate } from './signatureWorkspaceReads';

const BUCKET_NAME = process.env.GCS_BUCKET || 'lawfirms';
const bucket = admin.storage().bucket(BUCKET_NAME);

function templateSourcePrefix(lawFirmId: string) {
  return `lawfirmids/${lawFirmId}/signing-templates/`;
}

/**
 * The matter a stored document belongs to, or null when it belongs to none.
 *
 * A row lookup, not a path parse. It read the segment after the firm id, which
 * worked only while the tree lived in the path; an object path is opaque now, so
 * that parse quietly returned null for every document and the matter-level wall
 * stopped applying to anything sent for signature.
 */
async function matterIdOfObject(lawFirmId: string, objectPath: any) {
  const row = await filesRepo.findByObjectPath(lawFirmId, objectPath, { includeDeleted: true });
  return row?.matterId || null;
}

async function persistTemplateSource(lawFirmId: string, sourceObjectPath: any, sourceFileName: any, requestedByUserId: any) {
  if (!sourceObjectPath) return { objectPath: null, sourceId: null };
  // Already tenant-owned (e.g. an unchanged update), so there is nothing to
  // copy. Its source row is looked up rather than rebuilt: re-admitting the
  // same bytes would flatten and re-hash a document that is already prepared.
  if (sourceObjectPath.startsWith(templateSourcePrefix(lawFirmId))) {
    const existing = await repo.getSourceByObjectPath(lawFirmId, sourceObjectPath);
    return { objectPath: sourceObjectPath, sourceId: existing?.id || null };
  }

  // Validate the caller may read the source BEFORE copying it into the firm's
  // template store (which is then streamable via GET /api/signing/preview). Mirrors
  // validateSigningSourcePath on the send path: a matter-scoped source requires
  // matter membership; a signing-upload must be the caller's own; anything else is
  // rejected. Without this a signatures.send holder could point sourceObjectPath at
  // another firm's (or another user's) document, copy it into their own tenant
  // folder, and read it back — a cross-tenant/cross-user exfiltration.
  const firmPrefix = `lawfirmids/${lawFirmId}/`;
  if (sourceObjectPath.startsWith(firmPrefix)) {
    const matterId = await matterIdOfObject(lawFirmId, sourceObjectPath);
    if (matterId) {
      await assertMatterMembership(lawFirmId, matterId, requestedByUserId);
    }
  } else if (sourceObjectPath.startsWith('signing-uploads/')) {
    let uploadedBy = null;
    try {
      const [m] = await bucket.file(sourceObjectPath).getMetadata();
      uploadedBy =
        m?.metadata?.uploadedBy ||
        (m?.metadata as any)?.metadata?.uploadedBy ||
        (m as any)?.uploadedBy ||
        null;
    } catch { uploadedBy = null; }
    if (uploadedBy !== requestedByUserId) {
      const pathFirmId = sourceObjectPath.split('/')[1] || lawFirmId;
      const source = pathFirmId ? await repo.getSourceByObjectPath(pathFirmId, sourceObjectPath).catch(() => null) : null;
      if (!source || source.uploadedBy !== requestedByUserId) {
        throw new ForbiddenError('You do not have access to this uploaded document');
      }
    }
  } else {
    throw new ForbiddenError('Document path must stay within this law firm');
  }

  // The version being copied, pinned. Between the check above and the copy the
  // object can be replaced, and an unpinned copy takes the new bytes under a
  // check that passed for the old ones.
  let generation: string | null = null;
  try {
    const [meta] = await bucket.file(sourceObjectPath).getMetadata();
    generation = meta?.generation ? String(meta.generation) : null;
  } catch {
    generation = null;
  }

  // Structural admission, at the point the template is SAVED. The template
  // routes used to check nothing, so a template built on an encrypted or
  // already-signed PDF failed much later, at the point a signer had been
  // invited and emailed. The same boundary every other entry point crosses.
  const size = Number((await bucket.file(sourceObjectPath).getMetadata())[0]?.size || 0);
  let inspection = null;
  if (generation && size > 0) {
    const pdf = openGcsPdfSource({ objectPath: sourceObjectPath, generation, sizeBytes: size });
    try {
      inspection = await inspectStoredPdf(pdf, new AbortController().signal);
    } finally {
      await pdf.close();
    }
  }

  const safeName = (sourceFileName || 'document.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
  const durablePath = `${templateSourcePrefix(lawFirmId)}${crypto.randomBytes(12).toString('hex')}/${safeName}`;
  // A failed copy is NOT recoverable by keeping the original path. That original
  // is a transient upload the ten-day sweep deletes, or a firm document the firm
  // can delete, so the template would look saved and be broken the first time
  // anyone used it. Better to refuse the save.
  await bucket.file(sourceObjectPath).copy(bucket.file(durablePath), {
    preconditionOpts: { ifGenerationMatch: 0 },
    ...(generation ? { sourceGeneration: generation } : {}),
  });

  // The copy is now an admitted SOURCE, not just a path on a row. Until this
  // existed, a template recorded a path and nothing else: applying it re-read
  // and re-inspected the document every time, and the flatten and the hash it
  // needs to be sealed were done again per session even though every session
  // from this template uses the same bytes.
  //
  // Admission also decides readiness. A template whose source is not `ready`
  // cannot be applied, which is the point: the structural check happened once,
  // here, and what a session uses is the PREPARED copy that check produced.
  // The copy below is pinned to the generation just inspected, so its bytes
  // are the inspected ones. Handing admission that result saves a second
  // structural walk of the same document inside this request. Without a
  // generation nothing was inspected, and admission walks the copy itself.
  const admitted = await admitStoredUpload({
    lawFirmId,
    uploadedBy: requestedByUserId,
    objectPath: durablePath,
    inspection,
  });

  // Prepared inline when there is a job to run and the document is small enough
  // to finish inside this request. Above that it stays pending and the drain
  // finishes it, which is what the 409 on apply is for.
  if (admitted.jobId && Number(admitted.sizeBytes || 0) <= SIGNING_INLINE_PREPARE_BYTES) {
    await runJobNow(lawFirmId, admitted.jobId, `template:${requestedByUserId}`)
      .catch((err: any) => console.warn('[signing] Inline template preparation failed:', err.message));
  }

  return { objectPath: durablePath, sourceId: admitted.id };
}

router.get('/',
  verifyToken,
  requirePermission('signatures.view'),
  handler(async (req) => listSigningTemplates({ lawFirmId: req.params.lawFirmId })),
);

router.post('/',
  verifyToken,
  requirePermission('signatures.send'),
  validate(createSigningTemplateSchema),
  handler(async (req) => {
    const body = req.body;
    const source = await persistTemplateSource(
      req.params.lawFirmId,
      body.sourceObjectPath || null,
      body.sourceFileName || null,
      req.user.uid,
    );
    const created = await repo.createTemplate({
      lawFirmId: req.params.lawFirmId,
      name: body.name,
      description: body.description || '',
      fields: normalizeSignatureFields(body.fields).fields,
      signerRoles: body.signerRoles || [],
      sourceFileName: body.sourceFileName || null,
      sourceObjectPath: source.objectPath,
      sourceId: source.sourceId,
      routingMode: body.routingMode || 'sequential',
      createdBy: req.user.uid,
    });
    return { template: serializeSigningTemplate(created) };
  }, 201),
);

router.get('/:templateId',
  verifyToken,
  requirePermission('signatures.view'),
  handler(async (req) => {
    const row = await repo.getTemplate(req.params.templateId, req.params.lawFirmId);
    if (!row) {
      throw new NotFoundError('Signing template');
    }
    return { template: serializeSigningTemplate(row) };
  }),
);

router.put('/:templateId',
  verifyToken,
  requirePermission('signatures.send'),
  validate(updateSigningTemplateSchema),
  handler(async (req) => {
    const existing = await repo.getTemplate(req.params.templateId, req.params.lawFirmId);
    if (!existing) {
      throw new NotFoundError('Signing template');
    }

    const patch = {
      ...req.body,
      ...(req.body.fields ? { fields: normalizeSignatureFields(req.body.fields).fields } : {}),
      ...(req.body.sourceObjectPath
        ? await (async () => {
          const source = await persistTemplateSource(
            req.params.lawFirmId,
            req.body.sourceObjectPath,
            req.body.sourceFileName || existing.source_file_name,
            req.user.uid,
          );
          return { sourceObjectPath: source.objectPath, sourceId: source.sourceId };
        })()
        : {}),
    };
    const updated = await repo.updateTemplate(req.params.templateId, req.params.lawFirmId, patch);
    return { template: serializeSigningTemplate(updated) };
  }),
);

router.delete('/:templateId',
  verifyToken,
  requirePermission('signatures.send'),
  handler(async (req) => {
    const existing = await repo.getTemplate(req.params.templateId, req.params.lawFirmId);
    if (!existing) {
      throw new NotFoundError('Signing template');
    }
    await repo.deleteTemplate(req.params.templateId, req.params.lawFirmId);

    // Best effort: remove the durable source copy this template owned so it
    // doesn't linger in storage. Only deletes tenant-owned template sources,
    // never a shared/transient upload path.
    const sourcePath = existing.source_object_path;
    if (sourcePath && sourcePath.startsWith(templateSourcePrefix(req.params.lawFirmId))) {
      bucket.file(sourcePath).delete().catch((err: any) =>
        console.error('[signing-templates] Failed to delete source copy:', err.message));
    }

    return { success: true };
  }),
);

export = router;
