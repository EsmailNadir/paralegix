const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../shared/middleware/auth');
const { validate } = require('../../shared/middleware/validate');
const { requirePermission } = require('../lawfirms/roles/requirePermission');
const { parseSortModel } = require('../../shared/database/pagination');
const {
  createLeadSchema,
  updateLeadSchema,
  listLeadsSchema,
  convertLeadSchema,
} = require('./leads.validation');
const leadsService = require('./leads.service');
const intakeSendService = require('./intakeSend.service');
const { sendIntakeFormSchema } = require('./intakeForms.validation');
import { handler } from '../../shared/http/handler';

// GET /api/lawfirms/:lawFirmId/leads
router.get('/',
  verifyToken,
  requirePermission('leads.view'),
  validate(listLeadsSchema),
  handler(async (req) => {
    const { page, limit, offset, search, stageId, sortBy, order, sort } = req.query;
    const result = await leadsService.listLeads({
      lawFirmId: req.params.lawFirmId,
      userId: req.user.uid,
      search,
      stageId,
      page,
      limit,
      offset,
      sortBy,
      order,
      sort: parseSortModel(sort),
    });
    return result;
  }),
);

// POST /api/lawfirms/:lawFirmId/leads
router.post('/',
  verifyToken,
  requirePermission('leads.manage'),
  validate(createLeadSchema),
  handler(async (req) => leadsService.createLead({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    body: req.body,
  }), 201),
);

// POST /api/lawfirms/:lawFirmId/leads/:leadId/convert (before /:leadId generic)
router.post('/:leadId/convert',
  verifyToken,
  requirePermission('leads.convert'),
  validate(convertLeadSchema),
  handler(async (req) => leadsService.convertLead({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    leadId: req.params.leadId,
    body: req.body,
  })),
);

// POST /api/lawfirms/:lawFirmId/leads/:leadId/send-intake-form
router.post('/:leadId/send-intake-form',
  verifyToken,
  requirePermission('leads.manage'),
  validate(sendIntakeFormSchema),
  handler(async (req) => intakeSendService.sendIntakeForm({
    lawFirmId: req.params.lawFirmId,
    leadId: req.params.leadId,
    intakeFormTemplateId: req.body.intakeFormTemplateId,
    email: req.body.email,
    sentByUserId: req.user.uid,
  }), 201),
);

// GET /api/lawfirms/:lawFirmId/leads/:leadId
router.get('/:leadId',
  verifyToken,
  requirePermission('leads.view'),
  handler(async (req) => leadsService.getLead({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    leadId: req.params.leadId,
  })),
);

// PUT /api/lawfirms/:lawFirmId/leads/:leadId
router.put('/:leadId',
  verifyToken,
  requirePermission('leads.manage'),
  validate(updateLeadSchema),
  handler(async (req) => leadsService.updateLead({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    leadId: req.params.leadId,
    body: req.body,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/leads/:leadId
router.delete('/:leadId',
  verifyToken,
  requirePermission('leads.manage'),
  handler(async (req) => leadsService.deleteLead({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    leadId: req.params.leadId,
  })),
);

export = router;
