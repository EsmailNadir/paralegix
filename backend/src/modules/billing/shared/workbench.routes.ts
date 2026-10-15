const express = require('express');
const { z } = require('zod');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../../shared/middleware/auth');
const { heavyReadLimiter } = require('../../../shared/middleware/rateLimiters');
const { validate } = require('../../../shared/middleware/validate');
const { requirePermission } = require('../../lawfirms/roles/requirePermission');
const { requireTimezone } = require('../../../shared/middleware/timezone');
const firmBillingService = require('./firmBilling.service');
const { TASK_CODES, ACTIVITY_CODES, EXPENSE_CODES } = require('../../../shared/data/utbmsCodes');

const { MAX_PAGE_OFFSET } = require('../../../shared/database/pagination');
import { handler } from '../../../shared/http/handler';
import { getCardFeeSettings, updateCardFeeSettings } from '../../stripe/cardFeeSettings.service';
import { isValidCalendarDateString } from '../../../shared/validation/calendarDate';

const billingSettingsSchema = z.object({
  body: z.object({
    clientPaymentEmails: z.boolean().optional(),
  }),
});

const cardFeesSchema = z.object({
  body: z.object({
    clientPays: z.boolean(),
    debitCards: z.enum(['absorb', 'decline']),
    internationalCards: z.enum(['absorb', 'decline']),
    // A firm's negotiated rate is lower than standard, never meaningfully higher.
    ratePercent: z.number().min(0).max(3.5),
    fixedCents: z.number().int().min(0).max(50),
    stripeNotifiedOn: z.string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Enter the date as YYYY-MM-DD.' })
      .refine(isValidCalendarDateString, { message: 'Enter the date as YYYY-MM-DD.' })
      .optional(),
    engagementLetterConfirmed: z.boolean().optional(),
  }).strict(),
});

// Paging for the unbilled-work list. Opt-in, so a caller that omits `limit` still
// gets everything; the summary counts the whole set either way.
const unbilledWorkSchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    page: z.coerce.number().int().min(1).max(MAX_PAGE_OFFSET).optional(),
    offset: z.coerce.number().int().min(0).max(MAX_PAGE_OFFSET).optional(),
  }),
});

// Paging for the workbench's attention list. Opt-in: with no `attentionLimit`
// the whole list comes back, matching every other billing read.
const workbenchSchema = z.object({
  query: z.object({
    attentionLimit: z.coerce.number().int().min(1).max(200).optional(),
    attentionPage: z.coerce.number().int().min(1).max(MAX_PAGE_OFFSET).optional(),
    attentionOffset: z.coerce.number().int().min(0).max(MAX_PAGE_OFFSET).optional(),
  }),
});

// GET /api/lawfirms/:lawFirmId/billing/unbilled-work
router.get('/unbilled-work',
  verifyToken,
  requirePermission('billing.viewInvoices'),
  validate(unbilledWorkSchema),
  handler(async (req) => firmBillingService.listFirmUnbilledWork({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    page: req.query.page,
    limit: req.query.limit,
    offset: req.query.offset,
  })),
);

// GET /api/lawfirms/:lawFirmId/billing/workbench
router.get('/workbench',
  verifyToken,
  heavyReadLimiter,
  requirePermission('billing.viewInvoices'),
  validate(workbenchSchema),
  requireTimezone,
  handler(async (req) => firmBillingService.getBillingWorkbench({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    timezone: req.tz,
    attentionLimit: req.query.attentionLimit,
    attentionPage: req.query.attentionPage,
    attentionOffset: req.query.attentionOffset,
  })),
);

// GET /api/lawfirms/:lawFirmId/billing/settings
router.get('/settings',
  verifyToken,
  requirePermission('billing.viewInvoices'),
  handler(async (req) => firmBillingService.getBillingSettings({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
  })),
);

// PUT /api/lawfirms/:lawFirmId/billing/settings
router.put('/settings',
  verifyToken,
  requirePermission('billing.manageInvoices'),
  validate(billingSettingsSchema),
  handler(async (req) => firmBillingService.updateBillingSettings({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    body: req.body,
  })),
);

// GET /api/lawfirms/:lawFirmId/billing/card-fees
router.get('/card-fees',
  verifyToken,
  requirePermission('billing.viewInvoices'),
  handler(async (req) => getCardFeeSettings({ lawFirmId: req.params.lawFirmId, actingUserId: req.user.uid })),
);

// PUT /api/lawfirms/:lawFirmId/billing/card-fees
router.put('/card-fees',
  verifyToken,
  requirePermission('settings.manageFirm'),
  validate(cardFeesSchema),
  handler(async (req) => updateCardFeeSettings({
    lawFirmId: req.params.lawFirmId, actingUserId: req.user.uid, body: req.body,
  })),
);

// GET /api/lawfirms/:lawFirmId/billing/utbms-codes
router.get('/utbms-codes',
  verifyToken,
  requirePermission('billing.viewTimeEntries'),
  handler(async (req) => {
    return { taskCodes: TASK_CODES, activityCodes: ACTIVITY_CODES, expenseCodes: EXPENSE_CODES };
  }),
);

export = router;
