// Re-export all types from individual files for convenient importing
// Usage: import { Matter, Task, User, ... } from "@/types"

// User types
export type { User } from "./user";

// Law Firm types
export type { LawFirm } from "./lawfirm";
export type {
  FirmSettings,
  FirmFeatures,
  FirmStorageSettings,
  ClientSettings,
  ThemePreference,
  SidebarPreferences,
  DashboardPreferences,
} from "./preferences";

// Matter types
export type { Matter, MatterClient, Category } from "./matter";

/**
 * Envelope every bulk endpoint returns. Bulk operations run per item and answer
 * 200 even when some items were rejected, so callers must read `failed`/`errors`
 * rather than relying on a thrown error to signal that nothing happened.
 */
export interface BulkResult {
  message: string;
  requested: number;
  updated?: number;
  deleted?: number;
  failed: string[];
  errors: Record<string, string>;
}

// Task types
export type { Task, TaskStatus, TaskStatusFilter, TaskAttachment } from "./task";

// Member types
export type { Member } from "./member";
export type { Role } from "./role";
export type {
  Client,
  ClientContact,
  PersonRelatedContact,
  CompanyRosterContact,
  ClientStatus,
  ClientType,
  ClientContactPortalStatus,
  PreferredContactMethod,
} from "./client";
export type {
  Contact,
  ContactType,
  ContactCategory,
  ContactMatterLink,
  ContactUpsertPayload,
} from "./contact";
export type {
  Invoice,
  InvoiceLineItem,
  InvoiceFlatFee,
  InvoicePayment,
  ClientBillingEntryStatus,
  ClientBillingInvoiceRelation,
  ClientBillingRowMetadata,
  ClientBillingInvoiceMetadata,
  BillingContextType,
  SplitBillingMode,
  BillingContext,
  FlatFee,
  UnbilledSummary,
  PaymentDate,
  FirmBillingInvoice,
  FirmBillingTimeEntry,
  BillingPlan,
  BillingPlanPeriod,
  BillingCollectionItem,
  BillingReadyItem,
  BillingWorkbenchResponse,
} from "./billing";

// Time Entry types
export type { TimeEntry, CreateTimeEntryRequest, UpdateTimeEntryRequest, GetTimeEntriesResponse } from "./timeEntry";

// Practice Area types
export type { PracticeArea } from "./practiceArea";

// Court types
export type { Court } from "./court";

// Charge Code types
export type { ChargeCode } from "./chargeCode";

// Note types
export type { Note } from "./note";

// Message types
export type {
  Message,
  MessageAttachment,
  Conversation,
  ConversationListQuery,
  ConversationPage,
  SendMessageData,
  GroupParticipant,
  GroupConversation,
  GroupConversationResponse,
  PendingGroupClient,
  MessageSearchResult,
  PortalConversationSummary,
} from "./message";

// Event types
export type { Event } from "./event";

// Order types
export type { Order, OrderBy } from "./order";

// Sync Flags types
export type { SyncFlags } from "./syncFlags";

// Re-export every domain type module.
export * from "./task";
export * from "./lawfirm";
export * from "./matter";
export * from "./user";
export * from "./order";
export * from "./practiceArea";
export * from "./member";
export * from "./role";
export * from "./client";
export * from "./lead";
export * from "./billing";
export * from "./note";
export * from "./syncFlags";
export * from "./event";
export * from "./timeEntry";
export * from "./preferences";
export * from "./matterEvent";
export * from "./court";
