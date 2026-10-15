export type Event = {
  id: string;
  title: string;
  description?: string;
  start?: string;
  end?: string;
  /** Start and end as the server formatted them in the viewer's zone, when the API sends them. */
  startLocalDisplay?: string | null;
  endLocalDisplay?: string | null;
  allDay?: boolean;
  clientNames?: string[];
  /** Name of the matter the event belongs to, when it came from one. */
  matterName?: string | null;
  // editing support
  source?: 'matter' | 'client' | 'external';
  provider?: 'google' | 'outlook';
  startTimeZone?: string | null;
  meeting?: {
    organizer?: { email?: string; displayName?: string; address?: string; name?: string } | null;
    attendees: { email?: string; displayName?: string | null; responseStatus?: string; isSelf?: boolean }[];
    responseStatus?: string | null;
    status?: string;
    isPrivate?: boolean;
    isOrganizer?: boolean;
    providerUrl?: string | null;
    joinUrl?: string | null;
  } | null;
  matterId?: string;
  clientId?: string | null;
  eventType?: string;
  notes?: string | null;
  /**
   * Where the event is, for display. A firm event joins its location name and
   * address here; an imported event has only this one field.
   */
  location?: string | null;
  /** A firm event's own location name, as stored. Never the court. */
  locationName?: string | null;
  /** A firm event's address, as stored: the one location field its edit form changes. */
  locationAddress?: string | null;
  /** The court shown beside the location, chosen by `eventCourtName`. */
  court?: string | null;
  eventStatus?: string;
  /** Set on a matter event that belongs to a recurring series. */
  recurrenceGroupId?: string | null;
};
