import type { NextFunction, Response } from 'express';
import type { AuthedRequest } from '../../shared/http/handler';
const express = require('express');
const router = express.Router();
const { admin } = require('../../shared/database/firebase');
const { verifyToken, requireUserType } = require('../../shared/middleware/auth');
const { validate } = require('../../shared/middleware/validate');
const { requirePermission } = require('./roles/requirePermission');
const { createLawFirmSchema, updateLawFirmSchema } = require('./lawfirms.validation');
const lawfirmsService = require('./lawfirms.service');
const lawfirmsRepo = require('./lawfirms.repository');
const { AppError, ForbiddenError, ValidationError } = require('../../shared/errors/AppError');
const { invalidatePhotoPrefix } = require('../../shared/utils/userPhoto');
const { runWithConcurrency } = require('../../shared/utils/runWithConcurrency');
import { handler } from '../../shared/http/handler';
import { beginDirectUpload, settleDirectUpload } from '../../shared/storage/directUpload';

const BUCKET_NAME = process.env.GCS_BUCKET || 'lawfirms';
// Stale logo objects deleted at once. The folder holds one object per extension
// an earlier upload used, so this is small by construction; the cap keeps a
// folder that somehow grew from putting an unbounded number of GCS deletes in
// flight on the request path.
const LOGO_DELETE_CONCURRENCY = Number(process.env.PHOTO_DELETE_CONCURRENCY) || 8;
const ALLOWED_LOGO_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_LOGO_SIZE = 5 * 1024 * 1024; // 5MB

/** File extension for a stored logo, from the type rather than the file name. */
const LOGO_EXTENSION_FOR: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
};

/** The folder holding one firm's logo objects. */
const logoPrefixFor = (lawFirmId: string) => `lawfirmids/${lawFirmId}/logo/`;

// POST /api/lawfirms/create-lawfirm (Create new law firm)
router.post('/create-lawfirm',
  verifyToken,
  // Without this, any authenticated user (client/pending) could hit this
  // endpoint directly and become an Owner, bypassing the frontend's UI-only radio.
  requireUserType(['firm_member']),
  validate(createLawFirmSchema),
  handler(async (req) => {
    const result = await lawfirmsService.createLawFirm({
      name: req.body.name,
      userId: req.user.uid,
      firmSize: req.body.firmSize,
      practiceArea: req.body.practiceArea,
    });
    return { message: 'Law firm created', lawFirmId: result.lawFirmId };
  }, 201)
);

// GET /api/lawfirms/:lawFirmId (Get law firm details)
router.get('/:lawFirmId',
  verifyToken,
  requirePermission('members.view'), // Any member can view
  handler(async (req, res) => {
    const firm = await lawfirmsService.getLawFirm(req.params.lawFirmId);
    res.json(firm);
  })
);

// PUT /api/lawfirms/:lawFirmId (Update law firm info)
router.put('/:lawFirmId',
  verifyToken,
  requirePermission('firm.update'),
  validate(updateLawFirmSchema),
  handler(async (req, res) => {
    const result = await lawfirmsService.updateLawFirm(
      req.params.lawFirmId,
      req.body
    );
    res.json(result);
  })
);

// PATCH /api/lawfirms/:lawFirmId/billing-settings (Update billing reminder settings)
router.patch('/:lawFirmId/billing-settings',
  verifyToken,
  requirePermission('firm.update'),
  handler(async (req, res) => {
    const { invoiceReminderEnabled, invoiceReminderDays, defaultPreDueReminderDays } = req.body;
    // Stored under settings jsonb where invoiceReminders.service reads them.
    const patch: Record<string, any> = {};
    if (typeof invoiceReminderEnabled === 'boolean') patch.invoiceReminderEnabled = invoiceReminderEnabled;
    if (Array.isArray(invoiceReminderDays)) patch.invoiceReminderDays = invoiceReminderDays.map(Number).filter(n => n > 0);
    if (defaultPreDueReminderDays === null) patch.defaultPreDueReminderDays = null;
    else if (typeof defaultPreDueReminderDays === 'number' && defaultPreDueReminderDays > 0) patch.defaultPreDueReminderDays = defaultPreDueReminderDays;
    await lawfirmsRepo.mergeSettings(req.params.lawFirmId, patch);
    res.json({ message: 'Billing settings updated' });
  })
);

// The logo uploads straight to storage. It used to arrive here as multipart and
// sit in the container's heap before the handler ran, on an instance serving 80
// concurrent requests on 512 MiB that also signs documents. The type and size
// rules did not change; they now apply to what STORAGE recorded, because a
// resumable session URL enforces neither.
//
// `firm.manageBranding` guards BOTH steps. It used to guard one route, and a
// finalize without it would be a way to change a firm's branding without the
// permission.

// POST /api/lawfirms/:lawFirmId/logo/upload-init
router.post('/:lawFirmId/logo/upload-init',
  verifyToken,
  requirePermission('firm.manageBranding'),
  handler(async (req, res) => {
    const { lawFirmId } = req.params;
    // The extension comes from the CONTENT TYPE, never from the submitted file
    // name. A name is caller input that reaches an object path.
    const type = String(req.body?.contentType || '').toLowerCase().split(';')[0].trim();
    const ext = LOGO_EXTENSION_FOR[type];
    // 415, matching what the shared helper answers for a type refusal and what
    // the status means. The multipart route answered 400 because multer's
    // fileFilter had no way to say otherwise.
    if (!ext) {
      throw new AppError(
        'Invalid file type. Only JPEG, PNG, GIF, or WebP allowed.', 415, 'FILE_TYPE_NOT_ALLOWED',
      );
    }

    const opened = await beginDirectUpload({
      objectPath: `${logoPrefixFor(lawFirmId)}logo.${ext}`,
      contentType: type,
      uploadedBy: req.user.uid,
      maxBytes: MAX_LOGO_SIZE,
      allowedContentTypes: ALLOWED_LOGO_TYPES,
      fileName: req.body?.fileName || `logo.${ext}`,
      declaredSize: Number(req.body?.size) || undefined,
      origin: req.get('origin') || undefined,
      // The path is reused across re-uploads, so no intermediary may hold these
      // bytes under a URL that will later be a different logo.
      metadata: { cacheControl: 'private, max-age=0, no-transform' },
    });
    res.json(opened);
  })
);

// POST /api/lawfirms/:lawFirmId/logo/upload-finalize
router.post('/:lawFirmId/logo/upload-finalize',
  verifyToken,
  requirePermission('firm.manageBranding'),
  handler(async (req, res) => {
    const { lawFirmId } = req.params;
    const logoPrefix = logoPrefixFor(lawFirmId);
    const destPath = String(req.body?.objectPath || '');
    // The path arrives from the client. Unchecked, it points this firm's
    // branding at any object in the bucket, another firm's documents included.
    if (!destPath.startsWith(logoPrefix) || destPath.slice(logoPrefix.length).includes('/')) {
      throw new ValidationError('That upload does not belong to this firm.');
    }

    await settleDirectUpload({
      objectPath: destPath,
      uploadedBy: req.user.uid,
      maxBytes: MAX_LOGO_SIZE,
      allowedContentTypes: ALLOWED_LOGO_TYPES,
      fileName: String(req.body?.fileName || 'logo'),
    });

    await lawfirmsRepo.update(lawFirmId, { logoObjectPath: destPath });

    // Drop logos left at other extensions by earlier uploads, plus every
    // cached signed URL for the folder. Re-uploading to the same path would
    // otherwise keep resolving to the previous image.
    const bucket = admin.storage().bucket(BUCKET_NAME);
    const [existing] = await bucket.getFiles({ prefix: logoPrefix }).catch(() => [[]]);
    await runWithConcurrency(
      existing.filter((f: any) => f.name !== destPath).map((f: any) => () => f.delete().catch(() => {})),
      LOGO_DELETE_CONCURRENCY,
    );
    invalidatePhotoPrefix(logoPrefix);

    const firm = await lawfirmsService.getLawFirm(lawFirmId);
    res.json({ message: 'Logo uploaded successfully', lawFirm: firm });
  })
);

// DELETE /api/lawfirms/:lawFirmId/logo (Delete law firm logo)
router.delete('/:lawFirmId/logo',
  verifyToken,
  requirePermission('firm.manageBranding'),
  handler(async (req, res) => {
    const { lawFirmId } = req.params;
    const bucket = admin.storage().bucket(BUCKET_NAME);

    // Delete all files under the logo prefix
    const logoPrefix = `lawfirmids/${lawFirmId}/logo/`;
    await bucket.deleteFiles({ prefix: logoPrefix, force: true });
    invalidatePhotoPrefix(logoPrefix);

    await lawfirmsRepo.update(lawFirmId, { logoObjectPath: null });

    const firm = await lawfirmsService.getLawFirm(lawFirmId);
    res.json({ message: 'Logo deleted successfully', lawFirm: firm });
  })
);

// DELETE /api/lawfirms/:lawFirmId (Schedule law firm for deletion)
// Soft-delete: access is revoked and billing stopped immediately, but the data
// is retained until the retention window clears (see lawfirms.service.ts).
router.delete('/:lawFirmId',
  verifyToken,
  requirePermission('firm.delete'),
  handler(async (req, res) => {
    const firm = await lawfirmsService.requestLawFirmDeletion(req.params.lawFirmId, req.user.uid);
    res.json({
      message: 'Law firm scheduled for deletion. Data is retained until the legal retention period clears.',
      deletionPurgeAfter: firm.deletionPurgeAfter,
    });
  })
);

// POST /api/lawfirms/:lawFirmId/restore-deletion (Undo a pending deletion)
// Deliberately checked directly against `members` rather than through
// requirePermission/assertLawFirmMembership: those treat a pending-deletion
// firm as if it doesn't exist, which would make this endpoint unreachable by
// the very owner who needs to call it.
router.post('/:lawFirmId/restore-deletion',
  verifyToken,
  async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const membersRepo = require('./members/members.repository');
    const member = await membersRepo.findByUserId(req.params.lawFirmId, req.user.uid);
    if (!member?.isOwner) {
      return next(new ForbiddenError('Only the firm owner can restore a pending deletion'));
    }
    const firm = await lawfirmsService.restoreLawFirm(req.params.lawFirmId);
    res.json({ message: 'Law firm deletion cancelled', lawFirm: firm });
  }
);

export = router;
