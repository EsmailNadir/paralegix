const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../../shared/middleware/auth');
const { validate } = require('../../../shared/middleware/validate');
const { requirePermission } = require('../../lawfirms/roles/requirePermission');

const { createContactSchema, updateContactSchema } = require('./matterContacts.validation');
const matterContactsService = require('./matterContacts.service');
import { handler } from '../../../shared/http/handler';

// GET /api/lawfirms/:lawFirmId/matters/:matterId/contacts
router.get('/:matterId/contacts',
  verifyToken,
  requirePermission('matters.view'),
  handler(async (req) => matterContactsService.listContacts({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    userId: req.user.uid,
  })),
);

// POST /api/lawfirms/:lawFirmId/matters/:matterId/contacts
router.post('/:matterId/contacts',
  verifyToken,
  requirePermission('matters.update'),
  validate(createContactSchema),
  handler(async (req) => matterContactsService.createContact({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    userId: req.user.uid,
    data: req.body,
  }), 201),
);

// PUT /api/lawfirms/:lawFirmId/matters/:matterId/contacts/:linkId
// Edits the LINK (role, matter note, display order), never the shared contact.
router.put('/:matterId/contacts/:linkId',
  verifyToken,
  requirePermission('matters.update'),
  validate(updateContactSchema),
  handler(async (req) => matterContactsService.updateContact({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    linkId: req.params.linkId,
    userId: req.user.uid,
    data: req.body,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/matters/:matterId/contacts/:linkId
// Unlinks the contact from the matter; the directory record survives.
router.delete('/:matterId/contacts/:linkId',
  verifyToken,
  requirePermission('matters.update'),
  handler(async (req) => matterContactsService.deleteContact({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    linkId: req.params.linkId,
    userId: req.user.uid,
  })),
);

export = router;
