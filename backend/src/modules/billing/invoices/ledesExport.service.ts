/**
 * LEDES 1998B Export Service
 *
 * Generates a LEDES 1998B-format string from an invoice. Invoice/entry/fee
 * objects here are the plain camelCase records `invoices.repository` reads out
 * of Postgres: day-only fields (`invoiceDate`, `entry.date`, `fee.date`) are raw
 * 'YYYY-MM-DD' strings, money fields are plain dollar numbers.
 * Format spec: pipe-delimited, header row, one line per billable item.
 *
 * Every dollar of INVOICE_TOTAL appears on a line, because an e-billing system
 * rejects a file whose line totals do not add up to it:
 *   - time entries and flat fees are 'F' (fee) lines,
 *   - expenses are 'E' (expense) lines, the expense code 'E124' (Other) in the
 *     activity-code column since this column set has no separate expense-code one,
 *   - tax and amounts added after creation (add-amount, late fee) are 'IF'
 *     (invoice-level fee adjustment) lines whose LINE_ITEM_TOTAL is the charge.
 *
 * Reference: https://www.ledes.org/
 */

const { toCents, fromCents, hourlyAmountCents } = require('../shared/money');
const { invoiceTotalCents } = require('../shared/invoiceStatus');
const { dayAnchor } = require('../../../shared/utils/time');

/** LEDES expense code for an expense with no more specific category. */
const LEDES_EXPENSE_CODE_OTHER = 'E124';

/**
 * Format a day-only value as YYYYMMDD per the LEDES spec.
 *
 * Accepts either a raw 'YYYY-MM-DD' string (the shape `entry.date` / `fee.date`
 * / `invoice.invoiceDate` come back as) or a Date object (used internally for
 * the billing-period min/max below). Both paths resolve through the same
 * noon-UTC-anchored parse so a day-only string never rolls back a day for a
 * server (or reader) west of UTC: `new Date('2026-07-20')` is UTC midnight.
 */
function ledesDate(val: any) {
  if (!val) return '';
  const d = dayAnchor(val instanceof Date ? val : String(val));
  if (isNaN(d.getTime())) return '';
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

/**
 * Format a dollar amount with 2 decimal places, cent-exact. Round-trips through
 * the same integer-cent helpers `invoiceDerive.ts` uses for the invoice totals,
 * so a LEDES export total can never differ by a cent from what the invoice UI
 * shows for the same value.
 */
function ledesCurrency(val: any) {
  return fromCents(toCents(val)).toFixed(2);
}

/**
 * Sanitize a field value: replace pipe characters and newlines.
 */
function sanitize(val: any) {
  if (val == null) return '';
  return String(val).replace(/[|\r\n]/g, ' ').trim();
}

/**
 * Generate a LEDES 1998B string.
 *
 * @param {Object} opts
 * @param {Object} opts.invoice     invoice record (camelCase, from invoices.repository)
 * @param {Object} opts.lawFirm     law firm document
 * @param {Object} opts.client      client document (may be null for matter invoices)
 * @returns {string} LEDES 1998B formatted text
 */
export function generateLedesExport({ invoice, lawFirm, client }: any) {
  const invoiceDate = ledesDate(invoice.invoiceDate || invoice.createdAt);
  const invoiceNumber = sanitize(invoice.invoiceName || invoice.id);
  const clientId = sanitize(client?.id || invoice.clientId || '');
  const matterId = sanitize(invoice.entityId || invoice.matterId || invoice.clientContextId || '');
  const lawFirmId = sanitize(lawFirm?.id || '');

  // Billing period: earliest and latest dates across line items
  const allDates = [
    ...(invoice.timeEntries || []).map((e: any) => e.date).filter(Boolean),
    ...(invoice.flatFees || []).map((f: any) => f.date).filter(Boolean),
    ...(invoice.expenses || []).map((e: any) => e.date).filter(Boolean),
  ].map((d: any) => dayAnchor(String(d))).filter((d: Date) => !isNaN(d.getTime()));

  const billingStart = allDates.length > 0
    ? ledesDate(new Date(Math.min(...allDates.map((d: Date) => d.getTime()))))
    : invoiceDate;
  const billingEnd = allDates.length > 0
    ? ledesDate(new Date(Math.max(...allDates.map((d: Date) => d.getTime()))))
    : invoiceDate;

  // The canonical effective total (same helper computeInvoiceDerived/
  // formatInvoice/mapInvoiceRecord all share): `totalAmount` when it is
  // positive, `flatFeesAmount` only as a FALLBACK for the legacy shape where
  // the persisted total was left at 0. `totalAmount` already folds flat fees
  // in at creation time, so adding `flatFeesAmount` on top double-counted
  // every flat fee and made this export disagree with the invoice detail,
  // list, and workbench totals for the same invoice.
  const totalAmount = ledesCurrency(fromCents(invoiceTotalCents(invoice)));

  // LEDES 1998B column headers
  const COLUMNS = [
    'INVOICE_DATE',
    'INVOICE_NUMBER',
    'CLIENT_ID',
    'LAW_FIRM_MATTER_ID',
    'INVOICE_TOTAL',
    'BILLING_START_DATE',
    'BILLING_END_DATE',
    'INVOICE_DESCRIPTION',
    'LINE_ITEM_NUMBER',
    'EXP/FEE/INV_ADJ_TYPE',
    'LINE_ITEM_NUMBER_OF_UNITS',
    'LINE_ITEM_ADJUSTMENT_AMOUNT',
    'LINE_ITEM_TOTAL',
    'LINE_ITEM_DATE',
    'LINE_ITEM_TASK_CODE',
    'LINE_ITEM_ACTIVITY_CODE',
    'TIMEKEEPER_ID',
    'TIMEKEEPER_NAME',
    'LINE_ITEM_DESCRIPTION',
    'LAW_FIRM_ID',
    'LINE_ITEM_UNIT_COST',
  ];

  const rows = [];
  let lineNum = 1;

  // Time entries → 'F' (fee) lines
  for (const entry of (invoice.timeEntries || [])) {
    const entryDate = entry.date ? ledesDate(entry.date) : invoiceDate;
    const hours = Number(entry.hours) || 0;
    const rate = Number(entry.rate) || 0;
    const amount = Number(entry.amount) || fromCents(hourlyAmountCents(hours, rate));

    rows.push([
      invoiceDate,
      invoiceNumber,
      clientId,
      matterId,
      totalAmount,
      billingStart,
      billingEnd,
      sanitize(invoice.notes || ''),
      String(lineNum++),
      'F',
      hours.toFixed(2),
      '0.00',
      ledesCurrency(amount),
      entryDate,
      sanitize(entry.utbmsTaskCode || ''),
      sanitize(entry.utbmsActivityCode || ''),
      sanitize(entry.userId || entry.timekeeperId || ''),
      sanitize(entry.userName || entry.memberName || ''),
      sanitize(entry.name || entry.description || 'Legal services'),
      lawFirmId,
      ledesCurrency(rate),
    ].join('|'));
  }

  // Flat fees → 'F' lines (unit cost = amount, units = 1)
  for (const fee of (invoice.flatFees || [])) {
    const feeDate = fee.date ? ledesDate(fee.date) : invoiceDate;
    const amount = Number(fee.amount) || 0;

    rows.push([
      invoiceDate,
      invoiceNumber,
      clientId,
      matterId,
      totalAmount,
      billingStart,
      billingEnd,
      sanitize(invoice.notes || ''),
      String(lineNum++),
      'F',
      '1.00',
      '0.00',
      ledesCurrency(amount),
      feeDate,
      '',
      '',
      '',
      '',
      sanitize(fee.description || 'Flat fee'),
      lawFirmId,
      ledesCurrency(amount),
    ].join('|'));
  }

  // Expenses -> 'E' lines (unit cost = amount, units = 1)
  for (const expense of (invoice.expenses || [])) {
    const expenseDate = expense.date ? ledesDate(expense.date) : invoiceDate;
    const amount = Number(expense.amount) || 0;

    rows.push([
      invoiceDate,
      invoiceNumber,
      clientId,
      matterId,
      totalAmount,
      billingStart,
      billingEnd,
      sanitize(invoice.notes || ''),
      String(lineNum++),
      'E',
      '1.00',
      '0.00',
      ledesCurrency(amount),
      expenseDate,
      '',
      LEDES_EXPENSE_CODE_OTHER,
      '',
      '',
      sanitize(expense.description || 'Expense'),
      lawFirmId,
      ledesCurrency(amount),
    ].join('|'));
  }

  // Tax and added amounts -> 'IF' lines (one unit, unit cost = the charge)
  const adjustmentLines: Array<{ amount: any; description: string }> = [];
  const taxCents = Number(invoice.taxCents) || 0;
  if (taxCents > 0) {
    const rate = Number(invoice.taxRate);
    adjustmentLines.push({
      amount: fromCents(taxCents),
      description: rate > 0 ? `Tax (${rate}%)` : 'Tax',
    });
  }
  for (const adjustment of (invoice.amountAdjustmentNotes || [])) {
    adjustmentLines.push({
      amount: adjustment.amount,
      description: adjustment.note || (adjustment.kind === 'late_fee' ? 'Late fee' : 'Added amount'),
    });
  }
  for (const adjustment of adjustmentLines) {
    rows.push([
      invoiceDate,
      invoiceNumber,
      clientId,
      matterId,
      totalAmount,
      billingStart,
      billingEnd,
      sanitize(invoice.notes || ''),
      String(lineNum++),
      'IF',
      '1.00',
      '0.00',
      ledesCurrency(adjustment.amount),
      invoiceDate,
      '',
      '',
      '',
      '',
      sanitize(adjustment.description),
      lawFirmId,
      ledesCurrency(adjustment.amount),
    ].join('|'));
  }

  const lines = [
    'LEDES1998B[]',
    COLUMNS.join('|') + '[]',
    ...rows.map(r => r + '[]'),
  ];

  return lines.join('\r\n');
}
