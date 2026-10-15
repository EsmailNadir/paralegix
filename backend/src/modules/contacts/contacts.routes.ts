const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../shared/middleware/auth');
const { validate } = require('../../shared/middleware/validate');
const { requirePermission } = require('../lawfirms/roles/requirePermission');
const { parseSortModel, parseIdList } = require('../../shared/database/pagination');
const { ValidationError } = require('../../shared/errors/AppError');
const {
  createContactSchema,
  updateContactSchema,
  listContactsSchema,
  lookupContactsSchema,
  checkContactDuplicateSchema,
  importContactsSchema,
  exportContactsSchema,
} = require('./contacts.validation');
const { toCsv, parseCsv, toVCard, parseVCard } = require('./contactSerializers');
const contactsService = require('./contacts.service');
import { handler } from '../../shared/http/handler';

// GET /api/lawfirms/:lawFirmId/contacts
// The firm's contact directory, with optional server-side `search`,
// `category`/`tags`/`archived` filters, `sort`/`sortBy`+`order`, and
// `limit`/`page` windowing. The response is `{ contacts, totalItems }`; omitting
// `limit` returns the largest page (500), not every contact.
router.get('/',
  verifyToken,
  requirePermission('contacts.view'),
  validate(listContactsSchema),
  handler(async (req) => {
    const { page, limit, offset, search, category, matterId, courtId, hasCourt, tags, archived, oneTime, sortBy, order, sort } = req.query;
    const result = await contactsService.listContacts({
      lawFirmId: req.params.lawFirmId,
      userId: req.user.uid,
      search, category, matterId, courtId, hasCourt, archived, oneTime,
      tags: parseIdList(tags),
      page, limit, offset,
      sortBy, order, sort: parseSortModel(sort),
    });
    return result;
  })
);

// GET /api/lawfirms/:lawFirmId/contacts/lookup
//
// Responds with `{ items, hasMore }` rather than the usual `{ items, totalItems }`
// list envelope, matching the other typeaheads: this fires on every keystroke,
// and `hasMore` falls out of the limit+1 fetch instead of a second count query.
//
// `excludeMatterId` drops the contacts already on that matter, for the picker
// that adds one to a matter. Resolution by `ids` ignores both that filter and
// the archived filter, so an existing selection stays labelled.
router.get('/lookup',
  verifyToken,
  requirePermission('contacts.view'),
  validate(lookupContactsSchema),
  handler(async (req) => contactsService.lookupContacts({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    search: req.query.search,
    ids: parseIdList(req.query.ids),
    category: req.query.category,
    excludeMatterId: req.query.excludeMatterId,
    full: req.query.full === 'true',
    limit: req.query.limit,
  }))
);

// GET /api/lawfirms/:lawFirmId/contacts/duplicate-check
// Advisory only: the create form polls this while the user types name/email,
// so it can warn about a likely match before submit. Never blocks creation.
router.get('/duplicate-check',
  verifyToken,
  requirePermission('contacts.manage'),
  validate(checkContactDuplicateSchema),
  handler(async (req) => contactsService.checkDuplicateContact({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    name: req.query.name,
    email: req.query.email,
  }))
);

// GET /api/lawfirms/:lawFirmId/contacts/tags
router.get('/tags',
  verifyToken,
  requirePermission('contacts.view'),
  handler(async (req) => contactsService.listTags({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
  }))
);

// GET /api/lawfirms/:lawFirmId/contacts/export?format=csv|vcard
//
// Answers with a file rather than the usual JSON envelope: this endpoint exists
// to be saved to disk, and the same list filters apply so an export matches
// whatever the user is looking at.
router.get('/export',
  verifyToken,
  requirePermission('contacts.view'),
  validate(exportContactsSchema),
  handler(async (req, res) => {
    const { contacts } = await contactsService.exportContacts({
      lawFirmId: req.params.lawFirmId,
      userId: req.user.uid,
      search: req.query.search,
      category: req.query.category,
      tags: parseIdList(req.query.tags),
      archived: req.query.archived,
    });

    const vcard = req.query.format === 'vcard';
    const body = vcard ? toVCard(contacts) : toCsv(contacts);
    res.setHeader('Content-Type', vcard ? 'text/vcard; charset=utf-8' : 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="contacts.${vcard ? 'vcf' : 'csv'}"`);
    res.status(200).send(body);
  })
);

// POST /api/lawfirms/:lawFirmId/contacts/import
// Takes the raw file text; rows matching an existing contact are skipped, and
// the response reports how many were imported, skipped and rejected.
router.post('/import',
  verifyToken,
  requirePermission('contacts.manage'),
  validate(importContactsSchema),
  handler(async (req) => {
    const rows = req.body.format === 'vcard'
      ? parseVCard(req.body.content)
      : parseCsv(req.body.content);
    if (!rows.length) {
      throw new ValidationError({ content: ['No contacts could be read from that file.'] });
    }
    const result = await contactsService.importContacts({
      lawFirmId: req.params.lawFirmId,
      userId: req.user.uid,
      rows,
    });
    return result;
  }, 201)
);

// GET /api/lawfirms/:lawFirmId/contacts/:contactId
router.get('/:contactId',
  verifyToken,
  requirePermission('contacts.view'),
  handler(async (req) => contactsService.getContact({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    contactId: req.params.contactId,
  }))
);

// POST /api/lawfirms/:lawFirmId/contacts
router.post('/',
  verifyToken,
  requirePermission('contacts.manage'),
  validate(createContactSchema),
  handler(async (req) => contactsService.createContact({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    data: req.body,
  }), 201)
);

// PUT /api/lawfirms/:lawFirmId/contacts/:contactId
router.put('/:contactId',
  verifyToken,
  requirePermission('contacts.manage'),
  validate(updateContactSchema),
  handler(async (req) => contactsService.updateContact({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    contactId: req.params.contactId,
    data: req.body,
  }))
);

// DELETE /api/lawfirms/:lawFirmId/contacts/:contactId
// Cascades to the matter links, so the response reports how many matters the
// contact was removed from.
router.delete('/:contactId',
  verifyToken,
  requirePermission('contacts.manage'),
  handler(async (req) => contactsService.deleteContact({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    contactId: req.params.contactId,
  }))
);

export = router;
