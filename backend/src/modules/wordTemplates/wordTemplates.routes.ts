/**
 * The Word-first template library, mounted at
 * /api/lawfirms/:lawFirmId/word-templates behind verifyToken and
 * requireFeature('templates'). Reads need templates.view; writes need
 * templates.manage. Binary answers (fills, previews, exports) carry the file
 * with its Content-Disposition, and fills an X-Unfilled-Fields header.
 */
import express from 'express';
import type { Response } from 'express';
import { handler } from '../../shared/http/handler';
import { verifyToken } from '../../shared/middleware/auth';
import { validate } from '../../shared/middleware/validate';
import { optionalTimezone } from '../../shared/middleware/timezone';
import { requirePermission } from '../lawfirms/roles/requirePermission';
import { UNFILLED_FIELDS_HEADER, encodeUnfilledFields } from './lib/unfilled-fields';
import * as service from './wordTemplates.service';
import { getDocumentContext } from './documentContext.service';
import {
  assetFinalizeSchema,
  commitSchema,
  createWordTemplateSchema,
  documentContextSchema,
  exportSchema,
  fillDocxSchema,
  fillPdfSchema,
  renameWordTemplateSchema,
  replaceSourceSchema,
  settledUploadSchema,
  updateWordTemplateSchema,
  uploadDocxSchema,
  uploadInitSchema,
} from './wordTemplates.validation';

const { uploadLimiter, templateRenderLimiter } = require('../../shared/middleware/rateLimiters');

const router = express.Router({ mergeParams: true });

/** Send a produced file. */
function sendFile(res: Response, file: service.BinaryResult) {
  res.status(200);
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Disposition', file.disposition);
  res.setHeader('Cache-Control', 'no-store');
  if (file.unfilledFields) res.setHeader(UNFILLED_FIELDS_HEADER, encodeUnfilledFields(file.unfilledFields));
  res.send(file.body);
}

const ctx = (req: any) => ({ lawFirmId: req.params.lawFirmId as string, userId: req.user.uid as string });

// ── collection routes (before /:templateId) ──────────────────────────────────

router.get('/',
  verifyToken,
  requirePermission('templates.view'),
  handler(async (req) => service.listTemplates(ctx(req))));

router.post('/',
  verifyToken,
  requirePermission('templates.manage'),
  validate(createWordTemplateSchema),
  handler(async (req) => service.createHtmlTemplate({ ...ctx(req), name: req.body.name, html: req.body.html }), 201));

router.get('/document-context',
  verifyToken,
  requirePermission('templates.view'),
  validate(documentContextSchema),
  optionalTimezone,
  handler(async (req) => getDocumentContext({
    ...ctx(req),
    matterId: typeof req.query.matterId === 'string' && req.query.matterId ? req.query.matterId : undefined,
    clientId: typeof req.query.clientId === 'string' && req.query.clientId ? req.query.clientId : undefined,
    timezone: req.tz,
  })));

router.post('/upload-init',
  verifyToken,
  requirePermission('templates.manage'),
  uploadLimiter,
  validate(uploadInitSchema),
  handler(async (req) => service.openUpload({
    ...ctx(req),
    fileName: req.body.fileName,
    contentType: req.body.contentType,
    size: req.body.size,
    purpose: req.body.purpose,
    templateId: req.body.templateId,
    origin: req.get('origin') || undefined,
  })));

router.post('/detect',
  verifyToken,
  requirePermission('templates.manage'),
  validate(settledUploadSchema),
  handler(async (req) => service.detect({ ...ctx(req), objectPath: req.body.objectPath, fileName: req.body.fileName })));

router.post('/commit',
  verifyToken,
  requirePermission('templates.manage'),
  validate(commitSchema),
  handler(async (req, res) => {
    const { status, body } = await service.commit({
      ...ctx(req),
      objectPath: req.body.objectPath,
      fileName: req.body.fileName,
      name: req.body.name,
      edits: req.body.edits,
      duplicateStrategy: req.body.duplicateStrategy,
      acknowledgedLeftovers: req.body.acknowledgedLeftovers,
    });
    res.status(status).json(body);
  }));

router.post('/upload-docx',
  verifyToken,
  requirePermission('templates.manage'),
  validate(uploadDocxSchema),
  handler(async (req, res) => {
    const { status, body } = await service.uploadDocx({
      ...ctx(req),
      objectPath: req.body.objectPath,
      fileName: req.body.fileName,
      name: req.body.name,
      duplicateStrategy: req.body.duplicateStrategy,
      acknowledgedLeftovers: req.body.acknowledgedLeftovers,
    });
    res.status(status).json(body);
  }));

router.post('/convert-docx-to-pdf',
  verifyToken,
  templateRenderLimiter,
  requirePermission('templates.manage'),
  validate(settledUploadSchema),
  handler(async (req, res) => sendFile(res, await service.convertUploadToPdf({
    ...ctx(req), objectPath: req.body.objectPath, fileName: req.body.fileName,
  }))));

router.post('/export',
  verifyToken,
  templateRenderLimiter,
  requirePermission('templates.view'),
  validate(exportSchema),
  handler(async (req, res) => sendFile(res, await service.exportHtml({
    ...ctx(req),
    html: req.body.html,
    format: req.body.format,
    templateId: typeof req.body.templateId === 'string' ? req.body.templateId : undefined,
  }))));

// ── one template ─────────────────────────────────────────────────────────────

router.get('/:templateId',
  verifyToken,
  requirePermission('templates.view'),
  handler(async (req) => service.getTemplate({ ...ctx(req), templateId: req.params.templateId })));

router.put('/:templateId',
  verifyToken,
  requirePermission('templates.manage'),
  validate(updateWordTemplateSchema),
  handler(async (req) => service.updateHtmlTemplate({
    ...ctx(req), templateId: req.params.templateId, name: req.body.name, html: req.body.html,
  })));

router.patch('/:templateId',
  verifyToken,
  requirePermission('templates.manage'),
  validate(renameWordTemplateSchema),
  handler(async (req) => service.renameTemplate({ ...ctx(req), templateId: req.params.templateId, name: req.body.name })));

router.delete('/:templateId',
  verifyToken,
  requirePermission('templates.manage'),
  handler(async (req) => service.deleteTemplate({ ...ctx(req), templateId: req.params.templateId })));

router.post('/:templateId/replace-source',
  verifyToken,
  requirePermission('templates.manage'),
  validate(replaceSourceSchema),
  handler(async (req) => service.replaceTemplateSource({
    ...ctx(req),
    templateId: req.params.templateId,
    objectPath: req.body.objectPath,
    fileName: req.body.fileName,
    acknowledgedLeftovers: req.body.acknowledgedLeftovers,
  })));

router.get('/:templateId/fields',
  verifyToken,
  requirePermission('templates.view'),
  handler(async (req) => service.liveFields({ ...ctx(req), templateId: req.params.templateId })));

router.post('/:templateId/fill-docx',
  verifyToken,
  templateRenderLimiter,
  requirePermission('templates.view'),
  validate(fillDocxSchema),
  handler(async (req, res) => sendFile(res, await service.fillDocx({
    ...ctx(req),
    templateId: req.params.templateId,
    values: req.body.values,
    repeaterValues: req.body.repeaterValues,
    fileName: req.body.fileName,
    format: req.body.format,
  }))));

router.post('/:templateId/fill-pdf',
  verifyToken,
  templateRenderLimiter,
  requirePermission('templates.view'),
  validate(fillPdfSchema),
  handler(async (req, res) => sendFile(res, await service.fillPdf({
    ...ctx(req), templateId: req.params.templateId, values: req.body.values, fileName: req.body.fileName,
  }))));

router.get('/:templateId/preview-pdf',
  verifyToken,
  templateRenderLimiter,
  requirePermission('templates.view'),
  handler(async (req, res) => sendFile(res, await service.previewPdf({ ...ctx(req), templateId: req.params.templateId }))));

router.get('/:templateId/docx-source',
  verifyToken,
  requirePermission('templates.view'),
  handler(async (req, res) => {
    const body = await service.docxSource({ ...ctx(req), templateId: req.params.templateId });
    res.status(200);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Cache-Control', 'no-store');
    res.send(body);
  }));

router.post('/:templateId/assets/finalize',
  verifyToken,
  uploadLimiter,
  requirePermission('templates.manage'),
  validate(assetFinalizeSchema),
  handler(async (req) => service.finalizeAsset({
    ...ctx(req), templateId: req.params.templateId, objectPath: req.body.objectPath, fileName: req.body.fileName,
  }), 201));

export = router;
