const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../../shared/middleware/auth');
const { validate } = require('../../../shared/middleware/validate');
const { requirePermission } = require('../../lawfirms/roles/requirePermission');

const {
  addClientSchema,
  listClientsForMattersSchema,
  updateClientSchema,
  setBillingPortionsSchema,
} = require('./matterClients.validation');
const matterClientsService = require('./matterClients.service');
import { handler } from '../../../shared/http/handler';

// GET /api/lawfirms/:lawFirmId/matters/clients?matterIds=a,b,c
//
// The clients of several matters in one request, for a page holding a list of
// matters (an invoice run) that would otherwise call the per-matter route once
// per matter and take most of the instance's 12-connection pool on its own.
// Above the `/:matterId` routes so "clients" is never read as a matter id, and
// the whole router is mounted ahead of matters.routes.ts's own `/:matterId`.
router.get('/clients',
  verifyToken,
  requirePermission('matters.view'),
  validate(listClientsForMattersSchema),
  handler(async (req) => matterClientsService.listClientsForMatters({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    // `validate` writes the schema's transform back onto the query, so this is
    // the split and capped array, not the raw comma-separated string.
    matterIds: req.query.matterIds as unknown as string[],
  })),
);

// GET /api/lawfirms/:lawFirmId/matters/:matterId/clients
router.get('/:matterId/clients',
  verifyToken,
  requirePermission('matters.view'),
  handler(async (req) => matterClientsService.listClients({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    userId: req.user.uid,
  })),
);

// PUT /api/lawfirms/:lawFirmId/matters/:matterId/clients/billing-portions
// Sits above the /:clientId routes so "billing-portions" is never read as an id.
router.put('/:matterId/clients/billing-portions',
  verifyToken,
  requirePermission('matters.manageClients'),
  validate(setBillingPortionsSchema),
  handler(async (req) => matterClientsService.setBillingPortions({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    userId: req.user.uid,
    portions: req.body.portions,
  })),
);

// POST /api/lawfirms/:lawFirmId/matters/:matterId/clients
router.post('/:matterId/clients',
  verifyToken,
  requirePermission('matters.manageClients'),
  validate(addClientSchema),
  handler(async (req) => matterClientsService.addClient({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    userId: req.user.uid,
    client: req.body.client,
  }), 201),
);

// PUT /api/lawfirms/:lawFirmId/matters/:matterId/clients/:clientId
router.put('/:matterId/clients/:clientId',
  verifyToken,
  requirePermission('matters.manageClients'),
  // The edit rewrites the shared client record, so it is a client edit.
  requirePermission('clients.manage'),
  validate(updateClientSchema),
  handler(async (req) => matterClientsService.updateClient({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    clientId: req.params.clientId,
    userId: req.user.uid,
    client: req.body.client,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/matters/:matterId/clients/:clientId
router.delete('/:matterId/clients/:clientId',
  verifyToken,
  requirePermission('matters.manageClients'),
  handler(async (req) => matterClientsService.removeClient({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    clientId: req.params.clientId,
    userId: req.user.uid,
  })),
);

export = router;
