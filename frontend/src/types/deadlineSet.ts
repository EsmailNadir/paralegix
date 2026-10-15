import type { MatterEventType, MatterEvent } from './matterEvent';

// A single deadline in a template: an event created at an offset from the
// chosen anchor date when the set is applied to a matter.
export interface DeadlineSetItem {
  title: string;
  type: MatterEventType;
  offsetDays: number;
  offsetDirection: 'before' | 'after';
  // What the offset is measured from. 'previous' chains off the date computed
  // for the item above it instead of the trigger date; the first item is
  // always 'trigger' since it has no previous item to chain from.
  relativeTo?: 'trigger' | 'previous';
  clientVisible?: boolean;
  notes?: string | null;
}

export interface DeadlineSet {
  id: string;
  name: string;
  description?: string | null;
  adjustForWeekends: boolean;
  items: DeadlineSetItem[];
  createdBy?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface CreateDeadlineSetRequest {
  name: string;
  description?: string | null;
  adjustForWeekends?: boolean;
  items: DeadlineSetItem[];
}

export type UpdateDeadlineSetRequest = Partial<CreateDeadlineSetRequest>;

export interface ApplyDeadlineSetResponse {
  message: string;
  created: number;
  events: MatterEvent[];
}
