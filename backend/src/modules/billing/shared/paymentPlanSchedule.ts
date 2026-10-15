/**
 * Pure arithmetic over a payment plan's instalment schedule: which day an
 * instalment falls on, which rows are still open, and how a payment is spread
 * across the open rows.
 *
 * Nothing here reads or writes the database, so the invoice service and the
 * Stripe settlement path apply a payment to a schedule the same way.
 */
import dayjs from 'dayjs';
import { ValidationError } from '../../../shared/errors/AppError';
import { toCents, fromCents } from './money';

/** A monthly plan is the one whose cadence is 30 days: it steps by calendar months. */
const MONTHLY_FREQUENCY_DAYS = 30;

/** The latest year a day column can hold. */
const LAST_YEAR = 9999;

function isMonthlyPlan(frequencyDays: any) {
  return Number(frequencyDays) === MONTHLY_FREQUENCY_DAYS;
}

/**
 * The day instalment `index` falls on: the anchor plus `index` periods.
 *
 * Every date is measured from the anchor, never from the previous date. A
 * monthly plan anchored on the 31st lands on the 31st again after a short month
 * (31 Jan, 28 Feb, 31 Mar), because stepping from the clamped 28 Feb would
 * leave it on the 28th for good. A cadence in days is a plain multiple.
 */
export function scheduleDay(anchor: string, index: number, frequencyDays: any): string {
  const base = dayjs(anchor);
  const day = isMonthlyPlan(frequencyDays)
    ? base.add(index, 'month')
    : base.add(index * (Number(frequencyDays) || MONTHLY_FREQUENCY_DAYS), 'day');
  if (day.year() > LAST_YEAR) {
    throw new ValidationError('This payment plan would schedule an instalment past the year 9999. Use an earlier start date or a shorter cadence.');
  }
  return day.format('YYYY-MM-DD');
}

/** An instalment that still has to be paid. */
export function isOpenInstallment(ep: any) {
  return ep?.status === 'pending' || ep?.status === 'overdue';
}

/**
 * Rows in due-date order, with the down payment, which opens the schedule, kept
 * first. The sort is stable, so rows on one day keep their relative order.
 */
export function sortScheduleByDate<T extends { dueDate?: any; isDownPayment?: any }>(rows: T[]): T[] {
  return rows
    .map((row, position) => ({ row, position }))
    .sort((a, b) => {
      const downA = a.row?.isDownPayment ? 0 : 1;
      const downB = b.row?.isDownPayment ? 0 : 1;
      if (downA !== downB) return downA - downB;
      const dayA = String(a.row?.dueDate || '');
      const dayB = String(b.row?.dueDate || '');
      if (dayA !== dayB) {
        if (!dayA) return 1;
        if (!dayB) return -1;
        return dayA < dayB ? -1 : 1;
      }
      return a.position - b.position;
    })
    .map(({ row }) => row);
}

/** The position of the open row with the earliest due date, or -1 when none is open. */
export function earliestOpenIndex(rows: any[] = []) {
  let best = -1;
  rows.forEach((ep, index) => {
    if (!isOpenInstallment(ep) || !ep?.dueDate) return;
    if (best < 0 || String(ep.dueDate) < String(rows[best].dueDate)) best = index;
  });
  return best;
}

/**
 * Spread a payment across the open rows, in integer cents.
 *
 * It starts at `startIndex`, runs to the end of the schedule, then wraps to the
 * rows before `startIndex`, so money paid against a named instalment settles it
 * first and the remainder lands on later rows before earlier ones. A row the
 * payment covers in full is marked paid and linked to the payment; a row it
 * covers in part stays open for the remainder. Returns the new rows and any
 * cents no open row could take.
 */
export function allocatePaymentAcrossOpenRows(
  rows: any[],
  startIndex: number,
  paymentCents: number,
  paymentIndex: number,
) {
  const out = rows.map((ep) => ({ ...ep }));
  const order: number[] = [];
  for (let i = Math.max(0, startIndex); i < out.length; i += 1) order.push(i);
  for (let i = 0; i < Math.min(Math.max(0, startIndex), out.length); i += 1) order.push(i);

  let remaining = paymentCents;
  for (const i of order) {
    if (remaining <= 0) break;
    if (!isOpenInstallment(out[i])) continue;
    const rowCents = toCents(out[i].amount || 0);
    if (remaining >= rowCents) {
      remaining -= rowCents;
      out[i] = { ...out[i], status: 'paid', matchedPaymentIndex: paymentIndex };
    } else {
      out[i] = { ...out[i], amount: fromCents(rowCents - remaining) };
      remaining = 0;
    }
  }
  return { rows: out, leftoverCents: remaining };
}
