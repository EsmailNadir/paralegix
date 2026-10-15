const express = require('express');
const router = express.Router({ mergeParams: true });
const { verifyToken } = require('../../shared/middleware/auth');
const { validate } = require('../../shared/middleware/validate');
const { requirePermission } = require('../lawfirms/roles/requirePermission');
const { uploadLimiter, templateRenderLimiter } = require('../../shared/middleware/rateLimiters');
const {
  createTemplateSchema,
  updateTemplateSchema,
  fillTemplateSchema,
  exportTemplatePdfSchema,
  savePlacementsSchema,
} = require('./templates.validation');
const { ValidationError } = require('../../shared/errors/AppError');
const templatesService = require('./templates.service');
import { handler } from '../../shared/http/handler';
import { beginDirectUpload, settleDirectUpload } from '../../shared/storage/directUpload';
import { consumeScratchSource } from '../../shared/documentConversion/scratchSource';
import { randomUUID } from 'crypto';
const { admin } = require('../../shared/database/firebase');

const OVERLAY_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
const OVERLAY_UPLOAD_EXTENSIONS = ['.pdf', '.docx', '.doc', '.odt', '.rtf', '.txt'];
const PLACEMENT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const PLACEMENT_IMAGE_TYPES = ['image/png', 'image/jpeg'];
const overlayUploadPrefix = (lawFirmId: string, userId: string) =>
  `template-uploads/${lawFirmId}/${userId}/`;
const docxUploadPrefix = (lawFirmId: string, userId: string) =>
  `template-docx-uploads/${lawFirmId}/${userId}/`;
const placementImageUploadPrefix = (lawFirmId: string, templateId: string, userId: string) =>
  `template-placement-uploads/${lawFirmId}/${templateId}/${userId}/`;
const overlayExtension = (fileName: unknown) => {
  const name = String(fileName || '').toLowerCase();
  return OVERLAY_UPLOAD_EXTENSIONS.find((ext) => name.endsWith(ext)) || null;
};
const bucket = () => admin.storage().bucket(process.env.GCS_BUCKET || 'lawfirms');

// GET /api/lawfirms/:lawFirmId/templates (List all templates)
router.get('/',
  verifyToken,
  requirePermission('templates.view'),
  handler(async (req) => templatesService.listTemplates({
    lawFirmId: req.params.lawFirmId,
  }))
);

// POST /api/lawfirms/:lawFirmId/templates (Create an HTML template)
router.post('/',
  verifyToken,
  requirePermission('templates.manage'),
  validate(createTemplateSchema),
  handler(async (req) => {
    // Body fields spread first, trusted URL param last: the schema declares no
    // lawFirmId key, so a body one would otherwise survive validate()'s merge
    // and override the trusted value, redirecting the write to another firm.
    const result = await templatesService.createTemplate({
      ...req.body,
      lawFirmId: req.params.lawFirmId,
    });
    return result;
  }, 201)
);

// A DOCX still has to be parsed in this process for its placeholders, but it
// does not have to arrive in an HTTP body. The parser is the one bounded read;
// the upload connection remains browser-to-storage.
router.post('/upload-docx-init',
  verifyToken,
  requirePermission('templates.manage'),
  uploadLimiter,
  handler(async (req) => {
    const fileName = String(req.body?.fileName || '');
    if (!fileName.toLowerCase().endsWith('.docx')) {
      throw new ValidationError('Only DOCX files can be uploaded as DOCX templates.');
    }
    const objectPath = `${docxUploadPrefix(req.params.lawFirmId, req.user.uid)}${randomUUID()}/source.docx`;
    return beginDirectUpload({
      objectPath,
      contentType: String(req.body?.contentType || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      uploadedBy: req.user.uid,
      maxBytes: OVERLAY_UPLOAD_MAX_BYTES,
      fileName,
      declaredSize: Number(req.body?.size) || undefined,
      origin: req.get('origin') || undefined,
      metadata: { lawFirmId: req.params.lawFirmId, templateDocx: 'true' },
    });
  })
);

router.post('/upload-docx-finalize',
  verifyToken,
  requirePermission('templates.manage'),
  uploadLimiter,
  handler(async (req) => {
    const fileName = String(req.body?.fileName || '');
    const objectPath = String(req.body?.objectPath || '');
    if (!fileName.toLowerCase().endsWith('.docx')
      || !objectPath.startsWith(docxUploadPrefix(req.params.lawFirmId, req.user.uid))) {
      throw new ValidationError('That upload does not belong to this template.');
    }
    try {
      await settleDirectUpload({
        objectPath,
        uploadedBy: req.user.uid,
        maxBytes: OVERLAY_UPLOAD_MAX_BYTES,
        fileName,
      });
      // Placeholder parsing requires the ZIP bytes. This is intentionally the
      // only whole-object read left in this route, after storage's size check.
      const [docxBuffer] = await bucket().file(objectPath).download();
      return await templatesService.createDocxTemplate({
        lawFirmId: req.params.lawFirmId,
        name: req.body?.name || fileName.replace(/\.[^.]+$/, ''),
        docxBuffer,
        html: req.body?.html,
        folderId: req.body?.folderId || null,
      });
    } finally {
      await bucket().file(objectPath).delete().catch(() => {});
    }
  }, 201)
);

// POST /api/lawfirms/:lawFirmId/templates/upload-overlay-init
// Opens the overlay's temporary direct-upload session. The file is copied into
// the template prefix only after storage verifies its actual size and type.
router.post('/upload-overlay-init',
  verifyToken,
  requirePermission('templates.manage'),
  uploadLimiter,
  handler(async (req) => {
    const fileName = String(req.body?.fileName || '');
    const ext = overlayExtension(fileName);
    if (!ext) {
      throw new ValidationError(`Unsupported file. Accepted formats: ${OVERLAY_UPLOAD_EXTENSIONS.join(', ')}`);
    }
    const objectPath = `${overlayUploadPrefix(req.params.lawFirmId, req.user.uid)}${randomUUID()}/source${ext}`;
    return beginDirectUpload({
      objectPath,
      contentType: String(req.body?.contentType || 'application/octet-stream'),
      uploadedBy: req.user.uid,
      maxBytes: OVERLAY_UPLOAD_MAX_BYTES,
      fileName,
      declaredSize: Number(req.body?.size) || undefined,
      origin: req.get('origin') || undefined,
      metadata: { lawFirmId: req.params.lawFirmId, templateOverlay: 'true' },
    });
  })
);

// POST /api/lawfirms/:lawFirmId/templates/upload-overlay-finalize
router.post('/upload-overlay-finalize',
  verifyToken,
  requirePermission('templates.manage'),
  uploadLimiter,
  handler(async (req) => {
    const fileName = String(req.body?.fileName || '');
    const objectPath = String(req.body?.objectPath || '');
    const prefix = overlayUploadPrefix(req.params.lawFirmId, req.user.uid);
    if (!overlayExtension(fileName) || !objectPath.startsWith(prefix)) {
      throw new ValidationError('That upload does not belong to this template.');
    }

    // The upload is scratch: copied into the template, then deleted however
    // this ends, except on a busy converter, whose 503 invites a retry of this
    // same request.
    return consumeScratchSource(() => bucket().file(objectPath).delete(), async () => {
      const settled = await settleDirectUpload({
        objectPath,
        uploadedBy: req.user.uid,
        maxBytes: OVERLAY_UPLOAD_MAX_BYTES,
        fileName,
      });
      return templatesService.createOverlayTemplateFromStored({
        lawFirmId: req.params.lawFirmId,
        name: req.body?.name || fileName.replace(/\.[^.]+$/, ''),
        sourceObjectPath: settled.objectPath,
        sourceSize: settled.size,
        sourceGeneration: settled.generation,
        originalFileName: fileName,
        originalMimeType: settled.contentType,
        folderId: req.body?.folderId || null,
      });
    });
  }, 201)
);

// GET /api/lawfirms/:lawFirmId/templates/:templateId/placements (List Document Overlay field placements)
router.get('/:templateId/placements',
  verifyToken,
  requirePermission('templates.view'),
  handler(async (req) => templatesService.listPlacements({
    lawFirmId: req.params.lawFirmId,
    templateId: req.params.templateId,
  }))
);

// PUT /api/lawfirms/:lawFirmId/templates/:templateId/placements (Replace Document Overlay field placements as a full set)
router.put('/:templateId/placements',
  verifyToken,
  requirePermission('templates.manage'),
  validate(savePlacementsSchema),
  handler(async (req) => templatesService.savePlacements({
    lawFirmId: req.params.lawFirmId,
    templateId: req.params.templateId,
    placements: req.body.placements,
    repeaters: req.body.repeaters,
  }))
);

// Placement images are uploaded to a temporary object then copied into the
// template tree after the authenticated finalize call. Only PNG and JPEG work
// with pdf-lib's image embedding path, so the allowlist is enforced at open and
// again against storage metadata at settle.
router.post('/:templateId/placement-images-init',
  verifyToken,
  requirePermission('templates.manage'),
  uploadLimiter,
  handler(async (req) => {
    const fileName = String(req.body?.fileName || 'image');
    const contentType = String(req.body?.contentType || '').toLowerCase();
    const prefix = placementImageUploadPrefix(req.params.lawFirmId, req.params.templateId, req.user.uid);
    return beginDirectUpload({
      objectPath: `${prefix}${randomUUID()}/source`,
      contentType,
      uploadedBy: req.user.uid,
      maxBytes: PLACEMENT_IMAGE_MAX_BYTES,
      allowedContentTypes: PLACEMENT_IMAGE_TYPES,
      fileName,
      declaredSize: Number(req.body?.size) || undefined,
      origin: req.get('origin') || undefined,
      metadata: { lawFirmId: req.params.lawFirmId, templateId: req.params.templateId, placementImage: 'true' },
    });
  })
);

router.post('/:templateId/placement-images-finalize',
  verifyToken,
  requirePermission('templates.manage'),
  uploadLimiter,
  handler(async (req) => {
    const objectPath = String(req.body?.objectPath || '');
    const fileName = String(req.body?.fileName || 'image');
    const prefix = placementImageUploadPrefix(req.params.lawFirmId, req.params.templateId, req.user.uid);
    if (!objectPath.startsWith(prefix)) {
      throw new ValidationError('That upload does not belong to this placement.');
    }
    try {
      const settled = await settleDirectUpload({
        objectPath,
        uploadedBy: req.user.uid,
        maxBytes: PLACEMENT_IMAGE_MAX_BYTES,
        allowedContentTypes: PLACEMENT_IMAGE_TYPES,
        fileName,
      });
      return await templatesService.uploadPlacementImageFromStored({
        lawFirmId: req.params.lawFirmId,
        templateId: req.params.templateId,
        sourceObjectPath: settled.objectPath,
        sourceSize: settled.size,
        sourceGeneration: settled.generation,
        mimeType: settled.contentType,
        fileName,
      });
    } finally {
      await bucket().file(objectPath).delete().catch(() => {});
    }
  })
);

// POST /api/lawfirms/:lawFirmId/templates/:templateId/fill (Fill a DOCX template)
//
// Answers with a link, not with the document. The filled bytes used to be the
// response body, so every fill held them twice on an instance that is also
// converting and sealing other people's documents.
//
// `fileName` is not in the fill schema and `validate()` keeps unknown fields, so
// it is attacker-controlled. It is sanitized inside the service now (the same
// expression the header used) because that is where it reaches a
// Content-Disposition the storage provider builds.
router.post('/:templateId/fill',
  verifyToken,
  templateRenderLimiter,
  requirePermission('templates.view'),
  validate(fillTemplateSchema),
  handler(async (req) => templatesService.fillTemplate({
    lawFirmId: req.params.lawFirmId,
    templateId: req.params.templateId,
    userId: req.user.uid,
    values: req.body.values,
    repeaterValues: req.body.repeaterValues,
    format: req.body.format,
    disposition: req.body.disposition,
    fileName: typeof req.body.fileName === 'string' ? req.body.fileName : '',
  }))
);

// POST /api/lawfirms/:lawFirmId/templates/:templateId/export-pdf
// Renders the filled HTML the browser sends to a PDF and answers with a link to
// it, as fill does. Chromium runs on the document worker, not in the frontend.
router.post('/:templateId/export-pdf',
  verifyToken,
  templateRenderLimiter,
  requirePermission('templates.view'),
  validate(exportTemplatePdfSchema),
  handler(async (req) => templatesService.exportTemplatePdf({
    lawFirmId: req.params.lawFirmId,
    templateId: req.params.templateId,
    userId: req.user.uid,
    html: req.body.html,
    fileName: req.body.fileName,
    disposition: req.body.disposition,
  }))
);

// GET /api/lawfirms/:lawFirmId/templates/:templateId/preview (Render a DOCX / Document Overlay template as a PDF)
router.get('/:templateId/preview',
  verifyToken,
  templateRenderLimiter,
  requirePermission('templates.view'),
  handler(async (req) => templatesService.previewTemplate({
    lawFirmId: req.params.lawFirmId,
    templateId: req.params.templateId,
    userId: req.user.uid,
  }))
);

router.post('/:templateId/upload-docx-init',
  verifyToken,
  requirePermission('templates.manage'),
  uploadLimiter,
  handler(async (req) => {
    const fileName = String(req.body?.fileName || '');
    if (!fileName.toLowerCase().endsWith('.docx')) {
      throw new ValidationError('Only DOCX files can be uploaded as DOCX templates.');
    }
    const objectPath = `${docxUploadPrefix(req.params.lawFirmId, req.user.uid)}${req.params.templateId}/${randomUUID()}/source.docx`;
    return beginDirectUpload({
      objectPath,
      contentType: String(req.body?.contentType || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      uploadedBy: req.user.uid,
      maxBytes: OVERLAY_UPLOAD_MAX_BYTES,
      fileName,
      declaredSize: Number(req.body?.size) || undefined,
      origin: req.get('origin') || undefined,
      metadata: { lawFirmId: req.params.lawFirmId, templateId: req.params.templateId, templateDocx: 'true' },
    });
  })
);

router.post('/:templateId/upload-docx-finalize',
  verifyToken,
  requirePermission('templates.manage'),
  uploadLimiter,
  handler(async (req) => {
    const fileName = String(req.body?.fileName || '');
    const objectPath = String(req.body?.objectPath || '');
    const prefix = `${docxUploadPrefix(req.params.lawFirmId, req.user.uid)}${req.params.templateId}/`;
    if (!fileName.toLowerCase().endsWith('.docx') || !objectPath.startsWith(prefix)) {
      throw new ValidationError('That upload does not belong to this template.');
    }
    try {
      await settleDirectUpload({ objectPath, uploadedBy: req.user.uid, maxBytes: OVERLAY_UPLOAD_MAX_BYTES, fileName });
      const [docxBuffer] = await bucket().file(objectPath).download();
      return await templatesService.updateDocxTemplate({
        lawFirmId: req.params.lawFirmId,
        templateId: req.params.templateId,
        name: req.body?.name,
        docxBuffer,
        html: req.body?.html,
      });
    } finally {
      await bucket().file(objectPath).delete().catch(() => {});
    }
  })
);

// GET /api/lawfirms/:lawFirmId/templates/:templateId (Get single template, includes html/docx info)
router.get('/:templateId',
  verifyToken,
  requirePermission('templates.view'),
  handler(async (req) => templatesService.getTemplate({
    lawFirmId: req.params.lawFirmId,
    templateId: req.params.templateId,
  }))
);

// PUT /api/lawfirms/:lawFirmId/templates/:templateId (Update an HTML template)
router.put('/:templateId',
  verifyToken,
  requirePermission('templates.manage'),
  validate(updateTemplateSchema),
  handler(async (req) => {
    // Same reasoning as the create route above: body fields first, trusted URL
    // params last, so a lawFirmId/templateId in the body can't override which
    // firm or template the update actually lands on.
    const result = await templatesService.updateTemplate({
      ...req.body,
      lawFirmId: req.params.lawFirmId,
      templateId: req.params.templateId,
    });
    return result;
  })
);

// DELETE /api/lawfirms/:lawFirmId/templates/:templateId (Delete a template)
router.delete('/:templateId',
  verifyToken,
  requirePermission('templates.manage'),
  handler(async (req) => templatesService.deleteTemplate({
    lawFirmId: req.params.lawFirmId,
    templateId: req.params.templateId,
  }))
);

// --- Periodic GC sweep: reconcile orphaned template GCS objects ---
// deleteTemplate is best-effort and swallows GCS failures, so objects under
// lawfirmids/{firm}/templates/ can be orphaned (no live row references them).
// This sweep lists those objects and removes the orphans. Mirrors the
// signing/invitation cleanup-timer schedule (30s after startup, then every
// 24h) and is .unref()'d so it never blocks process exit.
//
// SAFE BY DEFAULT: the timer runs in dry-run mode (logs orphan counts only)
// unless TEMPLATES_GC_DELETE=true is explicitly set. For an on-demand, fully
// controllable run use the maintenance script `npx tsx scripts/gc-template-assets.ts`.
const TEMPLATES_GC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const TEMPLATES_GC_DELETE = process.env.TEMPLATES_GC_DELETE === 'true';

async function sweepOrphanedTemplateObjects() {
  // Renders are collected on every pass, not gated by TEMPLATES_GC_DELETE. The
  // dry-run switch guards a sweep that decides what is an orphan by inspecting
  // live rows; a render is transient by construction and its age is the whole
  // decision, so there is nothing here for a dry run to protect.
  try {
    const renders = await templatesService.sweepExpiredRenders();
    if (renders > 0) console.log(`[templates gc] collected ${renders} expired render(s)`);
  } catch (err: any) {
    console.error('[templates gc] render sweep failed:', err.message);
  }

  try {
    const results = await templatesService.gcSweep({ dryRun: !TEMPLATES_GC_DELETE });
    const totalOrphans = results.reduce((sum: any, r: any) => sum + (r.orphanCount || 0), 0);
    const totalDeleted = results.reduce((sum: any, r: any) => sum + (r.deleted || 0), 0);
    console.log(
      `[templates gc] swept ${results.length} firm(s): ${totalOrphans} orphan(s)` +
      (TEMPLATES_GC_DELETE ? `, ${totalDeleted} deleted` : ' (dry-run, set TEMPLATES_GC_DELETE=true to delete)')
    );
  } catch (err: any) {
    console.error('[templates gc] sweep failed:', err.message);
  }
}

// NOTE: this sweep used to run 30s after boot and then every 24 hours on a
// setInterval. Both were ineffective on Cloud Run: under request-based CPU
// allocation a timer only gets CPU while a request happens to be in flight, and
// at min-instances=0 no instance lives 24 hours, so the interval never fired and
// the boot sweep ran on EVERY cold start of EVERY instance instead — an N-fold
// thundering herd 30 seconds after each deploy, each one listing every firm's
// GCS prefix. It is now driven by POST /api/cron/housekeeping.

// The router with the cron sweep attached, which is how the housekeeping
// endpoint reaches it.
export = Object.assign(router, { sweepOrphanedTemplateObjects });
