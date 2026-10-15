/** The time-entry tabs on the notes panel, as the server understands them. */
export type NoteTimeFilter = 'all' | 'with-time' | 'without-time';

/**
 * The notes list query. Every filter mirrors a control on the notes panel and is
 * applied by the server, so a filter selects the same notes on page 9 as it does
 * on page 1 - which client-side filtering over a downloaded page could not do.
 */
export type NotesPageParams = {
  page?: number;
  limit?: number;
  search?: string;
  /** A note type, or 'all' for unset. Task notes are all 'general'. */
  noteType?: string;
  timeFilter?: NoteTimeFilter;
  /** A bare `#tag` word, without the '#'. */
  tag?: string;
  /** A single author's user id. */
  authorId?: string;
  /** Inclusive note-date bounds, 'YYYY-MM-DD'. */
  dateFrom?: string;
  dateTo?: string;
  /**
   * A deep-linked note that may not be on the requested page. The server
   * resolves which page it actually falls on under these same filters and
   * returns it as `resolvedPage`, ignoring `page`.
   */
  jumpToNoteId?: string;
};

/**
 * Counts for the panel's time tabs, over every filter EXCEPT the time filter - 
 * so selecting one tab cannot zero the other two.
 */
export type NoteTimeCounts = {
  all: number;
  withTime: number;
  withoutTime: number;
};

export type NotesPageResult = {
  notes: Note[];
  /** Size of the whole filtered set, not the page. */
  totalNotes: number;
  counts: NoteTimeCounts;
  /** Every `#tag` used across the entity's notes, for the tag dropdown. */
  tags: string[];
  /**
   * Set only when the request carried `jumpToNoteId`: the page that note
   * actually falls on under the current filters, or null if it doesn't match
   * them (or doesn't exist).
   */
  resolvedPage?: number | null;
};

/** Where one of a note's time entries sits in the invoicing pipeline. */
export type NoteTimeEntry = {
  id: string;
  entryDate: string | null;
  /** Hours as recorded, after the firm's rounding increment. */
  hours: number;
  name: string | null;
  description: string | null;
  billable: boolean;
  userId: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  invoiceStatus: string | null;
  /** False once the entry is on any invoice, including a draft. */
  editable: boolean;
};

/** 'pending' means on a draft or unapproved invoice: queued, not yet billed. */
export type NoteTimeStatus = 'none' | 'unbilled' | 'pending' | 'billed';

export type NoteTimeSummary = {
  entries: NoteTimeEntry[];
  entryCount: number;
  totalHours: number;
  billableHours: number;
  nonBillableHours: number;
  billedHours: number;
  pendingHours: number;
  unbilledHours: number;
  status: NoteTimeStatus;
  locked: boolean;
};

/** A connection out of a note, to a task or a document. */
export type NoteLink = {
  id: string;
  noteId: string;
  linkType: 'task' | 'file';
  taskId: string | null;
  fileId: string | null;
  replyId: string | null;
  /** True when the target was created from this note rather than picked from a list. */
  createdFromNote: boolean;
  createdBy: string | null;
  createdAt: string;
  /** Present only when the join found the target task/file. */
  taskTitle?: string | null;
  fileName?: string | null;
};

/** A reply to a note. Always internal; never shared with clients. */
export type NoteReply = {
  id: string;
  noteId: string;
  content: string;
  contentHtml: string;
  mentions: string[];
  attachments: Note['attachments'];
  createdBy: string | null;
  createdByName: string;
  createdAt: string;
  editedAt: string | null;
  retractedAt: string | null;
  retractedBy: string | null;
  /** Null for a top-level reply to the note; otherwise the reply this one replies to. */
  parentReplyId: string | null;
  retractionReason: string | null;
};

export type NoteVersion = {
  id: string;
  version: number;
  content: string;
  contentHtml: string;
  subject: string | null;
  noteType: string | null;
  noteDate: string | null;
  editedBy: string | null;
  editedByName: string | null;
  createdAt: string;
};

export type Note = {
  id: string;
  content: string;
  createdBy: string;
  createdByName?: string;
  createdAt: string;
  updatedAt?: string;
  editedBy?: string;
  editedByName?: string;
  editedAt?: string;
  parentType: 'matter' | 'task';
  parentId: string; // matterId or taskId
  lawFirmId: string;

  // Subject field (like Clio's subject)
  subject?: string;

  /**
   * The note's billing picture, derived from its time entries. Absent on reads
   * that do not carry it (the matter detail payload, the client portal feed).
   */
  time?: NoteTimeSummary;

  /** Tasks and documents connected to this note. Absent where links aren't read. */
  links?: NoteLink[];

  /** Non-retracted reply count. Absent where replies aren't read. */
  replyCount?: number;

  /** The date the work happened, set by the author and separate from createdAt. */
  noteDate?: string;

  pinnedAt?: string | null;
  pinnedBy?: string | null;
  retractedAt?: string | null;
  retractedBy?: string | null;
  retractionReason?: string | null;

  // Rich text content (HTML)
  contentHtml?: string;

  // Note type/category
  noteType?: string;

  // Attachments
  attachments?: {
    id: string;
    name: string;
    size: number;
    type: string;
    url: string;
  }[];
};

/**
 * A firm-custom note type, added from the composer's quick-add, or a color
 * override for a built-in type (same table - see backend `note_types`).
 * `color` is a `StatusVariant` key; null/absent means "use the default".
 */
export type NoteTypeOption = {
  id: string;
  value: string;
  label: string;
  color?: string | null;
};

/** A firm-custom note template, added from the composer's quick-add. */
export type NoteTemplateOption = {
  id: string;
  label: string;
  noteType: string;
  subject: string;
  contentHtml: string;
};
