const express = require('express');
const router = express.Router({ mergeParams: true });
const { verifyToken } = require('../../shared/middleware/auth');
const { validate } = require('../../shared/middleware/validate');
const { requirePermission } = require('../lawfirms/roles/requirePermission');
const {
  createRequestSchema,
  updateRequestSchema,
  listRequestsSchema,
  updateItemSchema,
  linkItemFileSchema,
  unlinkItemFileSchema,
  listClientRequestsSchema,
} = require('./documentRequests.validation');
const service = require('./documentRequests.service');
import { handler } from '../../shared/http/handler';

// GET /api/lawfirms/:lawFirmId/document-requests?matterId=... (List for a matter)
router.get('/',
  verifyToken,
  requirePermission('documents.request'),
  validate(listRequestsSchema),
  handler(async (req) => service.listRequests({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    matterId: req.query.matterId,
    page: req.query.page,
    limit: req.query.limit,
    offset: req.query.offset,
  }))
);

// POST /api/lawfirms/:lawFirmId/document-requests (Create a request)
router.post('/',
  verifyToken,
  requirePermission('documents.request'),
  validate(createRequestSchema),
  handler(async (req) => service.createRequest({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    matterId: req.body.matterId,
    clientId: req.body.clientId,
    title: req.body.title,
    note: req.body.note,
    dueDate: req.body.dueDate,
    items: req.body.items,
    contactClientId: req.body.contactClientId,
  }), 201)
);

// GET /api/lawfirms/:lawFirmId/document-requests/clients/:clientId
// Every request addressed to one client, unpaginated: general ones plus those on
// matters the caller may read. No matter in the path, so the service applies the
// matter read rule per row. Placed before the /:id routes so Express doesn't try
// to match "clients" as a request id.
router.get('/clients/:clientId',
  verifyToken,
  requirePermission('documents.request'),
  validate(listClientRequestsSchema),
  handler(async (req) => service.listClientRequestsForMember({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    clientId: req.params.clientId,
  }))
);

// GET /api/lawfirms/:lawFirmId/document-requests/:id (Get one request)
router.get('/:id',
  verifyToken,
  requirePermission('documents.request'),
  handler(async (req) => service.getRequest({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    requestId: req.params.id,
  }))
);

// PATCH /api/lawfirms/:lawFirmId/document-requests/:id (Edit / add items / status)
router.patch('/:id',
  verifyToken,
  requirePermission('documents.request'),
  validate(updateRequestSchema),
  handler(async (req) => service.updateRequest({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    requestId: req.params.id,
    title: req.body.title,
    note: req.body.note,
    status: req.body.status,
    dueDate: req.body.dueDate,
    addItems: req.body.addItems,
  }))
);

// DELETE /api/lawfirms/:lawFirmId/document-requests/:id (Delete a request)
router.delete('/:id',
  verifyToken,
  requirePermission('documents.request'),
  handler(async (req) => service.deleteRequest({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    requestId: req.params.id,
  }))
);

// PATCH /api/lawfirms/:lawFirmId/document-requests/:id/items/:itemId (Mark received/waived)
router.patch('/:id/items/:itemId',
  verifyToken,
  requirePermission('documents.request'),
  validate(updateItemSchema),
  handler(async (req) => service.updateItem({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    requestId: req.params.id,
    itemId: req.params.itemId,
    status: req.body.status,
  }))
);

// POST /api/lawfirms/:lawFirmId/document-requests/:id/items/:itemId/link-file
// (Attach an already-uploaded file to an item, without waiting on a client upload)
router.post('/:id/items/:itemId/link-file',
  verifyToken,
  requirePermission('documents.request'),
  validate(linkItemFileSchema),
  handler(async (req) => service.linkFile({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    requestId: req.params.id,
    itemId: req.params.itemId,
    fileId: req.body.fileId,
  }))
);

// DELETE /api/lawfirms/:lawFirmId/document-requests/:id/items/:itemId/files/:fulfillmentId
// (Remove an uploaded or linked file from an item; the underlying file is untouched)
router.delete('/:id/items/:itemId/files/:fulfillmentId',
  verifyToken,
  requirePermission('documents.request'),
  validate(unlinkItemFileSchema),
  handler(async (req) => service.unlinkFile({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    requestId: req.params.id,
    itemId: req.params.itemId,
    fulfillmentId: req.params.fulfillmentId,
  }))
);

export = router;
