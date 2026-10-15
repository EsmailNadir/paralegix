export type MatterEventType =
  | 'court_date'
  | 'hearing'
  | 'deposition'
  | 'filing_deadline'
  | 'discovery_cutoff'
  | 'mediation'
  | 'arbitration'
  | 'trial'
  | 'appeal_deadline'
  | 'statute_of_limitations'
  | 'meeting'
  | 'other';

export type MatterEventStatus = 'upcoming' | 'completed' | 'cancelled';

/** A directory contact attending an event. */
export interface MatterEventContact {
  contactId: string;
  name: string;
  category: string;
  email?: string | null;
  organization?: string | null;
}

export interface MatterEvent {
  id: string;
  type: MatterEventType;
  title: string;
  date: string | null;
  endsAt?: string | null;
  endsAtLocalDisplay?: string | null;
  /** The end as a form value in the caller's zone, like `dateLocalInput`. */
  endsAtLocalInput?: string | null;
  dateLocalDisplay?: string | null;
  dateLocalInput?: string | null;
  notes?: string | null;
  courtName?: string | null;
  locationName?: string | null;
  location?: string | null;
  status: MatterEventStatus;
  matterId: string;
  /** The event's matter name, resolved server-side so the calendar need not load every matter. */
  matterName?: string | null;
  /** The matter's client names, resolved server-side for the same reason. */
  clientNames?: string[];
  lawFirmId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  googleEventId?: string | null;
  outlookId?: string | null;
  assignedTo?: string[];
  assignedToName?: string[];
  /**
   * Attendees who are not firm members - opposing counsel, a court reporter, an
   * expert - as links into the firm contact directory. Only the reads that join
   * them populate this; a calendar-sync read reports an empty list.
   */
  contacts?: MatterEventContact[];
  cancellationReason?: string | null;
  cancelledBy?: string | null;
  cancelledAt?: string | null;
  postponementCount?: number;
  postponementHistory?: PostponementEntry[];
  linkedFiles?: LinkedFile[];
  dependsOn?: string[];
  recurrence?: RecurrenceRule | null;
  recurrenceGroupId?: string | null;
  recurrenceIndex?: number | null;
  isRecurrenceParent?: boolean;
  lastReminderSentAt?: string | null;
  reminderCount?: number;
  clientVisible?: boolean;
  clientDescription?: string | null;
  timeZone?: string | null;
  allDay?: boolean;
}

export interface PostponementEntry {
  previousDate: string;
  newDate: string;
  reason: string;
  postponedBy: string;
  postponedAt: string;
}

export interface LinkedFile {
  /**
   * The document this links to. The rest is a snapshot the calendar renders
   * without a lookup; the id is what the link IS.
   *
   * It used to be the object path, which a rename or a move rewrote, so a link
   * made before either one pointed at nothing afterwards.
   */
  fileId: string;
  name: string;
  size: number;
  contentType: string;
  scope: 'matter' | 'task' | 'client' | 'general';
  scopeId?: string;
  linkedBy: string;
  linkedAt: string;
}

export interface RecurrenceRule {
  pattern: 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'custom';
  interval: number;
  endType: 'count' | 'date';
  endCount?: number;
  endDate?: string;
  daysOfWeek?: number[];
}

/**
 * One node of a matter's event dependency graph.
 *
 * The five fields blocking and the "depends on" / "required by" chips actually
 * read. Deliberately narrow: this list is never paged, so it has to stay cheap
 * enough to fetch in full on a matter with years of history.
 */
export interface EventGraphNode {
  id: string;
  type: MatterEventType;
  title: string;
  status: MatterEventStatus;
  date: string | null;
  dateLocalDisplay: string | null;
  dependsOn: string[];
}
