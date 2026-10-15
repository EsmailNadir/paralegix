const express = require('express');
const router = express.Router({ mergeParams: true });
const { verifyToken } = require('../../shared/middleware/auth');
const { requirePermission } = require('../lawfirms/roles/requirePermission');
const { requireActiveBilling } = require('../../shared/plans/requireActiveBilling');
const { requireFeature } = require('../../shared/plans/requireFeature');
const stripeService = require('./stripe.service');
const { validate } = require('../../shared/middleware/validate');
const { requestTrustDepositSchema, requestPaymentSchema, paymentFeeQuoteSchema } = require('./stripe.validation');
const stripe = require('./stripe.config');
import { handler } from '../../shared/http/handler';

router.use(verifyToken);

// Return 503 when Stripe is not configured, except for status checks (which return
// cached/empty data) — both the firm operating account and trust-account status.
router.use((req: any, res: any, next: any) => {
  if (!stripe && !req.path.match(/^\/(connect\/[^/]+|trust-connect\/[^/]+\/[^/]+)\/status$/)) {
    return res.status(503).json({ error: 'Stripe is not configured' });
  }
  next();
});

// POST /api/stripe/connect/:lawFirmId/create-account
// Firm-level payment-processing setup: gate on firm administration.
router.post('/connect/:lawFirmId/create-account',
  requirePermission('settings.manageFirm'),
  handler(async (req) => stripeService.createConnectAccount(
    req.params.lawFirmId,
    req.user.uid,
  )));

// GET /api/stripe/connect/:lawFirmId/status
router.get('/connect/:lawFirmId/status',
  requirePermission('billing.viewInvoices'),
  handler(async (req) => stripeService.getConnectStatus(
    req.params.lawFirmId,
    req.user.uid,
  )));

// GET /api/stripe/connect/:lawFirmId/dashboard-link
// Exposes a Stripe Express login link (payouts/bank data): firm-admin only.
router.get('/connect/:lawFirmId/dashboard-link',
  requirePermission('settings.manageFirm'),
  handler(async (req) => stripeService.getDashboardLink(
    req.params.lawFirmId,
    req.user.uid,
  )));

// DELETE /api/stripe/connect/:lawFirmId
router.delete('/connect/:lawFirmId',
  requirePermission('settings.manageFirm'),
  handler(async (req) => stripeService.disconnectAccount(
    req.params.lawFirmId,
    req.user.uid,
  )));

// ── Trust-account connected accounts (electronic-deposit trust bank) ──
// Scoped to a specific trust account; a firm may hold several trust accounts, each
// with its own trust/IOLTA bank account.
//
// These mount under /api/stripe rather than under the gated
// /api/lawfirms/:lawFirmId/trust workspace, so the plan/opt-out gate that app.ts
// applies to the trust module does NOT reach them. Each one carries
// `requireFeature('trustAccounting')` of its own: without it a firm with trust
// accounting switched off could still onboard an IOLTA bank account and bill a
// client for a trust deposit.

// POST /api/stripe/trust-connect/:lawFirmId/:trustAccountId/create-account
router.post('/trust-connect/:lawFirmId/:trustAccountId/create-account',
  requirePermission('trust.manage'),
  requireFeature('trustAccounting'),
  handler(async (req) => stripeService.createTrustConnectAccount(
    req.params.lawFirmId, req.params.trustAccountId, req.user.uid,
  )));

// GET /api/stripe/trust-connect/:lawFirmId/:trustAccountId/status
router.get('/trust-connect/:lawFirmId/:trustAccountId/status',
  requirePermission('trust.view'),
  requireFeature('trustAccounting'),
  handler(async (req) => stripeService.getTrustConnectStatus(
    req.params.lawFirmId, req.params.trustAccountId, req.user.uid,
  )));

// GET /api/stripe/trust-connect/:lawFirmId/:trustAccountId/dashboard-link
router.get('/trust-connect/:lawFirmId/:trustAccountId/dashboard-link',
  requirePermission('trust.manage'),
  requireFeature('trustAccounting'),
  handler(async (req) => stripeService.getTrustConnectDashboardLink(
    req.params.lawFirmId, req.params.trustAccountId, req.user.uid,
  )));

// DELETE /api/stripe/trust-connect/:lawFirmId/:trustAccountId
router.delete('/trust-connect/:lawFirmId/:trustAccountId',
  requirePermission('trust.manage'),
  requireFeature('trustAccounting'),
  handler(async (req) => stripeService.disconnectTrustConnectAccount(
    req.params.lawFirmId, req.params.trustAccountId, req.user.uid,
  )));

// POST /api/stripe/payment/:lawFirmId/:contextType/:entityId/:invoiceId/request
// Initiating collection is gated on the payment permission AND on the firm's
// billing being active (a locked/unpaid firm must not keep collecting through us).
router.post('/payment/:lawFirmId/:contextType/:entityId/:invoiceId/request',
  requirePermission('billing.recordPayments'),
  requireActiveBilling,
  validate(requestPaymentSchema),
  handler(async (req) => stripeService.requestPayment({
    lawFirmId: req.params.lawFirmId,
    contextType: req.params.contextType,
    entityId: req.params.entityId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
    feeChoice: { card: req.body?.isCardFeePassedOn, bank: req.body?.isBankFeePassedOn },
    sendEmail: req.body?.sendEmail !== false,
    installmentId: req.body?.installmentId ?? null,
  })));

// GET /api/stripe/payment/:lawFirmId/:contextType/:entityId/:invoiceId/fee-quote
// What a request would cost by each method, for the request dialog. Same gate
// as the request itself, without the active-billing check: it moves no money.
router.get('/payment/:lawFirmId/:contextType/:entityId/:invoiceId/fee-quote',
  requirePermission('billing.recordPayments'),
  validate(paymentFeeQuoteSchema),
  handler(async (req) => stripeService.getPaymentFeeQuote({
    lawFirmId: req.params.lawFirmId,
    contextType: req.params.contextType,
    entityId: req.params.entityId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
    feeChoice: {
      card: req.query.card === undefined ? undefined : req.query.card === 'true',
      bank: req.query.bank === undefined ? undefined : req.query.bank === 'true',
    },
    installmentId: req.query.installmentId ?? null,
  })));

// POST /api/stripe/payment/:lawFirmId/:contextType/:entityId/:invoiceId/void
router.post('/payment/:lawFirmId/:contextType/:entityId/:invoiceId/void',
  requirePermission('billing.recordPayments'),
  handler(async (req) => stripeService.voidPaymentRequest({
    lawFirmId: req.params.lawFirmId,
    contextType: req.params.contextType,
    entityId: req.params.entityId,
    invoiceId: req.params.invoiceId,
    actingUserId: req.user.uid,
  })));

// POST /api/stripe/trust/:lawFirmId/request-deposit
// Firm-initiated request for an electronic (card/ACH) trust deposit. Returns a
// Checkout URL to share with the client. Optional, alongside manual deposits.
router.post('/trust/:lawFirmId/request-deposit',
  requirePermission('trust.manage'),
  requireFeature('trustAccounting'),
  requireActiveBilling,
  validate(requestTrustDepositSchema),
  handler(async (req) => stripeService.requestTrustDeposit({
    lawFirmId: req.params.lawFirmId,
    trustAccountId: req.body.trustAccountId,
    clientId: req.body.clientId,
    amountCents: req.body.amountCents,
    matterId: req.body.matterId || null,
    actingUserId: req.user.uid,
    sendEmail: req.body.sendEmail === true,
  })));

export = router;
