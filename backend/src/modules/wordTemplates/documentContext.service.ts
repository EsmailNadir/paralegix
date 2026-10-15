/**
 * The values a matter fills into a template: JJ's `buildCaseDocumentContext`
 * re-expressed against Paralegix tables. The assembly (formatting, vocabulary,
 * repeaters) is the ported pure `assembleCaseDocumentContext`; this module only
 * decides who may see what and fetches it, scoped to the caller's firm.
 *
 * MONEY RULE (from JJ): a money field is printed only when it is a fact stored
 * on this matter. Nothing is inferred, and a matter with no invoices prints no
 * balance rather than "$0.00".
 *
 * Billing sections are read only for a caller holding that section's billing
 * permission. A billing read that FAILS marks the context `billingIncomplete`,
 * so a missing figure is never mistaken for a genuine zero.
 */
import { NotFoundError } from '../../shared/errors/AppError';
import {
  assembleCaseDocumentContext,
  customFieldValues,
  EMPTY_CASE_ROW,
  pickCaseClient,
  summarizeCaseInvoices,
  trustClientFor,
  withCustomFieldValues,
  type BillableLineItem,
  type CaseAutofillInputs,
  type CaseBillingTotals,
} from './lib/case-autofill';
import * as contextRepo from './documentContext.repository';

const { assertLawFirmMembership, assertMatterReadAccess } = require('../../shared/utils/membership');
const { loadResolvedMember } = require('../lawfirms/roles/requirePermission');
const { hasPermission } = require('../lawfirms/roles/permissions');

// Mirrors the event type labels the calendar shows.
const HEARING_TYPE_LABEL: Record<string, string> = {
  court_date: 'Court Date',
  hearing: 'Hearing',
  deposition: 'Deposition',
  mediation: 'Mediation',
  arbitration: 'Arbitration',
  trial: 'Trial',
  meeting: 'Meeting',
};

// Event types that are a deadline rather than an appearance.
const DEADLINE_EVENT_TYPES = new Set(['filing_deadline', 'discovery_cutoff', 'appeal_deadline', 'statute_of_limitations']);

type EventRow = Awaited<ReturnType<typeof contextRepo.listMatterEvents>>[number];
type ClientRow = NonNullable<Awaited<ReturnType<typeof contextRepo.loadClient>>>;

/** The next non-cancelled event at or after `now` that passes `match`. */
function nextEvent(rows: EventRow[], now: Date, match: (e: EventRow) => boolean): EventRow | null {
  return rows.find((e) => e.status !== 'cancelled' && e.date && e.date.getTime() >= now.getTime() && match(e)) ?? null;
}

/** A day-only value as an instant that is the same calendar day in every US zone. */
const middayUtc = (day: string) => new Date(`${day}T12:00:00Z`);

function isValidZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function toClientInput(client: ClientRow | null): CaseAutofillInputs['client'] {
  return client
    ? {
      name: client.name,
      email: client.email ?? null,
      phone: client.phone,
      address: client.address,
      organization: client.organization,
      preferredContactMethod: client.preferredContactMethod,
    }
    : null;
}

/**
 * Runs one billing read. A failure is logged and recorded rather than thrown,
 * so one unreadable section leaves the rest of the document intact.
 */
function billingReader() {
  let incomplete = false;
  const read = async <T>(label: string, fallback: T, work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error: any) {
      incomplete = true;
      console.error(`[word-templates] document context: could not read ${label}:`, error?.message);
      return fallback;
    }
  };
  return { read, isIncomplete: () => incomplete };
}

/**
 * The document context for a matter (with an optional picked client), or for
 * a client alone. Throws not-found for a matter or client outside the firm.
 */
export async function getDocumentContext({
  lawFirmId, userId, matterId, clientId, timezone,
}: { lawFirmId: string; userId: string; matterId?: string; clientId?: string; timezone?: string }) {
  await assertLawFirmMembership(lawFirmId, userId);
  if (matterId) await assertMatterReadAccess(lawFirmId, matterId, userId);

  const [firm, member] = await Promise.all([
    contextRepo.loadFirm(lawFirmId),
    loadResolvedMember(lawFirmId, userId),
  ]);
  const can = (code: string) => hasPermission(member, code);
  const settings = (firm?.settings ?? {}) as { timezone?: unknown };
  // The firm's own calendar decides every printed date; the caller's zone is
  // the fallback for a firm that has not set one.
  const timeZone = isValidZone(settings.timezone) ? settings.timezone : (isValidZone(timezone) ? timezone : 'UTC');
  const firmInput: CaseAutofillInputs['firm'] = firm
    ? {
      name: firm.name, address: firm.address, city: firm.city, state: firm.state, zip: firm.zip,
      phone: firm.phone, fax: null, email: firm.email == null ? null : String(firm.email),
    }
    : null;
  const now = new Date();

  // A picked client must be this firm's, whatever else is asked for.
  const pickedClient = clientId ? await contextRepo.loadClient(lawFirmId, clientId) : null;
  if (clientId && !pickedClient) throw new NotFoundError('Client');

  const billing = billingReader();

  if (!matterId) {
    const retainers = can('billing.viewPlans')
      ? await billing.read('billing plans', [], () => contextRepo.listActiveRetainers(lawFirmId, null, clientId ?? null))
      : [];
    const context = assembleCaseDocumentContext({
      caseRow: EMPTY_CASE_ROW,
      client: toClientInput(pickedClient),
      firm: firmInput,
      nextHearing: null,
      installments: [],
      flatFeeTotalCents: null,
      hourlyRateCents: null,
      retainerCents: retainers.length === 1 ? retainers[0].amountCents : null,
      now,
      timeZone,
    });
    return { context: { ...context, billingIncomplete: billing.isIncomplete() } };
  }

  const matter = await contextRepo.loadMatter(lawFirmId, matterId);
  if (!matter) throw new NotFoundError('Matter');

  const [matterClientRows, parties, eventRows, fieldDefs] = await Promise.all([
    contextRepo.listMatterClients(lawFirmId, matterId),
    contextRepo.listMatterParties(lawFirmId, matterId),
    contextRepo.listMatterEvents(lawFirmId, matterId),
    contextRepo.listCustomFieldDefs(lawFirmId),
  ]);

  // The picked client wins; with no pick, the matter's first client.
  const linked = matterClientRows.map((c) => ({ ...c, client_id: c.id }));
  const client = pickCaseClient(linked, clientId ?? null) ?? pickedClient;
  const party = (role: string) => parties.find((p) => p.role === role) ?? null;
  const judge = party('judge');
  const opposingParty = party('opposing_party');
  const opposingCounsel = party('opposing_counsel');

  const upcoming = nextEvent(eventRows, now, () => true);
  const trial = nextEvent(eventRows, now, (e) => e.type === 'trial');
  const solEvent = nextEvent(eventRows, now, (e) => e.type === 'statute_of_limitations');
  const deadline = nextEvent(eventRows, now, (e) => Boolean(e.type && DEADLINE_EVENT_TYPES.has(e.type)));

  // ── billing, each section behind its own permission ──
  const invoiceRows = can('billing.viewInvoices')
    ? await billing.read('invoices', [], () => contextRepo.listMatterInvoices(lawFirmId, matterId))
    : [];
  // A voided invoice was withdrawn, so like a draft it is owed by nobody.
  const invoices = invoiceRows.filter((i) => i.status !== 'voided');
  const invoiceIds = invoices.map((i) => i.id);

  const linkedClientIds = Array.from(new Set(matterClientRows.map((c) => c.id)));
  const trustClientId = trustClientFor(linkedClientIds, clientId ?? null);

  const [scheduleRows, paymentRows, flatFees, timeEntries, expenses, trustBalanceCents, retainers, hourlyRate] = await Promise.all([
    billing.read('installments', [], () => contextRepo.listExpectedPayments(lawFirmId, invoiceIds)),
    billing.read('payments', [], () => contextRepo.listInvoicePayments(lawFirmId, invoiceIds)),
    can('billing.viewInvoices')
      ? billing.read('flat fees', [], () => contextRepo.listBillableActivities(lawFirmId, matterId, 'flat_fee'))
      : Promise.resolve([]),
    can('billing.viewTimeEntries')
      ? billing.read('time entries', [], () => contextRepo.listBillableActivities(lawFirmId, matterId, 'time'))
      : Promise.resolve([]),
    can('billing.viewExpenses')
      ? billing.read('expenses', [], () => contextRepo.listBillableActivities(lawFirmId, matterId, 'expense'))
      : Promise.resolve([]),
    can('trust.view') && trustClientId
      ? billing.read('trust balance', null, () => contextRepo.clientTrustBalanceCents(lawFirmId, trustClientId))
      : Promise.resolve(null),
    can('billing.viewPlans')
      ? billing.read('billing plans', [], () => contextRepo.listActiveRetainers(lawFirmId, matterId, client?.id ?? null))
      : Promise.resolve([]),
    can('billing.viewRates')
      ? billing.read('hourly rate', null, () => contextRepo.leadHourlyRateCents(lawFirmId, matterId, matter.leadUserId))
      : Promise.resolve(null),
  ]);

  // The payment schedule of the newest invoice that has one.
  const withPlan = invoiceIds.find((id) => scheduleRows.some((r) => r.invoiceId === id));
  const installments = withPlan
    ? scheduleRows
      .filter((r) => r.invoiceId === withPlan && r.dueDate)
      .map((r) => ({ amountCents: Number(r.amountCents), dueDate: r.dueDate as string, status: r.status }))
    : [];

  // A fee paid in full is due on the one invoice that carries every flat fee.
  let flatFeeTotalCents: number | null = null;
  let flatFeeDueDate: string | null = null;
  if (installments.length === 0) {
    const total = flatFees.reduce((sum, f) => sum + Number(f.amountCents ?? 0), 0);
    flatFeeTotalCents = total > 0 ? total : null;
    if (flatFees.length > 0) {
      const billedOn = await billing.read('flat fee invoices', new Map<string, string>(), () =>
        contextRepo.invoiceIdsForActivities(lawFirmId, flatFees.map((f) => f.id)));
      const feeInvoices = new Set(flatFees.map((f) => billedOn.get(f.id) ?? null));
      const [only] = [...feeInvoices];
      if (feeInvoices.size === 1 && only) flatFeeDueDate = invoices.find((i) => i.id === only)?.dueDate ?? null;
    }
  }

  // Every billable charge with a description, by date.
  const lineItems: BillableLineItem[] = [...timeEntries, ...flatFees, ...expenses]
    .map((a) => ({ date: a.activityDate ?? '', description: (a.description ?? '').trim(), amountCents: Number(a.amountCents ?? 0) }))
    .filter((l) => l.date && l.description.length > 0)
    .sort((a, b) => (a.date === b.date ? a.description.localeCompare(b.description) : a.date < b.date ? -1 : 1));

  const billingTotals: CaseBillingTotals = {
    ...summarizeCaseInvoices(invoices.map((i) => ({
      total_amount_cents: Number(i.totalCents),
      amount_paid_cents: Number(i.amountPaidCents),
      // Net of write-offs already (balance_due_cents), which is what JJ's
      // written_off exclusion was protecting.
      remaining_balance_cents: Number(i.balanceDueCents ?? 0),
      total_hours: Number(i.totalHours ?? 0),
      is_paid: i.isPaid,
      status: i.status,
    }))),
    trustBalanceCents,
    payments: paymentRows.map((p) => ({
      date: p.paymentDate as string,
      amountCents: Number(p.amountCents),
      method: p.paymentSource ?? '',
      reference: null,
    })),
    lineItems,
  };

  // The one active retainer that applies: the matter's own, else the client's.
  const matterPlans = retainers.filter((p) => p.matterId === matterId);
  const clientPlans = retainers.filter((p) => client && p.clientId === client.id);
  const retainerPlans = matterPlans.length > 0 ? matterPlans : clientPlans;
  const retainerCents = retainerPlans.length === 1 ? retainerPlans[0].amountCents : null;

  const context = assembleCaseDocumentContext({
    caseRow: {
      name: matter.name,
      case_number: matter.matterNumber,
      court_name: matter.courtName,
      lead_user_name: matter.leadUserName ?? '',
      case_reference_id: matter.matterReferenceId,
      description: matter.description,
      status: matter.status,
      practice_area_name: matter.practiceAreaName,
      category: matter.category,
      created_at: matter.openDate ? middayUtc(matter.openDate).toISOString() : matter.createdAt.toISOString(),
      opposing_party: opposingParty?.name ?? null,
      judge_name: judge?.name ?? null,
      prosecutor_name: opposingCounsel?.name ?? null,
      prosecutor_email: opposingCounsel?.email == null ? null : String(opposingCounsel.email),
    },
    attorney: matter.leadUserId ? { barNumber: null, email: matter.leadUserEmail ?? null } : null,
    court: matter.courtName
      ? { division: null, address: matter.courtAddress, city: matter.courtCity, state: matter.courtState }
      : null,
    client: toClientInput(client),
    firm: firmInput,
    nextHearing: upcoming?.date
      ? {
        typeLabel: (upcoming.type && HEARING_TYPE_LABEL[upcoming.type]) || upcoming.title,
        date: upcoming.date,
        location: upcoming.locationName || upcoming.location,
      }
      : null,
    keyDates: {
      trial: trial?.date ?? null,
      // The matter's own statute-of-limitations date first, else its event.
      statuteOfLimitations: matter.statuteOfLimitationsDate
        ? middayUtc(matter.statuteOfLimitationsDate)
        : solEvent?.date ?? null,
      nextDeadline: deadline?.date ? { title: deadline.title, date: deadline.date } : null,
    },
    installments,
    flatFeeTotalCents,
    flatFeeDueDate,
    hourlyRateCents: hourlyRate != null && hourlyRate > 0 ? hourlyRate : null,
    retainerCents,
    downPaymentCents: withPlan ? (invoices.find((i) => i.id === withPlan)?.planDownPaymentCents ?? null) : null,
    billing: billingTotals,
    now,
    timeZone,
  });

  return {
    context: {
      values: withCustomFieldValues(
        context.values,
        customFieldValues(fieldDefs, matter.customFields as Record<string, unknown> | null),
      ),
      repeaterValues: context.repeaterValues,
      billingIncomplete: billing.isIncomplete(),
    },
  };
}
