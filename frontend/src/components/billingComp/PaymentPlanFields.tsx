"use client";

import { useId } from "react";
import dayjs from "dayjs";
import { Calendar, CheckCircle2, DollarSign, Hash, Wallet } from "lucide-react";
import Checkbox from "@/components/ui/Checkbox";
import DatePicker from "@/components/ui/DatePicker";
import Dropdown from "@/components/ui/Dropdown";
import FieldError from "@/components/ui/FieldError";
import { formatCurrency, installmentAmountFromPaymentCount } from "@/components/billingComp/utils";
import { MONEY_DECIMALS_MESSAGE, parseMoneyInput } from "@/lib/utils/currency";
import type { SetPaymentPlanPayload } from "@/services/billing.service";

/** Most schedule rows a plan may have, a down payment included. The backend refuses more. */
export const MAX_PLAN_INSTALLMENTS = 120;

/** Shown where rows are added one at a time, so there is no amount to enlarge. */
export const installmentRowLimitMessage = () =>
  `A payment plan can have at most ${MAX_PLAN_INSTALLMENTS} installments.`;

export const installmentLimitMessage = (rows: number) =>
  `This plan would need ${rows} installments, but a payment plan can have at most ${MAX_PLAN_INSTALLMENTS}. Use a larger installment amount.`;

/** Rows an amount-mode plan needs for a balance, counted in whole cents. */
function rowsForInstallmentAmount(balance: number, installmentAmount: number): number {
  const installmentCents = Math.max(1, Math.round(installmentAmount * 100));
  return Math.ceil(Math.round(balance * 100) / installmentCents);
}

/**
 * The message for a payment count that cannot be split evenly in cents, or null
 * when it can. Each of the first `count - 1` payments is rounded up to a whole
 * cent, so a count near the number of cents in the balance leaves the last
 * payment at nothing or below it; the server would save fewer rows than were
 * asked for, so the count is refused instead.
 */
export function paymentCountError(regularRemaining: number, count: number): string | null {
  const cents = Math.round(regularRemaining * 100);
  if (!(cents > 0) || !(count >= 1)) return null;
  const perPaymentCents = Math.ceil(cents / count);
  if (cents - (count - 1) * perPaymentCents >= 1) return null;
  return `${formatCurrency(regularRemaining)} cannot be split into ${count} payments without one coming to less than a cent. Use fewer payments.`;
}

export type PaymentPlanInstallmentMode = "amount" | "count";

/** The raw form values a payment plan is configured from. */
export interface PaymentPlanFormValues {
  installmentMode: PaymentPlanInstallmentMode;
  /** Number of installments, as typed. Used when `installmentMode` is "count". */
  paymentCount: string;
  /** Dollars per installment, as typed. Used when `installmentMode` is "amount". */
  installmentAmount: string;
  /** Days between installments, or "custom" to read `frequencyCustom` instead. */
  frequency: string;
  frequencyCustom: string;
  startDate: string;
  downPayment: string;
  downPaymentPaid: boolean;
  downPaymentDueDate: string;
}

export const EMPTY_PAYMENT_PLAN: PaymentPlanFormValues = {
  installmentMode: "amount",
  paymentCount: "",
  installmentAmount: "",
  frequency: "30",
  frequencyCustom: "",
  startDate: "",
  downPayment: "",
  downPaymentPaid: false,
  downPaymentDueDate: "",
};

const inputClass =
  "w-full rounded-lg border border-input-border bg-input-bg px-3 py-2 text-sm text-on-surface shadow-sm outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-focus-ring/25";
const cardClass = "rounded-xl border border-outline-subtle bg-surface-alt/25 p-4 space-y-3";
const cardHeadingClass =
  "flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-on-surface-muted";

function modeCardClass(selected: boolean) {
  return `relative flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 transition-all duration-150 select-none focus-within:ring-2 focus-within:ring-focus-ring/35 focus-within:ring-offset-2 focus-within:ring-offset-surface ${
    selected
      ? "border-accent-border-soft bg-accent-soft dark:bg-accent-solid/10"
      : "border-outline-subtle bg-input-bg/40 hover:border-outline hover:bg-surface-hover"
  }`;
}

function modeIconClass(selected: boolean) {
  return `flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
    selected ? "bg-accent-soft text-accent-emphasis" : "bg-surface-alt text-on-surface-muted"
  }`;
}

export interface PaymentPlanScheduleRow {
  label: string;
  date: string;
  amount: number;
  isDownPayment?: boolean;
}

/**
 * Expands the form values into the installment rows the plan would produce.
 * Returns an empty array when the values are not yet complete enough to
 * schedule anything.
 */
export function buildPaymentPlanSchedule(
  values: PaymentPlanFormValues,
  balance: number,
): PaymentPlanScheduleRow[] {
  const downPmt = parseFloat(values.downPayment) || 0;
  const freq =
    values.frequency === "custom" ? parseInt(values.frequencyCustom, 10) : parseInt(values.frequency, 10);
  if (balance <= 0 || isNaN(freq) || freq < 1) return [];

  const regularRemaining = balance - (downPmt > 0 ? downPmt : 0);
  if (regularRemaining < 0) return [];

  // A plan over the limit cannot be saved, so it is not previewed either:
  // 0.01 against a large balance would otherwise render a million rows.
  const previewRows =
    values.installmentMode === "count"
      ? parseInt(values.paymentCount, 10)
      : rowsForInstallmentAmount(regularRemaining, parseFloat(values.installmentAmount));
  if (previewRows + (downPmt > 0 ? 1 : 0) > MAX_PLAN_INSTALLMENTS) return [];

  const rows: PaymentPlanScheduleRow[] = [];

  if (downPmt > 0) {
    rows.push({
      label: "Down Payment",
      date: values.downPaymentPaid
        ? "Collected"
        : values.downPaymentDueDate
          ? dayjs(values.downPaymentDueDate).format("MMM DD, YYYY")
          : values.startDate
            ? dayjs(values.startDate).format("MMM DD, YYYY")
            : "Start date",
      amount: downPmt,
      isDownPayment: true,
    });
  }

  const startDay = values.startDate ? dayjs(values.startDate) : null;
  // With a down payment the first installment lands one full period after the
  // start date, since the start date itself carries the down payment. Every
  // date is the start date plus whole periods, never the previous date plus a
  // period, so a plan that starts on the 31st returns to the 31st after a short
  // month, exactly as the server saves it.
  const firstRegularPeriod = downPmt > 0 ? 1 : 0;

  const dueDateFor = (index: number) =>
    startDay
      ? freq === 30
        ? startDay.add(firstRegularPeriod + index, "month").format("MMM DD, YYYY")
        : startDay.add((firstRegularPeriod + index) * freq, "day").format("MMM DD, YYYY")
      : `Payment ${index + 1}`;

  if (values.installmentMode === "count") {
    const n = parseInt(values.paymentCount, 10);
    if (!isNaN(n) && n > 0 && regularRemaining > 0 && !paymentCountError(regularRemaining, n)) {
      const per = installmentAmountFromPaymentCount(regularRemaining, n);
      let runningSum = 0;
      for (let i = 0; i < n; i++) {
        const amt = i === n - 1 ? Number((regularRemaining - runningSum).toFixed(2)) : per;
        runningSum += amt;
        rows.push({ label: `Installment ${i + 1} of ${n}`, date: dueDateFor(i), amount: amt });
      }
    }
  } else {
    const amt = parseFloat(values.installmentAmount);
    if (!isNaN(amt) && amt > 0 && regularRemaining > 0) {
      const count = Math.ceil(regularRemaining / amt);
      let currentRem = regularRemaining;
      for (let i = 0; i < count; i++) {
        const itemAmt = i === count - 1 ? Number(currentRem.toFixed(2)) : amt;
        currentRem -= itemAmt;
        rows.push({ label: `Installment ${i + 1} of ${count}`, date: dueDateFor(i), amount: itemAmt });
      }
    }
  }

  return rows;
}

/**
 * Read a typed installment or down payment. A third decimal place is refused
 * with the shared money message, because the plan is stored in cents and
 * rounding would schedule an amount nobody typed. Any other problem keeps
 * the field's own wording.
 */
export function parsePlanAmountInput(
  raw: string,
  invalidMessage: string,
): { amount: number; error?: undefined } | { amount?: undefined; error: string } {
  const parsed = parseMoneyInput(raw);
  if ("amount" in parsed) return { amount: parsed.amount };
  return { error: parsed.error === MONEY_DECIMALS_MESSAGE ? MONEY_DECIMALS_MESSAGE : invalidMessage };
}

/**
 * Validates the form values against the balance being financed and turns them
 * into the API payload. Returns the first user-facing problem instead of a
 * payload when the plan cannot be built.
 */
export function buildPaymentPlanPayload(
  values: PaymentPlanFormValues,
  balance: number,
): { payload: SetPaymentPlanPayload; error?: undefined } | { payload?: undefined; error: string } {
  // A typed 0 or 0.00 means "no down payment".
  let downPayment: number | undefined;
  if (values.downPayment && Number(values.downPayment) !== 0) {
    const parsed = parsePlanAmountInput(values.downPayment, "Enter a valid down payment amount");
    if (parsed.error !== undefined) return { error: parsed.error };
    downPayment = parsed.amount;
  }
  if (downPayment !== undefined && downPayment >= balance) {
    return { error: "Down payment must be less than the remaining balance" };
  }

  const regularRemaining = balance - (downPayment && downPayment > 0 ? downPayment : 0);
  if (regularRemaining <= 0) {
    return { error: "Nothing left to split into installments after the down payment" };
  }

  let installmentAmount: number;
  if (values.installmentMode === "count") {
    const n = parseInt(values.paymentCount, 10);
    if (isNaN(n) || n < 1) {
      return { error: "Enter a valid number of payments (at least 1)" };
    }
    if (n + (downPayment && downPayment > 0 ? 1 : 0) > MAX_PLAN_INSTALLMENTS) {
      return { error: installmentLimitMessage(n + (downPayment && downPayment > 0 ? 1 : 0)) };
    }
    const countError = paymentCountError(regularRemaining, n);
    if (countError) return { error: countError };
    installmentAmount = installmentAmountFromPaymentCount(regularRemaining, n);
    if (isNaN(installmentAmount) || installmentAmount <= 0) {
      return { error: "Could not compute installment amount for that number of payments" };
    }
  } else {
    const parsed = parsePlanAmountInput(values.installmentAmount, "Enter a valid installment amount");
    if (parsed.error !== undefined) return { error: parsed.error };
    installmentAmount = parsed.amount;
    const rows = rowsForInstallmentAmount(regularRemaining, installmentAmount) + (downPayment && downPayment > 0 ? 1 : 0);
    if (rows > MAX_PLAN_INSTALLMENTS) return { error: installmentLimitMessage(rows) };
  }

  if (downPayment && downPayment > 0 && !values.downPaymentPaid && !values.downPaymentDueDate) {
    return { error: "Select a due date for the down payment" };
  }
  if (!values.startDate) {
    return { error: "Select a start date for the first installment" };
  }

  const frequencyDays =
    values.frequency === "custom" ? parseInt(values.frequencyCustom, 10) : parseInt(values.frequency, 10);
  if (isNaN(frequencyDays) || frequencyDays < 1) {
    return { error: "Enter a valid frequency" };
  }

  return {
    payload: {
      installmentAmount,
      frequencyDays,
      planStartDate: values.startDate,
      ...(downPayment && downPayment > 0
        ? {
            downPaymentAmount: downPayment,
            downPaymentAlreadyPaid: values.downPaymentPaid,
            ...(!values.downPaymentPaid && values.downPaymentDueDate
              ? { downPaymentDueDate: values.downPaymentDueDate }
              : {}),
          }
        : {}),
    },
  };
}

interface PaymentPlanFieldsProps {
  values: PaymentPlanFormValues;
  onChange: (patch: Partial<PaymentPlanFormValues>) => void;
  /** Amount the plan has to cover: the invoice's remaining balance. */
  balance: number;
  /** Distinguishes the strategy radio group when several render on one page. */
  radioName: string;
  /** Render the frequency menu in a portal - needed inside a scrolling dialog. */
  portalDropdown?: boolean;
  className?: string;
}

/**
 * The payment plan configuration form: strategy, schedule, optional down
 * payment, and a live preview of the installments it produces. Shared by the
 * invoice detail modal and the generate-invoice pages so a plan is set up the
 * same way wherever it is started.
 */
export default function PaymentPlanFields({
  values,
  onChange,
  balance,
  radioName,
  portalDropdown = false,
  className = "",
}: PaymentPlanFieldsProps) {
  const fieldIds = useId();
  const scheduleRows = buildPaymentPlanSchedule(values, balance);
  const totalAccounted = scheduleRows.reduce((acc, row) => acc + row.amount, 0);
  const downPaymentEntered = parseFloat(values.downPayment) > 0;
  const paymentCount = parseInt(values.paymentCount, 10);
  const paymentCountMessage =
    values.installmentMode === "count" && paymentCount >= 1
      ? paymentCountError(balance - (downPaymentEntered ? parseFloat(values.downPayment) : 0), paymentCount)
      : null;

  return (
    <div className={`space-y-4 ${className}`}>
      <div className={cardClass}>
        <div className={cardHeadingClass}>
          <Hash className="h-3.5 w-3.5 text-accent-emphasis" aria-hidden />
          <span>Installment Strategy</span>
        </div>

        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <label className={modeCardClass(values.installmentMode === "count")}>
            <input
              type="radio"
              name={radioName}
              checked={values.installmentMode === "count"}
              onChange={() => onChange({ installmentMode: "count" })}
              className="sr-only"
            />
            <span className={modeIconClass(values.installmentMode === "count")}>
              <Hash className="h-3.5 w-3.5" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold leading-tight text-on-surface">Split into N</span>
              <span className="mt-0.5 block text-[11px] leading-snug text-on-surface-muted">
                Divide balance into equal payments
              </span>
            </span>
          </label>

          <label className={modeCardClass(values.installmentMode === "amount")}>
            <input
              type="radio"
              name={radioName}
              checked={values.installmentMode === "amount"}
              onChange={() => onChange({ installmentMode: "amount" })}
              className="sr-only"
            />
            <span className={modeIconClass(values.installmentMode === "amount")}>
              <DollarSign className="h-3.5 w-3.5" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold leading-tight text-on-surface">Fixed amount</span>
              <span className="mt-0.5 block text-[11px] leading-snug text-on-surface-muted">
                Set fixed dollar amount per payment
              </span>
            </span>
          </label>
        </div>

        {values.installmentMode === "count" ? (
          <div className="space-y-3 pt-1">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-on-surface-secondary">Quick Presets</label>
              <div className="flex flex-wrap gap-2">
                {[2, 3, 4, 6].map((num) => (
                  <button
                    key={num}
                    type="button"
                    onClick={() => onChange({ paymentCount: String(num) })}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                      values.paymentCount === String(num)
                        ? "bg-accent-solid text-on-accent-solid shadow-sm"
                        : "border border-outline-subtle bg-surface hover:bg-surface-hover text-on-surface"
                    }`}
                  >
                    {num} payments
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1 pt-1">
              <label htmlFor={`${fieldIds}-payment-count`} className="block text-xs font-medium text-on-surface">
                Number of payments <span aria-hidden="true">*</span>
              </label>
              <input
                id={`${fieldIds}-payment-count`}
                type="number"
                min={1}
                step={1}
                value={values.paymentCount}
                onChange={(e) => onChange({ paymentCount: e.target.value })}
                className={inputClass}
                placeholder="e.g. 4"
              />
              <FieldError message={paymentCountMessage} />
            </div>
          </div>
        ) : (
          <div className="space-y-1 pt-1">
            <label className="block text-xs font-medium text-on-surface">
              Installment amount <span aria-hidden="true">*</span>
            </label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-on-surface-muted">
                $
              </span>
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={values.installmentAmount}
                onChange={(e) => onChange({ installmentAmount: e.target.value })}
                className={`${inputClass} pl-8`}
                placeholder="0.00"
              />
            </div>
          </div>
        )}
      </div>

      <div className={cardClass}>
        <div className={cardHeadingClass}>
          <Calendar className="h-3.5 w-3.5 text-accent-emphasis" aria-hidden />
          <span>Schedule &amp; Timing</span>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Dropdown
              label="Frequency *"
              labelClassName="text-xs font-medium text-on-surface mb-1"
              value={values.frequency}
              onChange={(v) => onChange({ frequency: v })}
              options={[
                { label: "Monthly", value: "30" },
                { label: "Every 2 Weeks", value: "14" },
                { label: "Weekly", value: "7" },
                { label: "Custom interval…", value: "custom" },
              ]}
              buttonClassName="w-full rounded-lg border-input-border bg-input-bg py-2 shadow-sm"
              portal={portalDropdown}
            />
          </div>
          <div>
            <label id={`${fieldIds}-first-payment-date-label`} className="block text-xs font-medium text-on-surface mb-1">
              First payment date <span aria-hidden="true">*</span>
            </label>
            <DatePicker
              ariaLabelledBy={`${fieldIds}-first-payment-date-label`}
              value={values.startDate} onChange={(v) => onChange({ startDate: v })} />
          </div>
        </div>

        {values.frequency === "custom" && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <input
              type="number"
              min="1"
              step="1"
              value={values.frequencyCustom}
              onChange={(e) => onChange({ frequencyCustom: e.target.value })}
              className={`${inputClass} w-24`}
              placeholder="14"
              autoFocus
            />
            <span className="text-sm text-on-surface-muted">days between payments</span>
          </div>
        )}
      </div>

      <div className={cardClass}>
        <div className={cardHeadingClass}>
          <Wallet className="h-3.5 w-3.5 text-accent-emphasis" aria-hidden />
          <span>Upfront Down Payment (Optional)</span>
        </div>

        <div className="space-y-1">
          <label className="block text-xs font-medium text-on-surface">Down payment amount</label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-on-surface-muted">
              $
            </span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={values.downPayment}
              onChange={(e) => {
                const next = e.target.value;
                onChange(
                  !next || parseFloat(next) <= 0
                    ? { downPayment: next, downPaymentPaid: false }
                    : { downPayment: next },
                );
              }}
              className={`${inputClass} pl-8`}
              placeholder="0.00 (No down payment)"
            />
          </div>
        </div>

        {downPaymentEntered && (
          <div className="space-y-2 pt-2 border-t border-outline-subtle">
            <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-outline-subtle bg-surface px-3 py-2 select-none transition-colors hover:bg-surface-hover">
              <Checkbox
                checked={values.downPaymentPaid}
                onChange={(v) =>
                  onChange(v ? { downPaymentPaid: true, downPaymentDueDate: "" } : { downPaymentPaid: false })
                }
              />
              <span className="text-xs font-medium text-on-surface-secondary">Already collected / paid today</span>
            </label>
            {!values.downPaymentPaid && (
              <div className="space-y-1">
                <label id={`${fieldIds}-down-payment-due-date-label`} className="block text-xs font-medium text-on-surface">
                  Down payment due date <span aria-hidden="true">*</span>
                </label>
                <DatePicker
                  ariaLabelledBy={`${fieldIds}-down-payment-due-date-label`}
                  value={values.downPaymentDueDate}
                  onChange={(v) => onChange({ downPaymentDueDate: v })}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {scheduleRows.length > 0 && (
        <div className="space-y-2.5 rounded-xl border border-outline-subtle bg-surface p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-on-surface-muted">
              Generated Schedule Preview ({scheduleRows.length} payment{scheduleRows.length !== 1 ? "s" : ""})
            </span>
            <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-medium">
              <CheckCircle2 className="h-3.5 w-3.5" />
              <span>
                {formatCurrency(totalAccounted)} of {formatCurrency(balance)}
              </span>
            </div>
          </div>
          <div className="overflow-hidden rounded-lg border border-outline-subtle text-xs">
            <table className="w-full text-left">
              <thead className="bg-surface-alt/60 text-on-surface-muted font-medium border-b border-outline-subtle">
                <tr>
                  <th className="px-3 py-2">Payment</th>
                  <th className="px-3 py-2">Due Date</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-subtle text-on-surface">
                {scheduleRows.map((row, idx) => (
                  <tr key={idx} className={row.isDownPayment ? "bg-accent-soft/30 font-medium" : "hover:bg-surface-hover"}>
                    <td className="px-3 py-2 flex items-center gap-1.5">
                      {row.isDownPayment && <Wallet className="h-3 w-3 text-accent-emphasis" aria-hidden />}
                      <span>{row.label}</span>
                    </td>
                    <td className="px-3 py-2 text-on-surface-secondary">{row.date}</td>
                    <td className="px-3 py-2 text-right font-medium tabular-nums">{formatCurrency(row.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
