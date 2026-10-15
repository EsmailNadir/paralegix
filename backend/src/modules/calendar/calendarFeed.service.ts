/**
 * The calendar's five range reads, answered in one request.
 *
 * Each section calls the SAME service function its standalone endpoint calls,
 * with the same arguments, so its body is identical to that endpoint's for the
 * same window and every row-level rule (matter membership, the syncing member's
 * own external events, the task ethical wall, accessible matters on payment
 * dates) is inherited rather than restated:
 *
 *   matterEvents    GET /matters/events                          matters.view
 *   clientEvents    GET /clients/events                          clients.view
 *   calendarEvents  GET /calendar-events                         calendar.view
 *   tasks           GET /tasks?dueFrom&dueTo&includeSpanning=true tasks.view
 *   paymentDates    GET /billing/invoices/calendar-payment-dates billing.viewInvoices
 *
 * A section whose permission the caller does not hold is `null` rather than a
 * refusal, so one missing code leaves the rest of the calendar readable.
 */
import { DASHBOARD_CONNECTION_CAPACITY } from '../../shared/database/connectionBudget';
import { runWithWeightedConcurrency, type WeightedWorkItem } from '../../shared/utils/runWithConcurrency';
import { resolveCalendarRange } from '../../shared/utils/calendarRange';
import { hasPermission } from '../lawfirms/roles/permissions';

const matterEventsService = require('../matters/matterEvents.service');
const clientEventsService = require('../clients/clientEvents.service');
const calendarEventsService = require('./calendarEvents.service');
const tasksService = require('../tasks/tasks.service');
const invoicesService = require('../billing/invoices/invoices.service');

export const CALENDAR_FEED_SECTIONS = {
  matterEvents: 'matters.view',
  clientEvents: 'clients.view',
  calendarEvents: 'calendar.view',
  tasks: 'tasks.view',
  paymentDates: 'billing.viewInvoices',
} as const;

type SectionName = keyof typeof CALENDAR_FEED_SECTIONS;

/** Every code that admits a caller to at least one section. */
export const CALENDAR_FEED_PERMISSIONS = Object.values(CALENDAR_FEED_SECTIONS);

interface CalendarFeedInput {
  lawFirmId: string;
  userId: string;
  /** The resolved member `requirePermission` attached to the request. */
  member: unknown;
  timezone: string;
  from: string;
  to: string;
}

export async function getCalendarFeed({ lawFirmId, userId, member, timezone, from, to }: CalendarFeedInput) {
  const range = resolveCalendarRange({ from, to, timezone });

  // `weight` is each read's peak simultaneous pool connections, so the batch is
  // admitted against the same per-request ceiling the dashboard uses rather than
  // taking the whole pool. Matter events runs three queries together after its
  // membership probe; payment dates runs two pairs; the rest query one at a time.
  const reads: Record<SectionName, { weight: number; run: () => Promise<unknown> }> = {
    matterEvents: {
      weight: 3,
      run: () => matterEventsService.listAllMatterEvents({ lawFirmId, userId, timezone, range }),
    },
    clientEvents: {
      weight: 1,
      run: () => clientEventsService.listAllClientEvents({ lawFirmId, userId, timezone, range }),
    },
    calendarEvents: {
      weight: 1,
      run: () => calendarEventsService.listExternalCalendarEvents({ lawFirmId, userId, timezone, range }),
    },
    tasks: {
      weight: 1,
      run: () => tasksService.listLawFirmTasks({ lawFirmId, userId, timezone, dueFrom: from, dueTo: to, includeSpanning: true }),
    },
    paymentDates: {
      weight: 2,
      run: () => invoicesService.getCalendarPaymentDates({ lawFirmId, actingUserId: userId, window: { from, to } }),
    },
  };

  const allowed = (Object.keys(reads) as SectionName[])
    .filter((section) => hasPermission(member, CALENDAR_FEED_SECTIONS[section]));
  const work: Array<WeightedWorkItem<unknown>> = allowed.map((section) => reads[section]);
  const settled = await runWithWeightedConcurrency(work, DASHBOARD_CONNECTION_CAPACITY);

  const feed: Record<SectionName, unknown> = {
    matterEvents: null,
    clientEvents: null,
    calendarEvents: null,
    tasks: null,
    paymentDates: null,
  };
  settled.forEach((result, index) => {
    // A failed read fails the feed, exactly as it would fail its standalone
    // request. Answering null would be indistinguishable from "not permitted".
    if (result.status === 'rejected') throw result.reason;
    feed[allowed[index]] = result.value;
  });
  return feed;
}
