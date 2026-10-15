export type TimeEntry = {
  id: string;
  timeEntryId?: string;
  lawFirmId: string;
  contextType?: 'matter' | 'client';
  entityId?: string;
  matterId?: string | null;
  matterClientId?: string | null;
  matterClientIds?: string[] | null;
  clientContextId?: string | null;
  clientId?: string | null;
  userId: string;
  userName: string;
  hours: number;
  date: string | null; // ISO string
  name?: string;
  description?: string;
  hourlyRate?: number | null;
  resolvedRate?: number | null;
  rateSource?: string | null;
  chargeCodeId?: string | null;
  sourceTaskId?: string | null;
  sourceTaskTitle?: string | null;
  sourceEventId?: string | null;
  sourceEventTitle?: string | null;
  utbmsTaskCode?: string | null;
  utbmsActivityCode?: string | null;
  /** Recorded but never invoiceable (pro bono, write-off, internal work). */
  billable?: boolean;
  billingStatus?: 'unbilled' | 'queued' | 'billed' | 'covered_by_retainer';
  isBilled?: boolean;
  source?: 'app' | 'import';
  createdAt?: string;
  updatedAt?: string;
  createdBy?: string;
};

export interface CreateTimeEntryRequest {
  lawFirmId: string;
  contextType?: 'matter' | 'client';
  matterId?: string;
  matterClientId?: string | null;
  matterClientIds?: string[] | null;
  clientId?: string;
  userId: string;
  hours: number;
  date: string; // ISO string or date string
  name?: string;
  description?: string;
  hourlyRate?: number | null;
  chargeCodeId?: string | null;
  sourceTaskId?: string | null;
  sourceEventId?: string | null;
  utbmsTaskCode?: string | null;
  utbmsActivityCode?: string | null;
  billable?: boolean;
}

export interface UpdateTimeEntryRequest {
  lawFirmId: string;
  contextType?: 'matter' | 'client';
  matterId?: string;
  matterClientId?: string | null;
  matterClientIds?: string[] | null;
  clientId?: string;
  timeEntryId: string;
  hours?: number;
  date?: string;
  name?: string;
  description?: string;
  hourlyRate?: number | null;
  chargeCodeId?: string | null;
  sourceTaskId?: string | null;
  sourceEventId?: string | null;
  utbmsTaskCode?: string | null;
  utbmsActivityCode?: string | null;
  billable?: boolean;
}

export interface GetTimeEntriesResponse {
  timeEntries: TimeEntry[];
}
