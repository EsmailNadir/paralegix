const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../shared/middleware/auth');
const { validate } = require('../../shared/middleware/validate');
const { requirePermission } = require('../lawfirms/roles/requirePermission');
const { ValidationError } = require('../../shared/errors/AppError');
const { parseSortModel, parseIdList } = require('../../shared/database/pagination');
const { resolveCalendarRange } = require('../../shared/utils/calendarRange');
const {
  createClientSchema,
  updateClientSchema,
  listClientsSchema,
  listAllClientEventsSchema,
  lookupClientsSchema,
  updateClientMattersSchema,
  createClientContactSchema,
  updateClientContactSchema,
  updateClientBillingRatesSchema,
} = require('./clients.validation');
const {
  listClientEventsSchema,
  createClientEventSchema,
  updateClientEventSchema,
} = require('./clientEvents.validation');
const clientsService = require('./clients.service');
const clientEventsService = require('./clientEvents.service');
const clientSummaryService = require('./clientSummary.service');
const portalService = require('./portal/portal.service');
const { requireTimezone } = require('../../shared/middleware/timezone');
import { handler } from '../../shared/http/handler';

// POST /api/lawfirms/:lawFirmId/clients
router.post('/',
  verifyToken,
  requirePermission('clients.manage'),
  validate(createClientSchema),
  handler(async (req) => clientsService.createClient({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    body: req.body,
  }), 201)
);

// GET /api/lawfirms/:lawFirmId/clients/events (all standalone client events, for calendar)
router.get('/events',
  verifyToken,
  requirePermission('clients.view'),
  validate(listAllClientEventsSchema),
  requireTimezone,
  handler(async (req) => clientEventsService.listAllClientEvents({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    timezone: req.tz,
    range: resolveCalendarRange({ from: req.query.from, to: req.query.to, timezone: req.tz }),
  }))
);

// GET /api/lawfirms/:lawFirmId/clients
// With `?ids=a,b,c` -> batch resolve full client profiles in one query (kills the
// frontend getClientProfilesByIds N+1). Without `ids` -> the firm client list,
// with optional server-side `search`, `sort`/`sortBy`+`order`, and `limit`/`page`
// windowing. Omitting `limit` returns every client as `{ clients }`; supplying it
// adds `totalItems`.
router.get('/',
  verifyToken,
  requirePermission('clients.view'),
  validate(listClientsSchema),
  handler(async (req, res) => {
    if (typeof req.query.ids === 'string' && req.query.ids.trim() !== '') {
      // Cap the batch resolve so a single request can't build an unbounded
      // IN-list (mirrors the trust-ledger limit bound). Over-cap requests are
      // REJECTED (not silently truncated) so a caller passing too many ids gets
      // a clear 400 and pages explicitly rather than losing ids without notice.
      const MAX_BATCH_IDS = 200;
      const ids = req.query.ids
        .split(',')
        .map((s: any) => s.trim())
        .filter(Boolean);
      if (ids.length > MAX_BATCH_IDS) {
        throw new ValidationError({
          ids: [`Too many ids: ${ids.length} requested, maximum is ${MAX_BATCH_IDS} per request. Page the request into smaller batches.`],
        });
      }
      const result = await clientsService.getClientsByIds({
        lawFirmId: req.params.lawFirmId,
        userId: req.user.uid,
        ids,
      });
      res.status(200).json(result);
      return;
    }
    const { page, limit, offset, search, sortBy, order, sort, matterId, status, clientType } = req.query;
    const result = await clientsService.listClients({
      lawFirmId: req.params.lawFirmId,
      userId: req.user.uid,
      portalOnly: req.query.portalOnly === 'true',
      matterId, status, clientType,
      page, limit, offset, search,
      sortBy, order, sort: parseSortModel(sort),
    });
    res.status(200).json(result);
  })
);

// GET /api/lawfirms/:lawFirmId/clients/lookup
//
// Responds with `{ items, hasMore }` rather than the usual `{ items, totalItems }`
// list envelope. This endpoint backs a typeahead that fires on every keystroke, and
// `totalItems` would add a second count query to each one; `hasMore` instead falls
// out of the limit+1 row fetch the repository already does. Deliberate deviation,
// not an oversight.
//
// `excludeArchived=true` drops archived clients from the browsable result, for the
// pickers that attach a client to new work (the trust screens in particular). It
// still resolves archived clients by id so an existing selection stays labelled;
// every item carries `status` so a caller can tell which it got.
router.get('/lookup',
  verifyToken,
  requirePermission('clients.view'),
  validate(lookupClientsSchema),
  handler(async (req) => clientsService.lookupClients({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    search: req.query.search,
    exactName: req.query.exactName,
    exactOrganization: req.query.exactOrganization,
    excludeId: req.query.excludeId,
    ids: parseIdList(req.query.ids),
    // The same comma-separated list, keyed on the linked portal account's
    // Firebase UID, for pickers whose value identifies a person rather than a
    // client record. The schema rejects a request that sends both.
    userIds: parseIdList(req.query.userIds),
    portalOnly: req.query.portalOnly === 'true',
    matterId: req.query.matterId,
    clientType: req.query.clientType,
    excludeArchived: req.query.excludeArchived === 'true',
    excludeLinkedToClientId: req.query.excludeLinkedToClientId,
    full: req.query.full === 'true',
    limit: req.query.limit,
  }))
);

// GET /api/lawfirms/:lawFirmId/clients/:clientId/company-relationships
// A Person client's company memberships, with the link-owned email/billing flags.
// This must be registered before the generic `/:clientId` reader.
router.get('/:clientId/company-relationships',
  verifyToken,
  requirePermission('clients.view'),
  handler(async (req) => clientsService.listClientCompanyRelationships({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
  }))
);

// GET /api/lawfirms/:lawFirmId/clients/:clientId/summary
// The client detail header figures, counted in SQL:
// `{ clientId, matters: { count } | null, billing: { invoiceCount,
// totalBilledCents, totalPaidCents, outstandingCents } | null }`. `matters` is
// null without `matters.view`, `billing` null without `billing.viewInvoices`.
router.get('/:clientId/summary',
  verifyToken,
  requirePermission('clients.view'),
  handler(async (req) => clientSummaryService.getClientSummary({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    userId: req.user.uid,
    member: req.member,
  }))
);

// GET /api/lawfirms/:lawFirmId/clients/:clientId
router.get('/:clientId',
  verifyToken,
  requirePermission('clients.view'),
  handler(async (req) => clientsService.getClient({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    userId: req.user.uid,
  }))
);

// PUT /api/lawfirms/:lawFirmId/clients/:clientId
router.put('/:clientId',
  verifyToken,
  requirePermission('clients.manage'),
  validate(updateClientSchema),
  handler(async (req) => clientsService.updateClient({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    body: req.body,
  }))
);

// DELETE /api/lawfirms/:lawFirmId/clients/:clientId
router.delete('/:clientId',
  verifyToken,
  requirePermission('clients.manage'),
  handler(async (req) => clientsService.removeClient({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    actingUserId: req.user.uid,
  }))
);

// POST /api/lawfirms/:lawFirmId/clients/:clientId/revoke-portal-access
router.post('/:clientId/revoke-portal-access',
  verifyToken,
  requirePermission('clients.manage'),
  handler(async (req) => clientsService.revokePortalAccess({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
  }))
);

// POST /api/lawfirms/:lawFirmId/clients/:clientId/matters
router.post('/:clientId/matters',
  verifyToken,
  requirePermission('clients.manage'),
  validate(updateClientMattersSchema),
  handler(async (req) => clientsService.addClientMatters({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    matterIds: req.body.matterIds,
    actingUserId: req.user.uid,
  }))
);

// DELETE /api/lawfirms/:lawFirmId/clients/:clientId/matters/:matterId
router.delete('/:clientId/matters/:matterId',
  verifyToken,
  requirePermission('clients.manage'),
  handler(async (req) => clientsService.removeClientMatter({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    matterId: req.params.matterId,
    actingUserId: req.user.uid,
  }))
);

// GET /api/lawfirms/:lawFirmId/clients/:clientId/matters
router.get('/:clientId/matters',
  verifyToken,
  requirePermission('clients.view'),
  handler(async (req) => clientsService.listClientMatters({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    userId: req.user.uid,
  }))
);

// GET /api/lawfirms/:lawFirmId/clients/:clientId/portal-files
// Firm-side preview of every file this client can see in their portal (matter +
// standalone-task + own client-area shares, with folder inheritance applied).
router.get('/:clientId/portal-files',
  verifyToken,
  requirePermission('files.view'),
  handler(async (req) => portalService.listClientVisibleDocumentsForFirm({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
  }))
);

// GET /api/lawfirms/:lawFirmId/clients/:clientId/tasks
// Standalone tasks the client is linked to (for the firm-side share-files picker).
router.get('/:clientId/tasks',
  verifyToken,
  requirePermission('files.view'),
  handler(async (req) => clientsService.listClientStandaloneTasks({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
  }))
);

// Notes: see notes.routes.ts (mounted alongside this router in app.ts),
// which uses the shared notes engine matter/task/client notes all share.

// GET /api/lawfirms/:lawFirmId/clients/:clientId/contacts
router.get('/:clientId/contacts',
  verifyToken,
  requirePermission('clients.view'),
  handler(async (req) => clientsService.listClientContacts({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
  }))
);

// POST /api/lawfirms/:lawFirmId/clients/:clientId/contacts
router.post('/:clientId/contacts',
  verifyToken,
  requirePermission('clients.manage'),
  validate(createClientContactSchema),
  handler(async (req) => clientsService.createClientContact({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    actingUserId: req.user.uid,
    body: req.body,
  }), 201)
);

// PUT /api/lawfirms/:lawFirmId/clients/:clientId/contacts/:linkId
// Edits the relationship (relationship label, primary/billing flags) only -
// the linked person's own name/email/phone are edited through the ordinary
// client update endpoint, since they belong to that person's own record.
router.put('/:clientId/contacts/:linkId',
  verifyToken,
  requirePermission('clients.manage'),
  validate(updateClientContactSchema),
  handler(async (req) => clientsService.updateClientContact({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    linkId: req.params.linkId,
    actingUserId: req.user.uid,
    body: req.body,
  }))
);

// DELETE /api/lawfirms/:lawFirmId/clients/:clientId/contacts/:linkId
// Takes the person off this company; the person's own client record survives.
router.delete('/:clientId/contacts/:linkId',
  verifyToken,
  requirePermission('clients.manage'),
  handler(async (req) => clientsService.deleteClientContact({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    linkId: req.params.linkId,
  }))
);

// GET /api/lawfirms/:lawFirmId/clients/:clientId/events
router.get('/:clientId/events',
  verifyToken,
  requirePermission('clients.view'),
  validate(listClientEventsSchema),
  requireTimezone,
  handler(async (req) => clientEventsService.listClientEvents({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    userId: req.user.uid,
    timezone: req.tz,
    status: req.query.status,
    page: req.query.page,
    limit: req.query.limit,
    offset: req.query.offset,
  }))
);

// POST /api/lawfirms/:lawFirmId/clients/:clientId/events
router.post('/:clientId/events',
  verifyToken,
  requirePermission('clients.manage'),
  validate(createClientEventSchema),
  requireTimezone,
  handler(async (req) => {
    // Server-owned fields are spread FIRST and the trusted, route-derived
    // values applied AFTER, so a `lawFirmId`/`clientId` that survives
    // validation in the body can never override the URL's tenant/client.
    // `validate()`'s write-back merges the parsed body over the RAW one
    // rather than replacing it, so an unknown key zod stripped from the
    // parsed body is still sitting in `req.body` afterwards; the older
    // `{ lawFirmId: req.params.lawFirmId, ...req.body }` order let that
    // surviving key win.
    const result = await clientEventsService.createClientEvent({
      ...req.body,
      lawFirmId: req.params.lawFirmId,
      clientId: req.params.clientId,
      userId: req.user.uid,
      timezone: req.tz,
    });
    return result;
  }, 201)
);

// PUT /api/lawfirms/:lawFirmId/clients/:clientId/events/:eventId
router.put('/:clientId/events/:eventId',
  verifyToken,
  requirePermission('clients.manage'),
  validate(updateClientEventSchema),
  requireTimezone,
  handler(async (req) => {
    // Same ordering fix as the create route above: the URL identifies which
    // event/client/firm is being edited, so an `eventId`/`clientId`/`lawFirmId`
    // surviving in the body must never be able to redirect the write elsewhere.
    const result = await clientEventsService.updateClientEvent({
      ...req.body,
      lawFirmId: req.params.lawFirmId,
      clientId: req.params.clientId,
      eventId: req.params.eventId,
      userId: req.user.uid,
      timezone: req.tz,
    });
    return result;
  })
);

// GET /api/lawfirms/:lawFirmId/clients/:clientId/billing-rates
router.get('/:clientId/billing-rates',
  verifyToken,
  requirePermission('billing.viewRates'),
  handler(async (req) => clientsService.getClientBillingRates({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
  }))
);

// PUT /api/lawfirms/:lawFirmId/clients/:clientId/billing-rates
router.put('/:clientId/billing-rates',
  verifyToken,
  requirePermission('billing.manageRates'),
  validate(updateClientBillingRatesSchema),
  handler(async (req) => clientsService.updateClientBillingRates({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    body: req.body,
  }))
);

// DELETE /api/lawfirms/:lawFirmId/clients/:clientId/events/:eventId
router.delete('/:clientId/events/:eventId',
  verifyToken,
  requirePermission('clients.manage'),
  handler(async (req) => clientEventsService.deleteClientEvent({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    eventId: req.params.eventId,
    userId: req.user.uid,
    source: req.query.source,
    matterId: req.query.matterId,
  }))
);

export = router;
