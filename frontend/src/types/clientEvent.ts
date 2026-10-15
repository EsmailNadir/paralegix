import type { LinkedFile, MatterEventContact, MatterEventType, MatterEventStatus } from './matterEvent';

export type { MatterEventType, MatterEventStatus };

export interface ClientEvent {
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
  recurrenceGroupId?: string | null;
  notes?: string | null;
  locationName?: string | null;
  location?: string | null;
  courtId?: string | null;
  courtName?: string | null;
  status: MatterEventStatus;
  source: 'matter' | 'client';
  clientId: string | null;
  clientName?: string | null;
  lawFirmId: string;
  matterId?: string | null;
  matterName?: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  allDay?: boolean;
  assignedTo?: string[];
  assignedToName?: string[];
  /**
   * Attendees who are not firm members: opposing counsel, a guardian, an
   * expert, as links into the firm contact directory. Only the reads that
   * join them populate this.
   */
  contacts?: MatterEventContact[];
  linkedFiles?: LinkedFile[];
  clientVisible?: boolean;
  clientDescription?: string | null;
  timeZone?: string | null;
}

export interface CreateClientEventRequest {
  type: MatterEventType;
  title: string;
  date: string;
  /** An all-day end is the exclusive day after the last day. */
  endsAt?: string;
  notes?: string;
  courtId?: string;
  locationName?: string;
  location?: string;
  status?: MatterEventStatus;
  matterId?: string;
  allDay?: boolean;
  assignedTo?: string[];
  assignedToName?: string[];
  contactIds?: string[];
  linkedFiles?: Omit<LinkedFile, 'linkedBy' | 'linkedAt'>[];
  clientVisible?: boolean;
  clientDescription?: string | null;
  timeZone?: string | null;
}

export interface UpdateClientEventRequest {
  source: 'matter' | 'client';
  matterId?: string;
  type?: MatterEventType;
  title?: string;
  date?: string;
  /** Null removes the end. An all-day end is the exclusive day after the last day. */
  endsAt?: string | null;
  notes?: string | null;
  courtId?: string | null;
  locationName?: string | null;
  location?: string | null;
  status?: MatterEventStatus;
  allDay?: boolean;
  assignedTo?: string[];
  assignedToName?: string[];
  contactIds?: string[];
  linkedFiles?: Omit<LinkedFile, 'linkedBy' | 'linkedAt'>[];
  clientVisible?: boolean;
  clientDescription?: string | null;
  timeZone?: string | null;
}
