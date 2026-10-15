const express = require('express');
const { ValidationError } = require('../../shared/errors/AppError');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../shared/middleware/auth');
const { validate } = require('../../shared/middleware/validate');
const { requirePermission } = require('../lawfirms/roles/requirePermission');
const trustService = require('./trust.service');
import { handler } from '../../shared/http/handler';
const {
  createAccountSchema,
  updateAccountSchema,
  updateAccountStatusSchema,
  bookCloseSchema,
  minimumBalanceSchema,
  trustSettingsSchema,
  createRemittanceSchema,
  updateRemittanceSchema,
  remittanceListQuerySchema,
  createTransactionSchema,
  voidTransactionSchema,
  transactionFiltersSchema,
  clientLedgerQuerySchema,
  listReconciliationsQuerySchema,
  createReconciliationSchema,
} = require('./trust.validation');

// ── Trust Accounts ─────────────────────────────────────────────────

// GET /api/lawfirms/:lawFirmId/trust/accounts
router.get('/accounts',
  verifyToken,
  requirePermission('trust.view'),
  handler(async (req) => trustService.listAccounts({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
  })),
);

// POST /api/lawfirms/:lawFirmId/trust/accounts
router.post('/accounts',
  verifyToken,
  requirePermission('trust.manage'),
  validate(createAccountSchema),
  handler(async (req) => trustService.createAccount({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    body: req.body,
  }), 201),
);

// GET /api/lawfirms/:lawFirmId/trust/accounts/:accountId/summary
// Must be before /:accountId to prevent "summary" being treated as an ID
router.get('/accounts/:accountId/summary',
  verifyToken,
  requirePermission('trust.view'),
  handler(async (req) => trustService.getAccountSummary({
    lawFirmId: req.params.lawFirmId,
    accountId: req.params.accountId,
    actingUserId: req.user.uid,
  })),
);

// GET /api/lawfirms/:lawFirmId/trust/accounts/:accountId
router.get('/accounts/:accountId',
  verifyToken,
  requirePermission('trust.view'),
  handler(async (req) => trustService.getAccount({
    lawFirmId: req.params.lawFirmId,
    accountId: req.params.accountId,
    actingUserId: req.user.uid,
  })),
);

// PUT /api/lawfirms/:lawFirmId/trust/accounts/:accountId
router.put('/accounts/:accountId',
  verifyToken,
  requirePermission('trust.manage'),
  validate(updateAccountSchema),
  handler(async (req) => trustService.updateAccount({
    lawFirmId: req.params.lawFirmId,
    accountId: req.params.accountId,
    actingUserId: req.user.uid,
    body: req.body,
  })),
);

// PATCH /api/lawfirms/:lawFirmId/trust/accounts/:accountId/status
router.patch('/accounts/:accountId/status',
  verifyToken,
  requirePermission('trust.manage'),
  validate(updateAccountStatusSchema),
  handler(async (req) => trustService.updateAccountStatus({
    lawFirmId: req.params.lawFirmId,
    accountId: req.params.accountId,
    actingUserId: req.user.uid,
    body: req.body,
  })),
);

// PATCH /api/lawfirms/:lawFirmId/trust/accounts/:accountId/book-close
router.patch('/accounts/:accountId/book-close',
  verifyToken,
  requirePermission('trust.manage'),
  validate(bookCloseSchema),
  handler(async (req) => trustService.setBookCloseDate({
    lawFirmId: req.params.lawFirmId,
    accountId: req.params.accountId,
    actingUserId: req.user.uid,
    bookCloseDate: req.body.bookCloseDate,
  })),
);

// ── Trust Transactions ─────────────────────────────────────────────

// GET /api/lawfirms/:lawFirmId/trust/transactions
router.get('/transactions',
  verifyToken,
  requirePermission('trust.view'),
  validate(transactionFiltersSchema),
  handler(async (req) => trustService.listTransactions({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    filters: req.query,
  })),
);

// POST /api/lawfirms/:lawFirmId/trust/transactions
router.post('/transactions',
  verifyToken,
  requirePermission('trust.manage'),
  validate(createTransactionSchema),
  handler(async (req) => trustService.createTransaction({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    body: req.body,
  }), 201),
);

// GET /api/lawfirms/:lawFirmId/trust/transactions/:transactionId
router.get('/transactions/:transactionId',
  verifyToken,
  requirePermission('trust.view'),
  handler(async (req) => trustService.getTransaction({
    lawFirmId: req.params.lawFirmId,
    transactionId: req.params.transactionId,
    actingUserId: req.user.uid,
  })),
);

// PATCH /api/lawfirms/:lawFirmId/trust/transactions/:transactionId/void
router.patch('/transactions/:transactionId/void',
  verifyToken,
  requirePermission('trust.manage'),
  validate(voidTransactionSchema),
  handler(async (req) => trustService.voidTransaction({
    lawFirmId: req.params.lawFirmId,
    transactionId: req.params.transactionId,
    actingUserId: req.user.uid,
    body: req.body,
  })),
);

// ── Client Ledger & Balances ───────────────────────────────────────

// GET /api/lawfirms/:lawFirmId/trust/clients/:clientId/ledger
router.get('/clients/:clientId/ledger',
  verifyToken,
  requirePermission('trust.view'),
  validate(clientLedgerQuerySchema),
  handler(async (req) => trustService.getClientLedger({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    actingUserId: req.user.uid,
    limit: req.query.limit,
    offset: req.query.offset,
    order: req.query.order,
  })),
);

// GET /api/lawfirms/:lawFirmId/trust/clients/:clientId/balance
router.get('/clients/:clientId/balance',
  verifyToken,
  requirePermission('trust.view'),
  handler(async (req) => trustService.getClientBalance({
    lawFirmId: req.params.lawFirmId,
    clientId: req.params.clientId,
    actingUserId: req.user.uid,
  })),
);

// GET /api/lawfirms/:lawFirmId/trust/balances
router.get('/balances',
  verifyToken,
  requirePermission('trust.view'),
  handler(async (req) => trustService.listAllBalances({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
  })),
);

// ── Matter Ledger & Balances ───────────────────────────────────────

// GET /api/lawfirms/:lawFirmId/trust/matters/:matterId/ledger
router.get('/matters/:matterId/ledger',
  verifyToken,
  requirePermission('trust.view'),
  validate(clientLedgerQuerySchema),
  handler(async (req) => trustService.getMatterLedger({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    actingUserId: req.user.uid,
    limit: req.query.limit,
    offset: req.query.offset,
    order: req.query.order,
  })),
);

// GET /api/lawfirms/:lawFirmId/trust/matters/:matterId/balance
router.get('/matters/:matterId/balance',
  verifyToken,
  requirePermission('trust.view'),
  handler(async (req) => trustService.getMatterBalance({
    lawFirmId: req.params.lawFirmId,
    matterId: req.params.matterId,
    actingUserId: req.user.uid,
  })),
);

// ── Minimum Balances (evergreen retainer thresholds) ───────────────

// GET /api/lawfirms/:lawFirmId/trust/minimum-balances
router.get('/minimum-balances',
  verifyToken,
  requirePermission('trust.view'),
  handler(async (req) => trustService.listMinimumBalances({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
  })),
);

// PUT /api/lawfirms/:lawFirmId/trust/minimum-balances  (upsert by client+account)
router.put('/minimum-balances',
  verifyToken,
  requirePermission('trust.manage'),
  validate(minimumBalanceSchema),
  handler(async (req) => trustService.upsertMinimumBalance({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    body: req.body,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/trust/minimum-balances/:id
router.delete('/minimum-balances/:id',
  verifyToken,
  requirePermission('trust.manage'),
  handler(async (req) => trustService.deleteMinimumBalance({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    id: req.params.id,
  })),
);

// ── Per-firm Trust Settings (jurisdiction defaults) ────────────────

// GET /api/lawfirms/:lawFirmId/trust/settings
router.get('/settings',
  verifyToken,
  requirePermission('trust.view'),
  handler(async (req) => trustService.getTrustSettings({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
  })),
);

// PUT /api/lawfirms/:lawFirmId/trust/settings
router.put('/settings',
  verifyToken,
  requirePermission('trust.manage'),
  validate(trustSettingsSchema),
  handler(async (req) => trustService.updateTrustSettings({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    body: req.body,
  })),
);

// ── IOLTA Interest Remittances ─────────────────────────────────────

// GET /api/lawfirms/:lawFirmId/trust/interest-remittances
router.get('/interest-remittances',
  verifyToken,
  requirePermission('trust.view'),
  validate(remittanceListQuerySchema),
  handler(async (req) => trustService.listRemittances({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    trustAccountId: req.query.trustAccountId,
    limit: req.query.limit,
    offset: req.query.offset,
  })),
);

// POST /api/lawfirms/:lawFirmId/trust/interest-remittances
router.post('/interest-remittances',
  verifyToken,
  requirePermission('trust.manage'),
  validate(createRemittanceSchema),
  handler(async (req) => trustService.createRemittance({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    body: req.body,
  }), 201),
);

// PUT /api/lawfirms/:lawFirmId/trust/interest-remittances/:remittanceId
router.put('/interest-remittances/:remittanceId',
  verifyToken,
  requirePermission('trust.manage'),
  validate(updateRemittanceSchema),
  handler(async (req) => trustService.updateRemittance({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    remittanceId: req.params.remittanceId,
    body: req.body,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/trust/interest-remittances/:remittanceId
router.delete('/interest-remittances/:remittanceId',
  verifyToken,
  requirePermission('trust.manage'),
  handler(async (req) => trustService.deleteRemittance({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    remittanceId: req.params.remittanceId,
  })),
);

// ── Firm-wide audit report ─────────────────────────────────────────

// GET /api/lawfirms/:lawFirmId/trust/audit-report
// Every account's three-way figures, per-client breakdown, negative balances and
// reconciliation standing, in one read. What a bar examination asks for.
router.get('/audit-report',
  verifyToken,
  requirePermission('trust.view'),
  handler(async (req) => trustService.getAuditReport({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
  })),
);

// ── Reconciliation ─────────────────────────────────────────────────

// GET /api/lawfirms/:lawFirmId/trust/reconciliation-snapshot?trustAccountId=...
// Returns current book/ledger figures for pre-populating the reconciliation wizard
router.get('/reconciliation-snapshot',
  verifyToken,
  requirePermission('trust.view'),
  handler(async (req) => {
    // trustAccountId is always supplied by the calling frontend code (the user
    // selects an account before this endpoint is ever called), so a missing
    // value here is a client bug, not user-actionable input. A generic Error
    // becomes a scrubbed 500.
    if (!req.query.trustAccountId || typeof req.query.trustAccountId !== 'string') {
      throw new ValidationError({ trustAccountId: ['trustAccountId is required'] });
    }
    const result = await trustService.getReconciliationSnapshot({
      lawFirmId: req.params.lawFirmId,
      actingUserId: req.user.uid,
      trustAccountId: req.query.trustAccountId,
    });
    return result;
  }),
);

// GET /api/lawfirms/:lawFirmId/trust/reconciliations
router.get('/reconciliations',
  verifyToken,
  requirePermission('trust.view'),
  validate(listReconciliationsQuerySchema),
  handler(async (req) => trustService.listReconciliations({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    trustAccountId: req.query.trustAccountId,
    limit: req.query.limit,
    offset: req.query.offset,
  })),
);

// POST /api/lawfirms/:lawFirmId/trust/reconciliations
router.post('/reconciliations',
  verifyToken,
  requirePermission('trust.reconcile'),
  validate(createReconciliationSchema),
  handler(async (req) => trustService.createReconciliation({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    body: req.body,
  }), 201),
);

// GET /api/lawfirms/:lawFirmId/trust/reconciliations/latest
// Must be before /:reconciliationId
router.get('/reconciliations/latest',
  verifyToken,
  requirePermission('trust.view'),
  handler(async (req) => trustService.getLatestReconciliation({
    lawFirmId: req.params.lawFirmId,
    actingUserId: req.user.uid,
    trustAccountId: req.query.trustAccountId,
  })),
);

// GET /api/lawfirms/:lawFirmId/trust/reconciliations/:reconciliationId
router.get('/reconciliations/:reconciliationId',
  verifyToken,
  requirePermission('trust.view'),
  handler(async (req) => trustService.getReconciliation({
    lawFirmId: req.params.lawFirmId,
    reconciliationId: req.params.reconciliationId,
    actingUserId: req.user.uid,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/trust/reconciliations/:reconciliationId
// Reopen (undo) a reconciliation so a transaction it cleared can be voided again.
router.delete('/reconciliations/:reconciliationId',
  verifyToken,
  requirePermission('trust.reconcile'),
  handler(async (req) => trustService.reopenReconciliation({
    lawFirmId: req.params.lawFirmId,
    reconciliationId: req.params.reconciliationId,
    actingUserId: req.user.uid,
  })),
);

export = router;
