import type { User } from '@/types';
import requestDeduplicator from './requestDeduplicator';
import { authenticatedHeaders } from './base.service';

/** ===== Utilities ===== */


/** ===== Types (align with backend dashboard-summary contract) ===== */

export interface DashboardStats {
  openMatters: number | null;
  totalMatters: number | null;
  closedMatters: number | null;
  pendingTasks: number | null;
  completedTasks: number | null;
  totalTasks: number | null;
  upcomingDeadlines: number | null;
  overdueTasks: number | null;
  unreadMessages: number | null;
  conversationCount: number | null;
  teamSize: number | null;
  // Financial figures are integer cents; null when the member lacks
  // billing.viewInvoices. Hours figures are decimal hours for the acting user;
  // null when the member lacks billing.viewTimeEntries.
  outstandingArCents: number | null;
  overdueInvoiceCents: number | null;
  overdueInvoiceCount: number | null;
  collectedThisMonthCents: number | null;
  unbilledWipCents: number | null;
  unbilledHours: number | null;
  hoursToday: number | null;
  hoursThisWeek: number | null;
}

export interface DashboardRecentMatter {
  id: string;
  matterId: string;
  name: string;
  matterReferenceId: string | null;
  matterNumber: string | null;
  status: string;
  clients: { name: string }[];
  clientNames: string[];
  updatedAt: string | null;
  createdAt: string | null;
}

export interface DashboardUpcomingTask {
  id: string;
  taskId: string;
  matterId: string | null;
  matterName: string | null;
  title: string;
  status: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  dueDate: string | null;
  assignedTo: string[];
  assignedToName: string[];
  // Clients linked to the task: via matter_clients when matter-scoped, else via
  // task_clients for firm-level tasks. Parallel arrays (ids[i] ↔ names[i]).
  clientIds: string[];
  clientNames: string[];
  updatedAt: string | null;
  createdAt: string | null;
}

export interface DashboardMyAssignments {
  // Backend returns slim tasks (a subset of Task) via slimTask, not full Task
  // objects, so type them accordingly so consumers don't assume fields that the
  // dashboard projection does not include.
  tasks: DashboardUpcomingTask[];
  totalTasks: number;
}

export interface DashboardRecentConversation {
  conversationId: string;
  clientId: string;
  clientName: string;
  clientEmail: string;
  lastMessageAt: string | null;
  lastMessagePreview: string;
  unreadCountFirm: number;
}

// Pending signing session where the current user is an ACTIVE participant.
// Mirrors the `needsMySignature[]` shape the signatures pending-for-user route
// returned, now folded into the dashboard aggregate.
export interface DashboardPendingSignature {
  sessionToken: string;
  fileName: string;
  routingMode: string;
  createdAt: string | null;
  participantId: string;
  participantRole: string;
  publicToken: string | null;
  totalParticipants: number;
  completedParticipants: number;
}

// Top overdue invoice for the Financial Snapshot aging list.
export interface DashboardAgingInvoice {
  id: string;
  invoiceNumber: string | null;
  clientName: string;
  balanceDueCents: number;
  dueDate: string | null;
  daysOverdue: number;
}

// Invoice entry for the Upcoming Payments widget.
// daysRelative: positive = overdue by that many days, 0 = due today, negative = due in future.
export interface DashboardUpcomingPayment {
  id: string;
  invoiceNumber: string | null;
  clientName: string;
  balanceDueCents: number;
  totalCents: number;
  amountPaidCents: number;
  /** Credits and write-offs applied to the invoice, as stored. */
  totalWrittenOffCents: number;
  status: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  daysRelative: number;
  // Where this invoice lives: matter-scoped vs client-context, plus the id of
  // that matter/client. Drives the detail modal's navigation buttons.
  contextType: 'matter' | 'client';
  entityId: string | null;
}

// Upcoming matter/client calendar event for the Upcoming Events widget.
export interface DashboardUpcomingEvent {
  id: string;
  source: 'matter' | 'client';
  title: string;
  type: string | null;
  date: string | null;
  /** True when the event is a day, not a moment: `date` is only its noon-UTC anchor. */
  allDay?: boolean;
  locationName: string | null;
  matterId: string | null;
  matterName: string | null;
  clientId: string | null;
  clientName: string | null;
}

// One of the acting user's time entries logged today (My Time widget).
export interface DashboardTodayTimeEntry {
  id: string;
  hours: number;
  description: string;
  contextName: string | null;
  entryDate: string | null;
}

export interface DashboardPermissions {
  matters: boolean;
  tasks: boolean;
  messaging: boolean;
  members: boolean;
  signatures: boolean;
  billing: boolean;
  timeEntries: boolean;
  calendar: boolean;
  clients: boolean;
}

// Per-section runtime-failure flags. A key is present (and `true`) only when a
// section the user IS permitted to see failed to fetch on the backend, so the
// UI can show "couldn't load, retry" instead of a misleading empty state.
// `permissions.*` reflects entitlement; `sectionErrors.*` reflects fetch
// success. Optional/additive: older payloads omit it entirely.
export interface DashboardSectionErrors {
  matters?: boolean;
  taskStats?: boolean;
  upcomingTasks?: boolean;
  myAssignments?: boolean;
  overdueTasks?: boolean;
  messaging?: boolean;
  members?: boolean;
  signatures?: boolean;
  financial?: boolean;
  upcomingPayments?: boolean;
  events?: boolean;
  myTime?: boolean;
}

export interface DashboardSummaryResponse {
  stats: DashboardStats;
  recentMatters: DashboardRecentMatter[];
  upcomingTasks: DashboardUpcomingTask[];
  myAssignments: DashboardMyAssignments | null;
  // Visible-to-user tasks already past their due date (Overdue Tasks widget).
  overdueTasks?: DashboardUpcomingTask[];
  recentConversations: DashboardRecentConversation[];
  // Team roster + pending signatures folded into the aggregate (older payloads
  // omit them (treat as empty). The "Your Team" / "Pending Signatures" widgets
  // read these instead of firing their own GETs.
  teamMembers?: User[];
  pendingSignatures?: DashboardPendingSignature[];
  // Financial / calendar / time widget payloads (older payloads omit, treat as
  // empty). Present only when the corresponding permission gate is open.
  agingInvoices?: DashboardAgingInvoice[];
  upcomingPayments?: DashboardUpcomingPayment[];
  upcomingEvents?: DashboardUpcomingEvent[];
  todayTimeEntries?: DashboardTodayTimeEntry[];
  sectionErrors?: DashboardSectionErrors;
  permissions: DashboardPermissions;
}

/** ===== Service ===== */

class DashboardService {
  private apiRoot: string;

  constructor() {
    this.apiRoot = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
  }

  private async authHeaders(extra: Record<string, string> = {}) {
    return authenticatedHeaders({
      'Content-Type': 'application/json',
      ...extra,
    });
  }

  /** Single aggregate dashboard payload - DEDUPLICATED */
  async getDashboardSummary(lawFirmId: string): Promise<DashboardSummaryResponse> {
    // Timezone travels in the x-timezone header (the backend reads req.tz); it is
    // deliberately NOT a query param so the dedup cache key stays stable.
    const url = `${this.apiRoot}/lawfirms/${encodeURIComponent(lawFirmId)}/dashboard-summary`;

    const first = await requestDeduplicator.execute<DashboardSummaryResponse>(url, {
      method: 'GET',
      headers: await this.authHeaders(),
    });

    // A per-section runtime failure rides inside a 200 response (see
    // `sectionErrors` on the backend), so React Query's own one-retry policy
    // (`shouldRetryQuery`) never sees it as a failure and never retries it.
    // Left alone, a single transient blip on one section - e.g. right after
    // the tab sat idle and the Postgres pool recycled a connection - would
    // otherwise surface as a permanent "couldn't load, retry" card the user
    // has to click through by hand. Mirror the app's shared retry budget
    // (one silent retry) here instead.
    const hasSectionError = first.sectionErrors && Object.values(first.sectionErrors).some(Boolean);
    if (!hasSectionError) return first;

    try {
      return await requestDeduplicator.execute<DashboardSummaryResponse>(url, {
        method: 'GET',
        headers: await this.authHeaders(),
      });
    } catch {
      return first;
    }
  }
}

const dashboardService = new DashboardService();
export default dashboardService;
