import { customType } from "drizzle-orm/pg-core"
import { bigint, boolean, check, date, foreignKey, index, integer, jsonb, numeric, pgPolicy, pgTable, primaryKey, text, timestamp, type AnyPgColumn, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

/**
 * Postgres types drizzle-kit's introspection cannot map. Declared here so the
 * generated columns below have a real type instead of the invalid `unknown(...)`
 * it emits. Injected by db/normalize-drizzle-schema.ts after every pull.
 */
const citext = customType<{ data: string }>({ dataType: () => 'citext' });
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });



export const activities = pgTable("activities", {
	hours: numeric({ precision: 6, scale:  2 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rateCents: bigint("rate_cents", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rateSource: text("rate_source"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	chargeCents: bigint("charge_cents", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amountCents: bigint("amount_cents", { mode: "number" }).generatedAlwaysAs(sql`
CASE
    WHEN (kind = 'time'::text) THEN (round((COALESCE(hours, (0)::numeric) * (COALESCE(resolved_rate_cents, rate_cents, (0)::bigint))::numeric)))::bigint
    ELSE COALESCE(charge_cents, (0)::bigint)
END`),
	activityDate: date("activity_date"),
	billable: boolean().default(true).notNull(),
	billingCodeId: uuid("billing_code_id"),
	billingPlanPeriodId: uuid("billing_plan_period_id"),
	category: text(),
	clientId: uuid("client_id"),
	coverage: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	description: text(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	kind: text().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	linkedNoteId: uuid("linked_note_id"),
	matterClientIds: jsonb("matter_client_ids"),
	matterId: uuid("matter_id"),
	name: text(),
	receiptObjectPath: text("receipt_object_path"),
	resolvedRateCents: bigint("resolved_rate_cents", { mode: "number" }),
	source: text(),
	sourceEventId: uuid("source_event_id"),
	sourceTaskId: uuid("source_task_id"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	userId: text("user_id"),
	utbmsActivityCode: text("utbms_activity_code"),
	utbmsTaskCode: text("utbms_task_code"),
	vendor: text(),
}, (table) => [
	foreignKey({
			columns: [table.billingPlanPeriodId],
			foreignColumns: [billingPlanPeriods.id],
			name: "activities_billing_plan_period_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.clientId],
			foreignColumns: [clients.id],
			name: "activities_client_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "activities_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId, table.billingCodeId],
			foreignColumns: [billingCodes.id, billingCodes.lawFirmId],
			name: "activities_law_firm_id_billing_code_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.lawFirmId, table.matterId],
			foreignColumns: [matters.id, matters.lawFirmId],
			name: "activities_law_firm_id_matter_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "activities_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.sourceEventId],
			foreignColumns: [events.id],
			name: "activities_source_event_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.sourceTaskId],
			foreignColumns: [tasks.id],
			name: "activities_source_task_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "activities_user_id_fkey"
		}).onDelete("restrict"),
	check("activities_charge_cents_check", sql`(charge_cents IS NULL) OR (charge_cents >= 0)`),
	check("activities_check", sql`(matter_id IS NOT NULL) <> (client_id IS NOT NULL)`),
	check("activities_check1", sql`(source_task_id IS NULL) OR (source_event_id IS NULL)`),
	check("activities_check2", sql`(billing_plan_period_id IS NULL) = (coverage IS NULL)`),
	index("activities_client_fk_idx").using("btree", table.clientId.asc().nullsLast()).where(sql`(client_id IS NOT NULL)`),
	check("activities_coverage_check", sql`(coverage IS NULL) OR (coverage = ANY (ARRAY['covered'::text, 'overage'::text]))`),
	check("activities_expense_shape", sql`(kind <> 'expense'::text) OR ((hours IS NULL) AND (rate_cents IS NULL) AND (matter_client_ids IS NULL) AND (utbms_task_code IS NULL) AND (utbms_activity_code IS NULL) AND (source IS NULL) AND (source_task_id IS NULL) AND (source_event_id IS NULL) AND (linked_note_id IS NULL) AND (billing_plan_period_id IS NULL))`),
	index("activities_firm_billing_code_fk_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.billingCodeId.asc().nullsLast()).where(sql`(billing_code_id IS NOT NULL)`),
	index("activities_firm_kind_client_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.kind.asc().nullsLast(), table.clientId.asc().nullsLast()),
	index("activities_firm_kind_date_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.kind.asc().nullsLast(), table.activityDate.asc().nullsLast()),
	index("activities_firm_kind_matter_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.kind.asc().nullsLast(), table.matterId.asc().nullsLast(), table.userId.asc().nullsLast()),
	index("activities_firm_matter_hours_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.matterId.asc().nullsLast(), table.hours.asc().nullsLast()).where(sql`(kind = 'time'::text)`),
	check("activities_flat_fee_shape", sql`(kind <> 'flat_fee'::text) OR ((hours IS NULL) AND (rate_cents IS NULL) AND (matter_client_ids IS NULL) AND (utbms_task_code IS NULL) AND (utbms_activity_code IS NULL) AND (source IS NULL) AND (source_task_id IS NULL) AND (source_event_id IS NULL) AND (linked_note_id IS NULL) AND (billing_plan_period_id IS NULL) AND (billing_code_id IS NULL) AND (vendor IS NULL) AND (category IS NULL) AND (receipt_object_path IS NULL) AND (user_id IS NULL))`),
	check("activities_hours_check", sql`(hours IS NULL) OR (hours >= (0)::numeric)`),
	check("activities_kind_check", sql`kind = ANY (ARRAY['time'::text, 'expense'::text, 'flat_fee'::text])`),
	unique("activities_law_firm_id_id_key").on(table.id, table.lawFirmId),
	index("activities_linked_note_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.linkedNoteId.asc().nullsLast()).where(sql`(linked_note_id IS NOT NULL)`),
	index("activities_period_fk_idx").using("btree", table.billingPlanPeriodId.asc().nullsLast()).where(sql`(billing_plan_period_id IS NOT NULL)`),
	index("activities_period_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.billingPlanPeriodId.asc().nullsLast()).where(sql`(billing_plan_period_id IS NOT NULL)`),
	check("activities_rate_cents_check", sql`(rate_cents IS NULL) OR (rate_cents >= 0)`),
	check("activities_rate_only_on_time", sql`(kind = 'time'::text) OR ((resolved_rate_cents IS NULL) AND (rate_source IS NULL))`),
	check("activities_rate_source_check", sql`(rate_source IS NULL) OR (rate_source = ANY (ARRAY['time entry override'::text, 'matter member rate'::text, 'client member rate'::text, 'client default rate'::text, 'charge code member rate'::text, 'charge code default'::text, 'user default rate'::text, 'firm default rate'::text, 'none'::text]))`),
	check("activities_resolved_rate_cents_check", sql`(resolved_rate_cents IS NULL) OR (resolved_rate_cents >= 0)`),
	index("activities_source_event_fk_idx").using("btree", table.sourceEventId.asc().nullsLast()).where(sql`(source_event_id IS NOT NULL)`),
	index("activities_source_task_fk_idx").using("btree", table.sourceTaskId.asc().nullsLast()).where(sql`(source_task_id IS NOT NULL)`),
	check("activities_time_shape", sql`(kind <> 'time'::text) OR ((activity_date IS NOT NULL) AND (charge_cents IS NULL) AND (vendor IS NULL) AND (category IS NULL) AND (receipt_object_path IS NULL))`),
	index("activities_user_fk_idx").using("btree", table.userId.asc().nullsLast()).where(sql`(user_id IS NOT NULL)`),
]);

export const activityLog = pgTable("activity_log", {
	activityType: text("activity_type").notNull(),
	actorName: text("actor_name"),
	actorUserId: text("actor_user_id"),
	clientId: uuid("client_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	matterId: uuid("matter_id"),
	metadata: jsonb().default({}).notNull(),
	summary: text().notNull(),
	taskId: uuid("task_id"),
}, (table) => [
	foreignKey({
			columns: [table.actorUserId],
			foreignColumns: [users.id],
			name: "activity_log_actor_user_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId, table.matterId],
			foreignColumns: [matters.id, matters.lawFirmId],
			name: "activity_log_law_firm_id_matter_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.taskId],
			foreignColumns: [tasks.id, tasks.lawFirmId],
			name: "activity_log_law_firm_id_task_id_fkey"
		}).onDelete("cascade"),
	index("activity_log_firm_client_time_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.clientId.asc().nullsLast(), table.createdAt.desc().nullsFirst(), table.id.desc().nullsFirst()).where(sql`(client_id IS NOT NULL)`),
	index("activity_log_firm_matter_time_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.matterId.asc().nullsLast(), table.createdAt.desc().nullsFirst(), table.id.desc().nullsFirst()),
	index("activity_log_firm_matter_type_time_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.matterId.asc().nullsLast(), table.activityType.asc().nullsLast(), table.createdAt.desc().nullsFirst()),
	index("activity_log_firm_task_time_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.taskId.asc().nullsLast(), table.createdAt.desc().nullsFirst(), table.id.desc().nullsFirst()).where(sql`(task_id IS NOT NULL)`),
	unique("activity_log_law_firm_id_id_key").on(table.id, table.lawFirmId),
	check("activity_log_one_parent", sql`num_nonnulls(matter_id, client_id, task_id) = 1`),
]);

export const attachments = pgTable("attachments", {
	activityId: uuid("activity_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	documentRequestItemId: uuid("document_request_item_id"),
	eventId: uuid("event_id"),
	fileId: uuid("file_id").notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	messageId: uuid("message_id"),
	noteId: uuid("note_id"),
	noteReplyId: uuid("note_reply_id"),
	sortOrder: integer("sort_order"),
	taskId: uuid("task_id"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "attachments_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.fileId],
			foreignColumns: [files.id],
			name: "attachments_file_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.activityId],
			foreignColumns: [activities.id, activities.lawFirmId],
			name: "attachments_law_firm_id_activity_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.documentRequestItemId],
			foreignColumns: [documentRequestItems.id, documentRequestItems.lawFirmId],
			name: "attachments_law_firm_id_document_request_item_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.eventId],
			foreignColumns: [events.id, events.lawFirmId],
			name: "attachments_law_firm_id_event_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.fileId],
			foreignColumns: [files.id, files.lawFirmId],
			name: "attachments_law_firm_id_file_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.noteId],
			foreignColumns: [notes.id, notes.lawFirmId],
			name: "attachments_law_firm_id_note_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.noteReplyId],
			foreignColumns: [noteReplies.id, noteReplies.lawFirmId],
			name: "attachments_law_firm_id_note_reply_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.taskId],
			foreignColumns: [tasks.id, tasks.lawFirmId],
			name: "attachments_law_firm_id_task_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "attachments_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.messageId],
			foreignColumns: [messages.id],
			name: "attachments_message_id_fkey"
		}).onDelete("cascade"),
	check("attachments_check", sql`num_nonnulls(note_id, note_reply_id, message_id, task_id, event_id, activity_id, document_request_item_id) = 1`),
	index("attachments_created_by_idx").using("btree", table.createdBy.asc().nullsLast()).where(sql`(created_by IS NOT NULL)`),
	index("attachments_file_id_idx").using("btree", table.fileId.asc().nullsLast()),
	index("attachments_firm_activity_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.activityId.asc().nullsLast()).where(sql`(activity_id IS NOT NULL)`),
	index("attachments_firm_doc_req_item_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.documentRequestItemId.asc().nullsLast()).where(sql`(document_request_item_id IS NOT NULL)`),
	index("attachments_firm_event_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.eventId.asc().nullsLast()).where(sql`(event_id IS NOT NULL)`),
	index("attachments_firm_file_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.fileId.asc().nullsLast()),
	index("attachments_firm_note_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.noteId.asc().nullsLast()).where(sql`(note_id IS NOT NULL)`),
	index("attachments_firm_note_reply_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.noteReplyId.asc().nullsLast()).where(sql`(note_reply_id IS NOT NULL)`),
	index("attachments_firm_task_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.taskId.asc().nullsLast()).where(sql`(task_id IS NOT NULL)`),
	unique("attachments_law_firm_id_id_key").on(table.id, table.lawFirmId),
	index("attachments_message_idx").using("btree", table.messageId.asc().nullsLast()).where(sql`(message_id IS NOT NULL)`),
]);

export const auditEvents = pgTable("audit_events", {
	action: text().notNull(),
	actorEmail: text("actor_email"),
	actorUid: text("actor_uid"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	ip: text(),
	lawFirmId: uuid("law_firm_id"),
	metadata: jsonb().default({}).notNull(),
	method: text(),
	path: text(),
	resourceId: text("resource_id"),
	resourceType: text("resource_type"),
	statusCode: integer("status_code"),
	userAgent: text("user_agent"),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "audit_events_law_firm_id_fkey"
		}).onDelete("cascade"),
	index("audit_events_actor_idx").using("btree", table.actorUid.asc().nullsLast(), table.createdAt.desc().nullsFirst()),
	index("audit_events_firm_action_time_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.action.asc().nullsLast(), table.createdAt.desc().nullsFirst(), table.id.desc().nullsFirst()),
	index("audit_events_firm_actor_time_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.actorUid.asc().nullsLast(), table.createdAt.desc().nullsFirst(), table.id.desc().nullsFirst()),
	index("audit_events_firm_time_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.createdAt.desc().nullsFirst()),
]);

export const billingCodes = pgTable("billing_codes", {
	defaultRate: numeric("default_rate"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	code: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	defaultRateCents: bigint("default_rate_cents", { mode: "number" }),
	id: uuid().defaultRandom().primaryKey().notNull(),
	isActive: boolean("is_active").default(true).notNull(),
	isDefault: boolean("is_default").default(false).notNull(),
	kind: text().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	memberRates: jsonb("member_rates").default({}).notNull(),
	name: text().notNull(),
	sortOrder: integer("sort_order"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	utbmsCodeId: uuid("utbms_code_id"),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "billing_codes_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "billing_codes_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.utbmsCodeId],
			foreignColumns: [utbmsCodes.id],
			name: "billing_codes_utbms_code_id_fkey"
		}).onDelete("set null"),
	check("billing_codes_default_rate_cents_check", sql`(default_rate_cents IS NULL) OR (default_rate_cents >= 0)`),
	index("billing_codes_firm_kind_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.kind.asc().nullsLast(), table.sortOrder.asc().nullsLast()),
	check("billing_codes_kind_check", sql`kind = ANY (ARRAY['charge'::text, 'expense'::text])`),
	unique("billing_codes_law_firm_id_id_key").on(table.id, table.lawFirmId),
	unique("billing_codes_law_firm_id_kind_code_key").on(table.lawFirmId, table.kind, table.code),
	check("billing_codes_rate_only_on_charge", sql`(kind = 'charge'::text) OR ((default_rate IS NULL) AND (default_rate_cents IS NULL) AND (member_rates = '{}'::jsonb))`),
	index("billing_codes_utbms_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.utbmsCodeId.asc().nullsLast()).where(sql`(utbms_code_id IS NOT NULL)`),
]);

export const billingPlanPeriods = pgTable("billing_plan_periods", {
	status: text().default('ready_to_bill').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amountCents: bigint("amount_cents", { mode: "number" }),
	billingPlanId: uuid("billing_plan_id").notNull(),
	consumedHours: numeric("consumed_hours"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	dueDate: date("due_date"),
	generatedAt: timestamp("generated_at", { withTimezone: true, mode: 'date' }),
	generatedInvoiceContextType: text("generated_invoice_context_type"),
	generatedInvoiceEntityId: uuid("generated_invoice_entity_id"),
	generatedInvoiceId: uuid("generated_invoice_id"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	includedHours: numeric("included_hours"),
	lawFirmId: uuid("law_firm_id").notNull(),
	overageHours: numeric("overage_hours"),
	periodEndDate: date("period_end_date"),
	periodStartDate: date("period_start_date"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.billingPlanId],
			foreignColumns: [billingPlans.id],
			name: "billing_plan_periods_billing_plan_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.generatedInvoiceId],
			foreignColumns: [invoices.id],
			name: "period_generated_invoice_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "billing_plan_periods_law_firm_id_fkey"
		}).onDelete("cascade"),
	check("billing_plan_periods_amount_cents_check", sql`(amount_cents IS NULL) OR (amount_cents >= 0)`),
	unique("billing_plan_periods_billing_plan_id_period_start_date_key").on(table.billingPlanId, table.periodStartDate),
	check("billing_plan_periods_generated_invoice_context_type_check", sql`(generated_invoice_context_type IS NULL) OR (generated_invoice_context_type = ANY (ARRAY['matter'::text, 'client'::text]))`),
	check("billing_plan_periods_status_check", sql`status = ANY (ARRAY['ready_to_bill'::text, 'draft_created'::text, 'skipped'::text])`),
]);

export const billingPlans = pgTable("billing_plans", {
	endDate: date("end_date"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	includedHours: numeric("included_hours"),
	// TODO: failed to parse database type 'citext'
	amountCents: bigint("amount_cents", { mode: "number" }),
	billingEmail: citext("billing_email"),
	clientId: uuid("client_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	defaultClientId: uuid("default_client_id"),
	defaultDueDays: integer("default_due_days"),
	endCondition: text("end_condition").default('manual'),
	id: uuid().defaultRandom().primaryKey().notNull(),
	intervalCount: integer("interval_count"),
	intervalUnit: text("interval_unit"),
	lawFirmId: uuid("law_firm_id").notNull(),
	matterId: uuid("matter_id"),
	name: text().notNull(),
	nextRunDate: date("next_run_date"),
	notes: text(),
	planType: text("plan_type").default('retainer').notNull(),
	startDate: date("start_date"),
	status: text().default('active').notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	updatedBy: text("updated_by"),
}, (table) => [
	foreignKey({
			columns: [table.clientId],
			foreignColumns: [clients.id],
			name: "billing_plans_client_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "billing_plans_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.defaultClientId],
			foreignColumns: [clients.id],
			name: "billing_plans_default_client_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.lawFirmId, table.matterId],
			foreignColumns: [matters.id, matters.lawFirmId],
			name: "billing_plans_law_firm_id_matter_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "billing_plans_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.updatedBy],
			foreignColumns: [users.id],
			name: "billing_plans_updated_by_fkey"
		}).onDelete("restrict"),
	check("billing_plans_amount_cents_check", sql`(amount_cents IS NULL) OR (amount_cents >= 0)`),
	check("billing_plans_check", sql`(matter_id IS NOT NULL) <> (client_id IS NOT NULL)`),
	index("billing_plans_client_id_idx").using("btree", table.clientId.asc().nullsLast()),
	index("billing_plans_default_client_id_idx").using("btree", table.defaultClientId.asc().nullsLast()),
	check("billing_plans_end_condition_check", sql`end_condition = ANY (ARRAY['manual'::text, 'matter_closed'::text, 'date'::text])`),
	check("billing_plans_included_hours_check", sql`(included_hours IS NULL) OR (included_hours >= (0)::numeric)`),
	check("billing_plans_interval_count_check", sql`(interval_count IS NULL) OR (interval_count > 0)`),
	check("billing_plans_interval_unit_check", sql`interval_unit = ANY (ARRAY['week'::text, 'month'::text])`),
	unique("billing_plans_law_firm_id_id_key").on(table.id, table.lawFirmId),
	check("billing_plans_plan_type_check", sql`plan_type = 'retainer'::text`),
	check("billing_plans_status_check", sql`status = ANY (ARRAY['active'::text, 'paused'::text, 'ended'::text])`),
]);

export const calendarEvents = pgTable("calendar_events", {
	allDay: boolean("all_day").default(false).notNull(),
	calendarId: text("calendar_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	description: text(),
	endsAt: timestamp("ends_at", { withTimezone: true, mode: 'date' }),
	externalEventId: text("external_event_id"),
	googleEventId: text("google_event_id"),
	googleLastModified: timestamp("google_last_modified", { withTimezone: true, mode: 'date' }),
	icalUid: text("ical_uid"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lastSyncedToGoogle: timestamp("last_synced_to_google", { withTimezone: true, mode: 'date' }),
	lastSyncedToOutlook: timestamp("last_synced_to_outlook", { withTimezone: true, mode: 'date' }),
	lawFirmId: uuid("law_firm_id").notNull(),
	location: text(),
	notes: text(),
	outlookChangeKey: text("outlook_change_key"),
	outlookId: text("outlook_id"),
	outlookLastModified: timestamp("outlook_last_modified", { withTimezone: true, mode: 'date' }),
	provider: text(),
	providerDetails: jsonb("provider_details").default({}).notNull(),
	seriesEventId: text("series_event_id"),
	source: text(),
	stableId: text("stable_id"),
	startsAt: timestamp("starts_at", { withTimezone: true, mode: 'date' }),
	startTimeZone: text("start_time_zone"),
	title: text().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "calendar_events_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "calendar_events_law_firm_id_fkey"
		}).onDelete("cascade"),
	index("calendar_events_firm_start_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.startsAt.asc().nullsLast()),
	index("calendar_events_google_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.googleEventId.asc().nullsLast()).where(sql`(google_event_id IS NOT NULL)`),
	index("calendar_events_ical_uid_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.createdBy.asc().nullsLast(), table.icalUid.asc().nullsLast()).where(sql`(ical_uid IS NOT NULL)`),
	index("calendar_events_outlook_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.outlookId.asc().nullsLast()).where(sql`(outlook_id IS NOT NULL)`),
	index("calendar_events_owner_google_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.createdBy.asc().nullsLast(), table.googleEventId.asc().nullsLast()).where(sql`(google_event_id IS NOT NULL)`),
	check("calendar_events_provider_check", sql`provider = ANY (ARRAY['google'::text, 'outlook'::text])`),
	index("calendar_events_series_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.createdBy.asc().nullsLast(), table.seriesEventId.asc().nullsLast()).where(sql`(series_event_id IS NOT NULL)`),
	index("calendar_events_stable_id_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.stableId.asc().nullsLast()),
]);

export const calendarMappings = pgTable("calendar_mappings", {
	calendarId: text("calendar_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	entityId: text("entity_id"),
	entityType: text("entity_type"),
	externalEventId: text("external_event_id").notNull(),
	itemKey: text("item_key"),
	lawFirmId: uuid("law_firm_id"),
	provider: text().notNull(),
	pushedModifiedAt: timestamp("pushed_modified_at", { withTimezone: true, mode: 'date' }),
	pushedVersion: text("pushed_version"),
	scopeId: text("scope_id"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	userId: text("user_id"),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "calendar_mappings_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "calendar_mappings_user_id_fkey"
		}).onDelete("restrict"),
	primaryKey({ columns: [table.provider, table.externalEventId], name: "calendar_mappings_pkey"}),
	uniqueIndex("calendar_mappings_entity_item_uidx").using("btree", table.provider.asc().nullsLast(), table.userId.asc().nullsLast(), table.entityType.asc().nullsLast(), table.entityId.asc().nullsLast(), table.itemKey.asc().nullsLast()),
	index("calendar_mappings_entity_idx").using("btree", table.entityType.asc().nullsLast(), table.entityId.asc().nullsLast()),
	check("calendar_mappings_entity_type_check", sql`(entity_type IS NULL) OR (entity_type = ANY (ARRAY['task'::text, 'matterEvent'::text, 'clientEvent'::text, 'externalEvent'::text, 'invoiceBilling'::text]))`),
	index("calendar_mappings_firm_idx").using("btree", table.lawFirmId.asc().nullsLast()),
	check("calendar_mappings_provider_check", sql`provider = ANY (ARRAY['google'::text, 'outlook'::text])`),
	index("calendar_mappings_user_idx").using("btree", table.userId.asc().nullsLast()),
]);

export const calendarSubscriptions = pgTable("calendar_subscriptions", {
	calendarId: text("calendar_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	expiration: timestamp({ withTimezone: true, mode: 'date' }),
	id: text().primaryKey().notNull(),
	lastOutboundPushAt: timestamp("last_outbound_push_at", { withTimezone: true, mode: 'date' }),
	lawFirmId: uuid("law_firm_id"),
	provider: text().notNull(),
	resource: text(),
	secret: text(),
	userId: text("user_id"),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "calendar_subscriptions_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "calendar_subscriptions_user_id_fkey"
		}).onDelete("restrict"),
	index("calendar_subscriptions_expiration_idx").using("btree", table.provider.asc().nullsLast(), table.expiration.asc().nullsLast()),
	index("calendar_subscriptions_firm_idx").using("btree", table.lawFirmId.asc().nullsLast()),
	check("calendar_subscriptions_provider_check", sql`provider = ANY (ARRAY['google'::text, 'outlook'::text])`),
	index("calendar_subscriptions_user_idx").using("btree", table.provider.asc().nullsLast(), table.userId.asc().nullsLast()),
]);

export const calendarSyncFailures = pgTable("calendar_sync_failures", {
	attempts: integer().default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	dedupeKey: text("dedupe_key").notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'date' }),
	id: uuid().defaultRandom().primaryKey().notNull(),
	kind: text().notNull(),
	lastError: text("last_error"),
	lawFirmId: uuid("law_firm_id"),
	nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	payload: jsonb().default({}).notNull(),
	provider: text(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	userId: text("user_id"),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "calendar_sync_failures_user_id_fkey"
		}).onDelete("restrict"),
	index("calendar_sync_failures_due_idx").using("btree", table.kind.asc().nullsLast(), table.nextAttemptAt.asc().nullsLast()),
	index("calendar_sync_failures_firm_idx").using("btree", table.lawFirmId.asc().nullsLast()).where(sql`(law_firm_id IS NOT NULL)`),
	check("calendar_sync_failures_kind_check", sql`kind = ANY (ARRAY['webhook'::text, 'stop_channel'::text, 'outbound'::text])`),
	unique("calendar_sync_failures_kind_dedupe_key_key").on(table.kind, table.dedupeKey),
	check("calendar_sync_failures_provider_check", sql`(provider IS NULL) OR (provider = ANY (ARRAY['google'::text, 'outlook'::text]))`),
]);

export const clientCompanyLinks = pgTable("client_company_links", {
	canViewBilling: boolean("can_view_billing").default(false).notNull(),
	companyClientId: uuid("company_client_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	isEmailRecipient: boolean("is_email_recipient").default(false).notNull(),
	isPrimary: boolean("is_primary").default(false).notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	personClientId: uuid("person_client_id").notNull(),
	relationship: text(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "client_company_links_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId, table.companyClientId],
			foreignColumns: [clients.id, clients.lawFirmId],
			name: "client_company_links_law_firm_id_company_client_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.personClientId],
			foreignColumns: [clients.id, clients.lawFirmId],
			name: "client_company_links_law_firm_id_person_client_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "client_company_links_law_firm_id_fkey"
		}).onDelete("cascade"),
	uniqueIndex("client_company_links_one_primary_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.companyClientId.asc().nullsLast()).where(sql`is_primary`),
	index("client_company_links_company_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.companyClientId.asc().nullsLast()),
	index("client_company_links_email_recipient_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.companyClientId.asc().nullsLast()).where(sql`is_email_recipient`),
	unique("client_company_links_law_firm_id_id_key").on(table.id, table.lawFirmId),
	check("client_company_links_not_self", sql`person_client_id <> company_client_id`),
	unique("client_company_links_unique").on(table.lawFirmId, table.personClientId, table.companyClientId),
]);

export const clientIdentityVerifications = pgTable("client_identity_verifications", {
	checks: jsonb().default({}).notNull(),
	clientId: uuid("client_id").notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'date' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	credentialExpiresOn: date("credential_expires_on"),
	docType: text("doc_type"),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'date' }).default(sql`(now() + '00:10:00'::interval)`).notNull(),
	failureReason: text("failure_reason"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	isNameMatch: boolean("is_name_match"),
	issuer: text(),
	lawFirmId: uuid("law_firm_id").notNull(),
	method: text().notNull(),
	providerSessionId: text("provider_session_id").notNull(),
	status: text().default('pending').notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	userId: text("user_id").notNull(),
	verifiedFamilyName: text("verified_family_name"),
	verifiedGivenName: text("verified_given_name"),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId, table.clientId],
			foreignColumns: [clients.id, clients.lawFirmId],
			name: "client_identity_verifications_client_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "client_identity_verifications_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "client_identity_verifications_user_id_fkey"
		}).onDelete("restrict"),
	index("client_identity_verifications_client_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.clientId.asc().nullsLast(), table.createdAt.desc().nullsFirst()),
	check("client_identity_verifications_completed_check", sql`(status = 'pending'::text) OR (completed_at IS NOT NULL)`),
	unique("client_identity_verifications_law_firm_id_id_key").on(table.id, table.lawFirmId),
	check("client_identity_verifications_method_check", sql`method = ANY (ARRAY['mdoc_dcapi'::text, 'openid4vp_dcapi'::text, 'w3c_openid4vp'::text])`),
	unique("client_identity_verifications_provider_session_key").on(table.providerSessionId),
	check("client_identity_verifications_status_check", sql`status = ANY (ARRAY['pending'::text, 'verified'::text, 'failed'::text, 'cancelled'::text, 'expired'::text])`),
	index("client_identity_verifications_user_idx").using("btree", table.userId.asc().nullsLast()),
]);

export const clients = pgTable("clients", {
	userId: text("user_id"),
	// TODO: failed to parse database type 'citext'
	address: text(),
	billingRates: jsonb("billing_rates").default({}).notNull(),
	clientType: text("client_type").default('person').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	email: citext("email"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	invitationFailed: boolean("invitation_failed").default(false).notNull(),
	invitationResendCount: integer("invitation_resend_count").default(0).notNull(),
	invitationSentAt: timestamp("invitation_sent_at", { withTimezone: true, mode: 'date' }),
	invitedAt: timestamp("invited_at", { withTimezone: true, mode: 'date' }),
	invitedBy: text("invited_by"),
	joinedAt: timestamp("joined_at", { withTimezone: true, mode: 'date' }),
	lastResendAt: timestamp("last_resend_at", { withTimezone: true, mode: 'date' }),
	lawFirmId: uuid("law_firm_id").notNull(),
	name: text().notNull(),
	organization: text(),
	phone: text(),
	portalInvitePending: boolean("portal_invite_pending").default(false).notNull(),
	preferredContactMethod: text("preferred_contact_method"),
	settings: jsonb().default({}).notNull(),
	status: text().default('active').notNull(),
	stripeCustomerId: text("stripe_customer_id"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.invitedBy],
			foreignColumns: [users.id],
			name: "clients_invited_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "clients_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "clients_user_id_fkey"
		}).onDelete("set null"),
	check("clients_client_type_check", sql`client_type = ANY (ARRAY['person'::text, 'company'::text])`),
	check("clients_company_no_user_id_check", sql`(client_type <> 'company'::text) OR (user_id IS NULL)`),
	index("clients_created_at_idx").using("btree", table.createdAt.desc().nullsFirst()),
	index("clients_email_idx").using("btree", table.email.asc().nullsLast()),
	index("clients_email_trgm_idx").using("gin", sql`((email)::text)`),
	index("clients_firm_email_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.email.asc().nullsLast()).where(sql`(email IS NOT NULL)`),
	index("clients_firm_lower_email_idx").using("btree", sql`law_firm_id`, sql`lower((email)::text)`).where(sql`(email IS NOT NULL)`),
	index("clients_firm_lower_name_idx").using("btree", sql`law_firm_id`, sql`lower(name)`),
	index("clients_firm_lower_org_idx").using("btree", sql`law_firm_id`, sql`lower(organization)`).where(sql`(organization IS NOT NULL)`),
	index("clients_firm_name_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.name.asc().nullsLast()),
	index("clients_firm_type_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.clientType.asc().nullsLast()),
	index("clients_firm_user_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.userId.asc().nullsLast()).where(sql`(user_id IS NOT NULL)`),
	unique("clients_law_firm_id_id_key").on(table.id, table.lawFirmId),
	index("clients_name_trgm_idx").using("gin", table.name.asc().nullsLast()),
	index("clients_org_trgm_idx").using("gin", table.organization.asc().nullsLast()),
	check("clients_status_check", sql`status = ANY (ARRAY['active'::text, 'inactive'::text, 'archived'::text])`),
	index("clients_user_id_idx").using("btree", table.userId.asc().nullsLast()),
]);

export const conflictCheckRecords = pgTable("conflict_check_records", {
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	matterId: uuid("matter_id"),
	performedBy: text("performed_by"),
	queryEmail: text("query_email"),
	queryName: text("query_name"),
	queryOrganization: text("query_organization"),
	resultCount: integer("result_count").default(0).notNull(),
	results: jsonb().default([]).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "conflict_check_records_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.performedBy],
			foreignColumns: [users.id],
			name: "conflict_check_records_performed_by_fkey"
		}).onDelete("restrict"),
	index("conflict_check_firm_time_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.createdAt.desc().nullsFirst()),
]);

export const contactClients = pgTable("contact_clients", {
	canViewBilling: boolean("can_view_billing").default(false).notNull(),
	clientId: uuid("client_id").notNull(),
	contactId: uuid("contact_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	isEmailRecipient: boolean("is_email_recipient").default(false).notNull(),
	isPrimary: boolean("is_primary").default(false).notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	relationship: text(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "contact_clients_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId, table.clientId],
			foreignColumns: [clients.id, clients.lawFirmId],
			name: "contact_clients_law_firm_id_client_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.contactId],
			foreignColumns: [contacts.id, contacts.lawFirmId],
			name: "contact_clients_law_firm_id_contact_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "contact_clients_law_firm_id_fkey"
		}).onDelete("cascade"),
	uniqueIndex("contact_clients_one_primary_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.clientId.asc().nullsLast()).where(sql`is_primary`),
	index("contact_clients_client_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.clientId.asc().nullsLast()),
	index("contact_clients_email_recipient_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.clientId.asc().nullsLast()).where(sql`is_email_recipient`),
	unique("contact_clients_law_firm_id_id_key").on(table.id, table.lawFirmId),
	unique("contact_clients_unique_link").on(table.lawFirmId, table.contactId, table.clientId),
]);

export const contacts = pgTable("contacts", {
	barNumber: text("bar_number"),
	// TODO: failed to parse database type 'citext'
	address: text(),
	category: text().default('other').notNull(),
	contactType: text("contact_type").default('person').notNull(),
	courtId: uuid("court_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	email: citext("email"),
	fax: text(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	isArchived: boolean("is_archived").default(false).notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	name: text().notNull(),
	notes: text(),
	oneTime: boolean("one_time").default(false).notNull(),
	organization: text(),
	phone: text(),
	phoneAlt: text("phone_alt"),
	tags: text().array().default([""]).notNull(),
	title: text(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	website: text(),
}, (table) => [
	foreignKey({
			columns: [table.courtId],
			foreignColumns: [courts.id],
			name: "contacts_court_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "contacts_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "contacts_law_firm_id_fkey"
		}).onDelete("cascade"),
	check("contacts_category_check", sql`category = ANY (ARRAY['opposing_counsel'::text, 'opposing_party'::text, 'co_counsel'::text, 'judge'::text, 'witness'::text, 'expert'::text, 'adjuster'::text, 'court_clerk'::text, 'mediator'::text, 'guardian_ad_litem'::text, 'court_reporter'::text, 'vendor'::text, 'other'::text])`),
	check("contacts_contact_type_check", sql`contact_type = ANY (ARRAY['person'::text, 'company'::text])`),
	index("contacts_email_trgm_idx").using("gin", sql`((email)::text)`),
	index("contacts_firm_category_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.category.asc().nullsLast()),
	index("contacts_firm_court_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.courtId.asc().nullsLast()).where(sql`(court_id IS NOT NULL)`),
	index("contacts_firm_lower_email_idx").using("btree", sql`law_firm_id`, sql`lower((email)::text)`).where(sql`(email IS NOT NULL)`),
	index("contacts_firm_lower_name_idx").using("btree", sql`law_firm_id`, sql`lower(name)`),
	index("contacts_firm_lower_org_idx").using("btree", sql`law_firm_id`, sql`lower(organization)`).where(sql`(organization IS NOT NULL)`),
	index("contacts_firm_name_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.name.asc().nullsLast()),
	unique("contacts_law_firm_id_id_key").on(table.id, table.lawFirmId),
	index("contacts_name_trgm_idx").using("gin", table.name.asc().nullsLast()),
	index("contacts_org_trgm_idx").using("gin", table.organization.asc().nullsLast()),
	index("contacts_phone_trgm_idx").using("gin", table.phone.asc().nullsLast()),
	index("contacts_title_trgm_idx").using("gin", table.title.asc().nullsLast()),
]);

export const conversationMatters = pgTable("conversation_matters", {
	conversationId: uuid("conversation_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	matterId: uuid("matter_id").notNull(),
	position: integer().default(0).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversations.id],
			name: "conversation_matters_conversation_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.matterId],
			foreignColumns: [matters.id, matters.lawFirmId],
			name: "conversation_matters_law_firm_id_matter_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "conversation_matters_law_firm_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.conversationId, table.matterId], name: "conversation_matters_pkey"}),
	index("conversation_matters_matter_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.matterId.asc().nullsLast()),
]);

export const conversationParticipants = pgTable("conversation_participants", {
	addedAt: timestamp("added_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	addedBy: text("added_by"),
	clientId: uuid("client_id"),
	conversationId: uuid("conversation_id").notNull(),
	historyVisibleFrom: timestamp("history_visible_from", { withTimezone: true, mode: 'date' }),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lastReadAt: timestamp("last_read_at", { withTimezone: true, mode: 'date' }),
	lawFirmId: uuid("law_firm_id").notNull(),
	participantType: text("participant_type").notNull(),
	participantUserId: text("participant_user_id"),
	removedAt: timestamp("removed_at", { withTimezone: true, mode: 'date' }),
}, (table) => [
	foreignKey({
			columns: [table.addedBy],
			foreignColumns: [users.id],
			name: "conversation_participants_added_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.clientId, table.lawFirmId],
			foreignColumns: [clients.id, clients.lawFirmId],
			name: "conversation_participants_law_firm_id_client_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.clientId],
			foreignColumns: [clients.id],
			name: "conversation_participants_client_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.conversationId, table.lawFirmId],
			foreignColumns: [conversations.id, conversations.lawFirmId],
			name: "conversation_participants_law_firm_id_conversation_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversations.id],
			name: "conversation_participants_conversation_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "conversation_participants_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.participantUserId],
			foreignColumns: [users.id],
			name: "conversation_participants_participant_user_id_fkey"
		}).onDelete("restrict"),
	pgPolicy("conversation_participants_select", { as: "permissive", for: "select", to: ["public"], using: sql`(messaging_can_access_conversation(conversation_id, (auth.jwt() ->> 'sub'::text)) AND ((participant_user_id = (auth.jwt() ->> 'sub'::text)) OR rls_is_firm_member(law_firm_id, (auth.jwt() ->> 'sub'::text))))` }),
	uniqueIndex("conv_participants_conv_client_idx").using("btree", table.conversationId.asc().nullsLast(), table.clientId.asc().nullsLast()),
	uniqueIndex("conv_participants_conv_user_idx").using("btree", table.conversationId.asc().nullsLast(), table.participantUserId.asc().nullsLast()),
	index("conv_participants_client_idx").using("btree", table.clientId.asc().nullsLast()).where(sql`(client_id IS NOT NULL)`),
	index("conv_participants_conv_idx").using("btree", table.conversationId.asc().nullsLast()).where(sql`(removed_at IS NULL)`),
	index("conv_participants_firm_client_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.clientId.asc().nullsLast()).where(sql`(client_id IS NOT NULL)`),
	index("conv_participants_firm_conv_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.conversationId.asc().nullsLast()),
	index("conv_participants_user_idx").using("btree", table.participantUserId.asc().nullsLast()).where(sql`(removed_at IS NULL)`),
	check("conversation_participants_actor_ck", sql`(participant_user_id IS NOT NULL) OR (client_id IS NOT NULL)`),
	unique("conversation_participants_law_firm_id_id_key").on(table.id, table.lawFirmId),
	check("conversation_participants_participant_type_check", sql`participant_type = ANY (ARRAY['client'::text, 'firm_member'::text])`),
]);

export const conversations = pgTable("conversations", {
	archivedAt: timestamp("archived_at", { withTimezone: true, mode: 'date' }),
	archivedBy: text("archived_by"),
	clientId: text("client_id"),
	clientRecordId: uuid("client_record_id"),
	conversationType: text("conversation_type").default('direct').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	hideClientNames: boolean("hide_client_names").default(false).notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lastMessageAt: timestamp("last_message_at", { withTimezone: true, mode: 'date' }),
	lastNotificationEmailAt: timestamp("last_notification_email_at", { withTimezone: true, mode: 'date' }),
	lastSenderUserId: text("last_sender_user_id"),
	lawFirmId: uuid("law_firm_id"),
	matterId: uuid("matter_id"),
	title: text(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.archivedBy],
			foreignColumns: [users.id],
			name: "conversations_archived_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.clientId],
			foreignColumns: [users.id],
			name: "conversations_client_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "conversations_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lastSenderUserId],
			foreignColumns: [users.id],
			name: "conversations_last_sender_user_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId, table.clientRecordId],
			foreignColumns: [clients.id, clients.lawFirmId],
			name: "conversations_law_firm_id_client_record_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "conversations_law_firm_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("conversations_realtime_select", { as: "permissive", for: "select", to: ["public"], using: sql`
CASE
    WHEN (conversation_type = 'group'::text) THEN rls_is_conversation_participant(id, (auth.jwt() ->> 'sub'::text))
    ELSE (((auth.jwt() ->> 'sub'::text) = client_id) OR rls_is_firm_member(law_firm_id, (auth.jwt() ->> 'sub'::text)))
END` }),
	uniqueIndex("conversations_client_record_active_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.clientRecordId.asc().nullsLast()).where(sql`((client_record_id IS NOT NULL) AND (archived_at IS NULL))`),
	index("conversations_archived_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.archivedAt.asc().nullsLast()),
	index("conversations_client_idx").using("btree", table.clientId.asc().nullsLast(), table.lastMessageAt.desc().nullsFirst()),
	check("conversations_conversation_type_check", sql`conversation_type = ANY (ARRAY['direct'::text, 'group'::text])`),
	index("conversations_firm_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.lastMessageAt.desc().nullsFirst()),
	unique("conversations_law_firm_id_client_id_key").on(table.lawFirmId, table.clientId),
	unique("conversations_law_firm_id_id_key").on(table.id, table.lawFirmId),
]);

export const courtCatalog = pgTable("court_catalog", {
	inUse: boolean("in_use").default(true).notNull(),
	// TODO: failed to parse database type 'tsvector'
	citationAbbrev: text("citation_abbrev"),
	courtType: text("court_type"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	fullName: text("full_name").notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	jurisdiction: text(),
	search: tsvector("search").generatedAlwaysAs(sql`to_tsvector('english'::regconfig, ((((((COALESCE(full_name, ''::text) || ' '::text) || COALESCE(short_name, ''::text)) || ' '::text) || COALESCE(citation_abbrev, ''::text)) || ' '::text) || COALESCE(state, ''::text)))`),
	shortName: text("short_name"),
	source: text().default('courtlistener').notNull(),
	sourceId: text("source_id"),
	state: text(),
	url: text(),
}, (table) => [
	index("court_catalog_search_gin").using("gin", table.search.asc().nullsLast()),
	unique("court_catalog_source_source_id_key").on(table.source, table.sourceId),
	index("court_catalog_state_idx").using("btree", table.state.asc().nullsLast(), table.courtType.asc().nullsLast()),
]);

export const courts = pgTable("courts", {
	abbreviation: text(),
	address: text(),
	catalogCourtId: uuid("catalog_court_id"),
	city: text(),
	courtType: text("court_type"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	name: text().notNull(),
	sortOrder: integer("sort_order"),
	state: text(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.catalogCourtId],
			foreignColumns: [courtCatalog.id],
			name: "courts_catalog_court_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "courts_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "courts_law_firm_id_fkey"
		}).onDelete("cascade"),
	index("courts_catalog_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.catalogCourtId.asc().nullsLast()).where(sql`(catalog_court_id IS NOT NULL)`),
	unique("courts_law_firm_id_id_key").on(table.id, table.lawFirmId),
]);

export const cronPassState = pgTable("cron_pass_state", {
	lastFirmId: uuid("last_firm_id"),
	passName: text("pass_name").primaryKey().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
});

export const deadlineSetTemplates = pgTable("deadline_set_templates", {
	adjustForWeekends: boolean("adjust_for_weekends").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	description: text(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	items: jsonb().default([]).notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	name: text().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "deadline_set_templates_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "deadline_set_templates_law_firm_id_fkey"
		}).onDelete("cascade"),
	unique("deadline_set_templates_law_firm_id_id_key").on(table.id, table.lawFirmId),
]);

export const digestSends = pgTable("digest_sends", {
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	itemCount: integer("item_count").default(0).notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	sentOn: date("sent_on").notNull(),
	userId: text("user_id").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "digest_sends_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "digest_sends_user_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.lawFirmId, table.userId, table.sentOn], name: "digest_sends_pkey"}),
	index("digest_sends_sent_on_idx").using("btree", table.sentOn.asc().nullsLast()),
	index("digest_sends_user_id_idx").using("btree", table.userId.asc().nullsLast()),
]);

export const documentRequestItems = pgTable("document_request_items", {
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	description: text(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	label: text().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	requestId: uuid("request_id").notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
	status: text().default('pending').notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "document_request_items_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.requestId],
			foreignColumns: [documentRequests.id],
			name: "document_request_items_request_id_fkey"
		}).onDelete("cascade"),
	unique("document_request_items_law_firm_id_id_key").on(table.id, table.lawFirmId),
	index("document_request_items_request_idx").using("btree", table.requestId.asc().nullsLast(), table.sortOrder.asc().nullsLast()),
	check("document_request_items_status_check", sql`status = ANY (ARRAY['pending'::text, 'received'::text, 'waived'::text])`),
]);

export const documentRequests = pgTable("document_requests", {
	clientId: uuid("client_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	dueDate: date("due_date"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	matterId: uuid("matter_id"),
	note: text(),
	status: text().default('open').notNull(),
	title: text().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "document_requests_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId, table.clientId],
			foreignColumns: [clients.id, clients.lawFirmId],
			name: "document_requests_law_firm_id_client_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.matterId],
			foreignColumns: [matters.id, matters.lawFirmId],
			name: "document_requests_law_firm_id_matter_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "document_requests_law_firm_id_fkey"
		}).onDelete("cascade"),
	index("document_requests_firm_client_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.clientId.asc().nullsLast()),
	index("document_requests_firm_matter_created_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.matterId.asc().nullsLast(), table.createdAt.desc().nullsFirst(), table.id.desc().nullsFirst()),
	unique("document_requests_law_firm_id_id_key").on(table.id, table.lawFirmId),
	check("document_requests_status_check", sql`status = ANY (ARRAY['open'::text, 'completed'::text, 'cancelled'::text])`),
]);

export const documentRequestTemplates = pgTable("document_request_templates", {
	archived: boolean().default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	defaultNote: text("default_note"),
	defaultTitle: text("default_title").notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	items: jsonb().default([]).notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	name: text().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "document_request_templates_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "document_request_templates_law_firm_id_fkey"
		}).onDelete("cascade"),
	index("document_request_templates_firm_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.archived.asc().nullsLast(), table.name.asc().nullsLast()),
	unique("document_request_templates_law_firm_id_id_key").on(table.id, table.lawFirmId),
]);

export const documentRequestUploads = pgTable("document_request_uploads", {
	actionKey: uuid("action_key").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by").notNull(),
	fileId: uuid("file_id").notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	itemId: uuid("item_id").notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	position: integer().notNull(),
	requestHash: text("request_hash").notNull(),
	reservationId: uuid("reservation_id"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	uploadUrl: text("upload_url").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "document_request_uploads_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId, table.fileId],
			foreignColumns: [files.id, files.lawFirmId],
			name: "document_request_uploads_law_firm_id_file_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.itemId],
			foreignColumns: [documentRequestItems.id, documentRequestItems.lawFirmId],
			name: "document_request_uploads_law_firm_id_item_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.reservationId],
			foreignColumns: [storageReservations.id, storageReservations.lawFirmId],
			name: "document_request_uploads_law_firm_id_reservation_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "document_request_uploads_law_firm_id_fkey"
		}).onDelete("cascade"),
	index("document_request_uploads_creator_idx").using("btree", table.createdBy.asc().nullsLast()),
	index("document_request_uploads_file_idx").using("btree", table.fileId.asc().nullsLast()),
	index("document_request_uploads_firm_file_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.fileId.asc().nullsLast()),
	index("document_request_uploads_firm_reservation_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.reservationId.asc().nullsLast()),
	index("document_request_uploads_item_idx").using("btree", table.itemId.asc().nullsLast()),
	unique("document_request_uploads_law_firm_id_id_key").on(table.id, table.lawFirmId),
	unique("document_request_uploads_law_firm_id_item_id_created_by_act_key").on(table.lawFirmId, table.itemId, table.createdBy, table.actionKey, table.position),
	check("document_request_uploads_position_check", sql`"position" >= 0`),
	index("document_request_uploads_reservation_idx").using("btree", table.reservationId.asc().nullsLast()),
]);

export const emailVerificationWhitelist = pgTable("email_verification_whitelist", {
	// TODO: failed to parse database type 'citext'
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	email: citext("email").primaryKey().notNull(),
	note: text(),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "email_verification_whitelist_created_by_fkey"
		}).onDelete("set null"),
	index("email_verification_whitelist_created_by_idx").using("btree", table.createdBy.asc().nullsLast()),
]);

export const eventAssignees = pgTable("event_assignees", {
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	eventId: uuid("event_id").notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	userId: text("user_id").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId, table.eventId],
			foreignColumns: [events.id, events.lawFirmId],
			name: "event_assignees_law_firm_id_event_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "event_assignees_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "event_assignees_user_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.eventId, table.userId], name: "event_assignees_pkey"}),
	index("event_assignees_firm_event_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.eventId.asc().nullsLast()),
	index("event_assignees_firm_user_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.userId.asc().nullsLast()),
	index("event_assignees_user_id_idx").using("btree", table.userId.asc().nullsLast()),
]);

export const eventContacts = pgTable("event_contacts", {
	contactId: uuid("contact_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	eventId: uuid("event_id").notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.eventId],
			foreignColumns: [events.id],
			name: "event_contacts_event_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.contactId],
			foreignColumns: [contacts.id, contacts.lawFirmId],
			name: "event_contacts_law_firm_id_contact_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "event_contacts_law_firm_id_fkey"
		}).onDelete("cascade"),
	index("event_contacts_contact_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.contactId.asc().nullsLast()),
	unique("event_contacts_law_firm_id_id_key").on(table.id, table.lawFirmId),
	unique("event_contacts_unique_link").on(table.lawFirmId, table.eventId, table.contactId),
]);

export const eventOutbox = pgTable("event_outbox", {
	attempts: integer().default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	eventType: text("event_type").notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lastError: text("last_error"),
	lawFirmId: uuid("law_firm_id"),
	payload: jsonb().notNull(),
	processedAt: timestamp("processed_at", { withTimezone: true, mode: 'date' }),
	status: text().default('pending').notNull(),
}, (table) => [
	index("event_outbox_law_firm_idx").using("btree", table.lawFirmId.asc().nullsLast()),
	check("event_outbox_status_check", sql`status = ANY (ARRAY['pending'::text, 'processing'::text, 'done'::text, 'failed'::text])`),
	index("event_outbox_status_created_idx").using("btree", table.status.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	index("event_outbox_status_processed_idx").using("btree", table.status.asc().nullsLast(), table.processedAt.asc().nullsLast()),
]);

export const events = pgTable("events", {
	allDay: boolean("all_day").default(false).notNull(),
	calendarSync: jsonb("calendar_sync").default({}).notNull(),
	cancellationReason: text("cancellation_reason"),
	cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: 'date' }),
	cancelledBy: text("cancelled_by"),
	clientDescription: text("client_description"),
	clientId: uuid("client_id"),
	clientVisible: boolean("client_visible").default(false).notNull(),
	courtId: uuid("court_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	date: timestamp({ withTimezone: true, mode: 'date' }),
	dependsOn: jsonb("depends_on").default([]).notNull(),
	endsAt: timestamp("ends_at", { withTimezone: true, mode: 'date' }),
	googleCalendarId: text("google_calendar_id"),
	googleEventId: text("google_event_id"),
	googleLastModified: timestamp("google_last_modified", { withTimezone: true, mode: 'date' }),
	id: uuid().defaultRandom().primaryKey().notNull(),
	isRecurrenceParent: boolean("is_recurrence_parent").default(false).notNull(),
	lastSyncedToGoogle: timestamp("last_synced_to_google", { withTimezone: true, mode: 'date' }),
	lastSyncedToOutlook: timestamp("last_synced_to_outlook", { withTimezone: true, mode: 'date' }),
	lawFirmId: uuid("law_firm_id").notNull(),
	linkedFiles: jsonb("linked_files").default([]).notNull(),
	location: text(),
	locationName: text("location_name"),
	matterId: uuid("matter_id"),
	notes: text(),
	outlookChangeKey: text("outlook_change_key"),
	outlookId: text("outlook_id"),
	outlookLastModified: timestamp("outlook_last_modified", { withTimezone: true, mode: 'date' }),
	postponementCount: integer("postponement_count").default(0).notNull(),
	postponementHistory: jsonb("postponement_history").default([]).notNull(),
	recurrence: jsonb(),
	recurrenceGroupId: text("recurrence_group_id"),
	recurrenceIndex: integer("recurrence_index"),
	status: text().default('upcoming').notNull(),
	timeZone: text("time_zone"),
	title: text().notNull(),
	type: text(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.cancelledBy],
			foreignColumns: [users.id],
			name: "events_cancelled_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.clientId],
			foreignColumns: [clients.id],
			name: "events_client_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.courtId],
			foreignColumns: [courts.id],
			name: "events_court_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "events_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "events_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.matterId],
			foreignColumns: [matters.id],
			name: "events_matter_id_fkey"
		}).onDelete("cascade"),
	index("events_client_id_idx").using("btree", table.clientId.asc().nullsLast()),
	index("events_client_visible_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.matterId.asc().nullsLast(), table.date.asc().nullsLast()).where(sql`(client_visible AND (status <> 'cancelled'::text))`),
	index("events_court_idx").using("btree", table.courtId.asc().nullsLast()).where(sql`(court_id IS NOT NULL)`),
	check("events_ends_after_start", sql`(ends_at IS NULL) OR (date IS NULL) OR (ends_at > date)`),
	index("events_firm_client_date_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.clientId.asc().nullsLast(), table.date.asc().nullsLast()).where(sql`(client_id IS NOT NULL)`),
	index("events_firm_date_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.date.asc().nullsLast()),
	index("events_firm_matter_date_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.matterId.asc().nullsLast(), table.date.asc().nullsLast()).where(sql`(matter_id IS NOT NULL)`),
	index("events_firm_status_date_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.status.asc().nullsLast(), table.date.asc().nullsLast()),
	index("events_google_idx").using("btree", table.googleEventId.asc().nullsLast()).where(sql`(google_event_id IS NOT NULL)`),
	unique("events_law_firm_id_id_key").on(table.id, table.lawFirmId),
	index("events_matter_fk_idx").using("btree", table.matterId.asc().nullsLast()).where(sql`(matter_id IS NOT NULL)`),
	index("events_outlook_idx").using("btree", table.outlookId.asc().nullsLast()).where(sql`(outlook_id IS NOT NULL)`),
	check("events_parent_ck", sql`((matter_id IS NOT NULL) AND (client_id IS NULL)) OR ((client_id IS NOT NULL) AND (matter_id IS NULL))`),
	index("events_recur_idx").using("btree", table.recurrenceGroupId.asc().nullsLast()).where(sql`(recurrence_group_id IS NOT NULL)`),
	check("events_status_check", sql`status = ANY (ARRAY['upcoming'::text, 'completed'::text, 'cancelled'::text])`),
	check("events_type_check", sql`(type IS NULL) OR (type = ANY (ARRAY['court_date'::text, 'hearing'::text, 'deposition'::text, 'filing_deadline'::text, 'discovery_cutoff'::text, 'mediation'::text, 'arbitration'::text, 'trial'::text, 'appeal_deadline'::text, 'statute_of_limitations'::text, 'meeting'::text, 'other'::text]))`),
]);

export const fileClientAccess = pgTable("file_client_access", {
	clientUserId: text("client_user_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	fileId: uuid("file_id").notNull(),
	firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: 'date' }),
	id: uuid().defaultRandom().primaryKey().notNull(),
	isEmailEnabled: boolean("is_email_enabled").default(true).notNull(),
	isFolder: boolean("is_folder").default(false).notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	notifiedAt: timestamp("notified_at", { withTimezone: true, mode: 'date' }),
	sharedAt: timestamp("shared_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	sharedBy: text("shared_by"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.clientUserId],
			foreignColumns: [users.id],
			name: "file_client_access_client_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.fileId],
			foreignColumns: [files.id],
			name: "file_client_access_file_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.fileId],
			foreignColumns: [files.id, files.lawFirmId],
			name: "file_client_access_law_firm_id_file_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "file_client_access_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.sharedBy],
			foreignColumns: [users.id],
			name: "file_client_access_shared_by_fkey"
		}).onDelete("restrict"),
	uniqueIndex("file_client_access_firm_user_file_uq").using("btree", table.lawFirmId.asc().nullsLast(), table.clientUserId.asc().nullsLast(), table.fileId.asc().nullsLast()),
	index("file_client_access_client_user_id_idx").using("btree", table.clientUserId.asc().nullsLast()),
	index("file_client_access_file_id_idx").using("btree", table.fileId.asc().nullsLast()).where(sql`(file_id IS NOT NULL)`),
	index("file_client_access_firm_file_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.fileId.asc().nullsLast()).where(sql`(file_id IS NOT NULL)`),
	unique("file_client_access_law_firm_id_id_key").on(table.id, table.lawFirmId),
	index("file_client_access_pending_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.clientUserId.asc().nullsLast()).where(sql`(notified_at IS NULL)`),
	index("file_client_access_shared_by_idx").using("btree", table.sharedBy.asc().nullsLast()).where(sql`(shared_by IS NOT NULL)`),
]);

export const fileClientVisibility = pgTable("file_client_visibility", {
	clientId: uuid("client_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	fileId: uuid("file_id").notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId, table.clientId],
			foreignColumns: [clients.id, clients.lawFirmId],
			name: "file_client_visibility_law_firm_id_client_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.fileId],
			foreignColumns: [files.id, files.lawFirmId],
			name: "file_client_visibility_law_firm_id_file_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "file_client_visibility_law_firm_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.lawFirmId, table.fileId, table.clientId], name: "file_client_visibility_pkey"}),
	index("file_client_visibility_client_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.clientId.asc().nullsLast()),
]);

export const fileExportJobs = pgTable("file_export_jobs", {
	entryCount: integer("entry_count"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	attempt: integer().default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'date' }).default(sql`(now() + '24:00:00'::interval)`).notNull(),
	failureCode: text("failure_code"),
	failureDetail: text("failure_detail"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: 'date' }),
	leaseOwner: text("lease_owner"),
	leaseToken: uuid("lease_token"),
	nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	objectGeneration: text("object_generation"),
	objectPath: text("object_path"),
	phase: text(),
	phaseState: jsonb("phase_state"),
	requestedBy: text("requested_by").notNull(),
	rootFileId: uuid("root_file_id").notNull(),
	selectionDigest: text("selection_digest").notNull(),
	sizeBytes: bigint("size_bytes", { mode: "number" }),
	status: text().default('queued').notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId, table.rootFileId],
			foreignColumns: [files.id, files.lawFirmId],
			name: "file_export_jobs_law_firm_id_root_file_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "file_export_jobs_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.requestedBy],
			foreignColumns: [users.id],
			name: "file_export_jobs_requested_by_fkey"
		}).onDelete("cascade"),
	uniqueIndex("file_export_jobs_live_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.requestedBy.asc().nullsLast(), table.rootFileId.asc().nullsLast(), table.selectionDigest.asc().nullsLast()).where(sql`(status = ANY (ARRAY['queued'::text, 'leased'::text]))`),
	index("file_export_jobs_expiry_idx").using("btree", table.expiresAt.asc().nullsLast()).where(sql`(object_path IS NOT NULL)`),
	index("file_export_jobs_firm_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.requestedBy.asc().nullsLast(), table.createdAt.desc().nullsFirst()),
	unique("file_export_jobs_law_firm_id_id_key").on(table.id, table.lawFirmId),
	index("file_export_jobs_lease_idx").using("btree", table.leaseExpiresAt.asc().nullsLast()).where(sql`(status = 'leased'::text)`),
	index("file_export_jobs_ready_idx").using("btree", table.nextAttemptAt.asc().nullsLast()).where(sql`(status = 'queued'::text)`),
	index("file_export_jobs_requested_by_idx").using("btree", table.requestedBy.asc().nullsLast()),
	index("file_export_jobs_root_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.rootFileId.asc().nullsLast()),
	check("file_export_jobs_size_bytes_check", sql`(size_bytes IS NULL) OR (size_bytes >= 0)`),
	check("file_export_jobs_status_check", sql`status = ANY (ARRAY['queued'::text, 'leased'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])`),
]);

export const fileExportJobSources = pgTable("file_export_job_sources", {
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	fileId: uuid("file_id").notNull(),
	jobId: uuid("job_id").notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId, table.fileId],
			foreignColumns: [files.id, files.lawFirmId],
			name: "file_export_job_sources_law_firm_id_file_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.jobId],
			foreignColumns: [fileExportJobs.id, fileExportJobs.lawFirmId],
			name: "file_export_job_sources_law_firm_id_job_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "file_export_job_sources_law_firm_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.lawFirmId, table.jobId, table.fileId], name: "file_export_job_sources_pkey"}),
	index("file_export_job_sources_file_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.fileId.asc().nullsLast()),
]);

export const files = pgTable("files", {
	mimeType: text("mime_type"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	clientId: uuid("client_id"),
	clientVisible: boolean("client_visible").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'date' }),
	deletedBy: text("deleted_by"),
	finalizedAt: timestamp("finalized_at", { withTimezone: true, mode: 'date' }),
	folderColor: text("folder_color"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	kind: text().default('file').notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	matterId: uuid("matter_id"),
	name: text().notNull(),
	objectPath: text("object_path"),
	parentId: uuid("parent_id"),
	scope: text().notNull(),
	signedViaSession: text("signed_via_session"),
	sizeBytes: bigint("size_bytes", { mode: "number" }),
	taskId: uuid("task_id"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	uploadedBy: text("uploaded_by"),
}, (table) => [
	foreignKey({
			columns: [table.deletedBy],
			foreignColumns: [users.id],
			name: "files_deleted_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId, table.clientId],
			foreignColumns: [clients.id, clients.lawFirmId],
			name: "files_law_firm_id_client_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.matterId],
			foreignColumns: [matters.id, matters.lawFirmId],
			name: "files_law_firm_id_matter_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.parentId],
			foreignColumns: [table.id, table.lawFirmId],
			name: "files_law_firm_id_parent_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.taskId],
			foreignColumns: [tasks.id, tasks.lawFirmId],
			name: "files_law_firm_id_task_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "files_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.uploadedBy],
			foreignColumns: [users.id],
			name: "files_uploaded_by_fkey"
		}).onDelete("restrict"),
	uniqueIndex("files_client_root_uidx").using("btree", table.lawFirmId.asc().nullsLast(), table.clientId.asc().nullsLast()).where(sql`((parent_id IS NULL) AND (scope = 'client'::text))`),
	uniqueIndex("files_firm_root_uidx").using("btree", table.lawFirmId.asc().nullsLast()).where(sql`((parent_id IS NULL) AND (scope = 'firm'::text))`),
	uniqueIndex("files_matter_root_uidx").using("btree", table.lawFirmId.asc().nullsLast(), table.matterId.asc().nullsLast()).where(sql`((parent_id IS NULL) AND (scope = 'matter'::text))`),
	uniqueIndex("files_object_path_uidx").using("btree", table.objectPath.asc().nullsLast()).where(sql`(object_path IS NOT NULL)`),
	uniqueIndex("files_sibling_name_uidx").using("btree", sql`law_firm_id`, sql`parent_id`, sql`lower(name)`).where(sql`((parent_id IS NOT NULL) AND (deleted_at IS NULL))`),
	uniqueIndex("files_signed_via_session_uidx").using("btree", table.lawFirmId.asc().nullsLast(), table.signedViaSession.asc().nullsLast()).where(sql`(signed_via_session IS NOT NULL)`),
	uniqueIndex("files_task_root_uidx").using("btree", table.lawFirmId.asc().nullsLast(), table.taskId.asc().nullsLast()).where(sql`((parent_id IS NULL) AND (scope = 'task'::text))`),
	index("files_deleted_by_idx").using("btree", table.deletedBy.asc().nullsLast()).where(sql`(deleted_by IS NOT NULL)`),
	index("files_deleted_idx").using("btree", table.deletedAt.asc().nullsLast()).where(sql`(deleted_at IS NOT NULL)`),
	check("files_file_has_object", sql`(kind = 'folder'::text) OR (object_path IS NOT NULL)`),
	index("files_firm_client_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.clientId.asc().nullsLast()),
	index("files_firm_matter_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.matterId.asc().nullsLast()),
	index("files_firm_task_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.taskId.asc().nullsLast()),
	check("files_folder_has_no_object", sql`(kind = 'file'::text) OR (object_path IS NULL)`),
	check("files_kind_check", sql`kind = ANY (ARRAY['file'::text, 'folder'::text])`),
	unique("files_law_firm_id_id_key").on(table.id, table.lawFirmId),
	check("files_name_length", sql`(char_length(name) <= 255) AND ((parent_id IS NULL) OR (char_length(name) >= 1))`),
	index("files_parent_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.parentId.asc().nullsLast()).where(sql`(deleted_at IS NULL)`),
	check("files_root_names_scope", sql`(parent_id IS NOT NULL) OR (((scope = 'matter'::text) AND (matter_id IS NOT NULL) AND (task_id IS NULL) AND (client_id IS NULL)) OR ((scope = 'task'::text) AND (task_id IS NOT NULL) AND (client_id IS NULL)) OR ((scope = 'client'::text) AND (client_id IS NOT NULL) AND (matter_id IS NULL) AND (task_id IS NULL)) OR ((scope = 'firm'::text) AND (matter_id IS NULL) AND (task_id IS NULL) AND (client_id IS NULL)))`),
	check("files_scope_check", sql`scope = ANY (ARRAY['matter'::text, 'task'::text, 'client'::text, 'firm'::text])`),
	check("files_size_bytes_check", sql`(size_bytes IS NULL) OR (size_bytes >= 0)`),
	index("files_unfinalized_idx").using("btree", table.createdAt.asc().nullsLast()).where(sql`((kind = 'file'::text) AND (finalized_at IS NULL))`),
]);

export const fileShareLinkItems = pgTable("file_share_link_items", {
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	fileId: uuid("file_id").notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	token: text().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId, table.fileId],
			foreignColumns: [files.id, files.lawFirmId],
			name: "file_share_link_items_law_firm_id_file_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.token],
			foreignColumns: [fileShareLinks.token, fileShareLinks.lawFirmId],
			name: "file_share_link_items_law_firm_id_token_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "file_share_link_items_law_firm_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.lawFirmId, table.token, table.fileId], name: "file_share_link_items_pkey"}),
	index("file_share_link_items_file_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.fileId.asc().nullsLast()),
]);

export const fileShareLinks = pgTable("file_share_links", {
	accessCount: integer("access_count").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	displayName: text("display_name").notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'date' }).notNull(),
	fileId: uuid("file_id"),
	lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true, mode: 'date' }),
	lawFirmId: uuid("law_firm_id").notNull(),
	mimeType: text("mime_type"),
	passwordHash: text("password_hash"),
	permission: text().default('download').notNull(),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'date' }),
	token: text().primaryKey().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "file_share_links_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.fileId],
			foreignColumns: [files.id],
			name: "file_share_links_file_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.lawFirmId, table.fileId],
			foreignColumns: [files.id, files.lawFirmId],
			name: "file_share_links_law_firm_id_file_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "file_share_links_law_firm_id_fkey"
		}).onDelete("cascade"),
	index("file_share_links_file_id_idx").using("btree", table.fileId.asc().nullsLast()).where(sql`(file_id IS NOT NULL)`),
	index("file_share_links_firm_file_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.fileId.asc().nullsLast()).where(sql`(file_id IS NOT NULL)`),
	unique("file_share_links_law_firm_id_token_key").on(table.token, table.lawFirmId),
	check("file_share_links_permission_check", sql`permission = ANY (ARRAY['view'::text, 'download'::text])`),
]);

export const firmCounters = pgTable("firm_counters", {
	counterType: text("counter_type").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lawFirmId: uuid("law_firm_id").notNull(),
	nextVal: bigint("next_val", { mode: "number" }).default(1).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "firm_counters_law_firm_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.lawFirmId, table.counterType], name: "firm_counters_pkey"}),
	check("firm_counters_counter_type_check", sql`counter_type = ANY (ARRAY['matter_reference'::text, 'invoice_number'::text])`),
]);

export const intakeFormTemplates = pgTable("intake_form_templates", {
	accessCodeHash: text("access_code_hash"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	fields: jsonb().default([]).notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	isActive: boolean("is_active").default(true).notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	name: text().notNull(),
	practiceAreaId: uuid("practice_area_id"),
	publicToken: text("public_token").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "intake_form_templates_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "intake_form_templates_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.practiceAreaId],
			foreignColumns: [practiceAreas.id],
			name: "intake_form_templates_practice_area_id_fkey"
		}).onDelete("set null"),
	unique("intake_form_templates_law_firm_id_id_key").on(table.id, table.lawFirmId),
	unique("intake_form_templates_public_token_key").on(table.publicToken),
]);

export const intakeSubmissions = pgTable("intake_submissions", {
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'date' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	deliveryStatus: text("delivery_status").default('sent').notNull(),
	fieldValues: jsonb("field_values").default({}).notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	intakeFormTemplateId: uuid("intake_form_template_id").notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	leadId: uuid("lead_id"),
	openedAt: timestamp("opened_at", { withTimezone: true, mode: 'date' }),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'date' }),
	sentBy: text("sent_by"),
	sentToEmail: text("sent_to_email"),
	status: text().default('sent').notNull(),
	submittedIp: text("submitted_ip"),
	token: text().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId, table.intakeFormTemplateId],
			foreignColumns: [intakeFormTemplates.id, intakeFormTemplates.lawFirmId],
			name: "intake_submissions_template_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "intake_submissions_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.leadId],
			foreignColumns: [leads.id],
			name: "intake_submissions_lead_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.sentBy],
			foreignColumns: [users.id],
			name: "intake_submissions_sent_by_fkey"
		}).onDelete("restrict"),
	check("intake_submissions_delivery_status_check", sql`delivery_status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text])`),
	unique("intake_submissions_law_firm_id_id_key").on(table.id, table.lawFirmId),
	index("intake_submissions_lead_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.leadId.asc().nullsLast()),
	check("intake_submissions_status_check", sql`status = ANY (ARRAY['sent'::text, 'completed'::text, 'rejected'::text])`),
	index("intake_submissions_template_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.intakeFormTemplateId.asc().nullsLast()),
	unique("intake_submissions_token_key").on(table.token),
]);

export const invitations = pgTable("invitations", {
	lawFirmId: uuid("law_firm_id").notNull(),
	// TODO: failed to parse database type 'citext'
	invitationSentAt: timestamp("invitation_sent_at", { withTimezone: true, mode: 'date' }),
	// TODO: failed to parse database type 'citext'
	acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: 'date' }),
	acceptedBy: text("accepted_by"),
	clientId: uuid("client_id"),
	contactClientId: uuid("contact_client_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	email: citext("email").notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'date' }).default(sql`(now() + '7 days'::interval)`).notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	invitationEmail: citext("invitation_email"),
	invitationFailed: boolean("invitation_failed").default(false).notNull(),
	invitationResendCount: integer("invitation_resend_count").default(0).notNull(),
	invitedAt: timestamp("invited_at", { withTimezone: true, mode: 'date' }),
	invitedBy: text("invited_by"),
	inviteType: text("invite_type").notNull(),
	matterIds: uuid("matter_ids").array(),
	roleId: uuid("role_id"),
	status: text().default('pending').notNull(),
	token: text().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.acceptedBy],
			foreignColumns: [users.id],
			name: "invitations_accepted_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.clientId],
			foreignColumns: [clients.id],
			name: "invitations_client_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.contactClientId],
			foreignColumns: [contactClients.id],
			name: "invitations_contact_client_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.invitedBy],
			foreignColumns: [users.id],
			name: "invitations_invited_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "invitations_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.roleId],
			foreignColumns: [roles.id],
			name: "invitations_role_fk"
		}).onDelete("set null"),
	uniqueIndex("invitations_company_roster_pending_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.contactClientId.asc().nullsLast()).where(sql`((invite_type = 'client'::text) AND (contact_client_id IS NOT NULL) AND (status = 'pending'::text))`),
	uniqueIndex("invitations_member_pending_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.email.asc().nullsLast()).where(sql`((invite_type = 'member'::text) AND (status = 'pending'::text))`),
	uniqueIndex("invitations_person_client_pending_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.clientId.asc().nullsLast()).where(sql`((invite_type = 'client'::text) AND (contact_client_id IS NULL) AND (status = 'pending'::text))`),
	index("invitations_client_id_idx").using("btree", table.clientId.asc().nullsLast()),
	index("invitations_client_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.clientId.asc().nullsLast()).where(sql`(client_id IS NOT NULL)`),
	index("invitations_contact_client_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.contactClientId.asc().nullsLast()).where(sql`(contact_client_id IS NOT NULL)`),
	index("invitations_email_type_pending_idx").using("btree", table.email.asc().nullsLast(), table.inviteType.asc().nullsLast()).where(sql`(status = 'pending'::text)`),
	check("invitations_invite_type_check", sql`invite_type = ANY (ARRAY['member'::text, 'client'::text])`),
	check("invitations_member_no_client_check", sql`(invite_type = 'client'::text) OR ((client_id IS NULL) AND (contact_client_id IS NULL))`),
	check("invitations_roster_requires_client_check", sql`(contact_client_id IS NULL) OR (client_id IS NOT NULL)`),
	check("invitations_status_check", sql`status = ANY (ARRAY['pending'::text, 'accepted'::text, 'revoked'::text, 'expired'::text])`),
	unique("invitations_token_key").on(table.token),
]);

export const invoiceAdjustments = pgTable("invoice_adjustments", {
	externalId: text("external_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	description: text(),
	direction: text().notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	invoiceId: uuid("invoice_id").notNull(),
	kind: text(),
	lawFirmId: uuid("law_firm_id").notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "invoice_adjustments_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId, table.invoiceId],
			foreignColumns: [invoices.id, invoices.lawFirmId],
			name: "invoice_adjustments_law_firm_id_invoice_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "invoice_adjustments_law_firm_id_fkey"
		}).onDelete("cascade"),
	check("invoice_adjustments_direction_check", sql`direction = ANY (ARRAY['credit'::text, 'charge'::text])`),
	index("invoice_adjustments_invoice_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.invoiceId.asc().nullsLast(), table.direction.asc().nullsLast(), table.sortOrder.asc().nullsLast()),
	check("invoice_adjustments_kind_check", sql`(kind IS NULL) OR (kind = ANY (ARRAY['write_off'::text, 'discount'::text, 'adjustment'::text, 'late_fee'::text]))`),
	check("invoice_adjustments_kind_matches_direction", sql`((direction = 'credit'::text) AND ((kind IS NULL) OR (kind = ANY (ARRAY['write_off'::text, 'discount'::text, 'adjustment'::text])))) OR ((direction = 'charge'::text) AND ((kind IS NULL) OR (kind = 'late_fee'::text)))`),
]);

export const invoiceExpectedPayments = pgTable("invoice_expected_payments", {
	dueDate: date("due_date"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amountCents: bigint("amount_cents", { mode: "number" }).default(0).notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	installmentId: text("installment_id"),
	invoiceId: uuid("invoice_id").notNull(),
	isDownPayment: boolean("is_down_payment").default(false).notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	matchedPaymentIndex: integer("matched_payment_index"),
	preDueReminderSentAt: timestamp("pre_due_reminder_sent_at", { withTimezone: true, mode: 'date' }),
	sortOrder: integer("sort_order").default(0).notNull(),
	status: text().default('pending').notNull(),
	stripeInvoiceAccountId: text("stripe_invoice_account_id"),
	stripeInvoiceId: text("stripe_invoice_id"),
	stripePaymentStatus: text("stripe_payment_status"),
}, (table) => [
	foreignKey({
			columns: [table.invoiceId, table.lawFirmId],
			foreignColumns: [invoices.id, invoices.lawFirmId],
			name: "invoice_expected_payments_law_firm_id_invoice_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.invoiceId],
			foreignColumns: [invoices.id],
			name: "invoice_expected_payments_invoice_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "invoice_expected_payments_law_firm_id_fkey"
		}).onDelete("cascade"),
	index("invoice_expected_due_day_idx").using("btree", table.dueDate.asc().nullsLast()),
	index("invoice_expected_firm_invoice_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.invoiceId.asc().nullsLast()),
	index("invoice_expected_invoice_idx").using("btree", table.invoiceId.asc().nullsLast(), table.sortOrder.asc().nullsLast()),
	check("invoice_expected_payments_status_check", sql`status = ANY (ARRAY['pending'::text, 'paid'::text, 'unpaid'::text])`),
	check("invoice_expected_payments_stripe_payment_status_check", sql`(stripe_payment_status IS NULL) OR (stripe_payment_status = ANY (ARRAY['completed'::text, 'pending'::text, 'voided'::text, 'failed'::text]))`),
]);

export const invoiceLineItems = pgTable("invoice_line_items", {
	quantity: numeric(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rateCents: bigint("rate_cents", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	allocationPercent: numeric("allocation_percent"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	allocationAmountCents: bigint("allocation_amount_cents", { mode: "number" }),
	amountCents: bigint("amount_cents", { mode: "number" }).default(0).notNull(),
	chargeCodeId: uuid("charge_code_id"),
	description: text(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	invoiceId: uuid("invoice_id").notNull(),
	kind: text().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	lineDate: date("line_date"),
	name: text(),
	sortOrder: integer("sort_order").default(0).notNull(),
	sourceId: text("source_id"),
	userId: text("user_id"),
	userName: text("user_name"),
	utbmsActivityCode: text("utbms_activity_code"),
	utbmsTaskCode: text("utbms_task_code"),
}, (table) => [
	foreignKey({
			columns: [table.invoiceId, table.lawFirmId],
			foreignColumns: [invoices.id, invoices.lawFirmId],
			name: "invoice_line_items_law_firm_id_invoice_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.invoiceId],
			foreignColumns: [invoices.id],
			name: "invoice_line_items_invoice_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "invoice_line_items_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "invoice_line_items_user_id_fkey"
		}).onDelete("restrict"),
	index("invoice_line_items_firm_invoice_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.invoiceId.asc().nullsLast()),
	index("invoice_line_items_invoice_idx").using("btree", table.invoiceId.asc().nullsLast(), table.kind.asc().nullsLast(), table.sortOrder.asc().nullsLast()),
	check("invoice_line_items_kind_check", sql`kind = ANY (ARRAY['time_entry'::text, 'flat_fee'::text, 'expense'::text])`),
	index("invoice_line_items_source_idx").using("btree", table.kind.asc().nullsLast(), table.sourceId.asc().nullsLast()).where(sql`(source_id IS NOT NULL)`),
]);

export const invoicePayments = pgTable("invoice_payments", {
	sortOrder: integer("sort_order").default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	stripePaymentIntentId: text("stripe_payment_intent_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	chargeModel: text("charge_model").default('destination').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	stripeDisputedCents: bigint("stripe_disputed_cents", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	surchargeCents: bigint("surcharge_cents", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	surchargeRefundedCents: bigint("surcharge_refunded_cents", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	invoiceId: uuid("invoice_id").notNull(),
	invoiceNumber: text("invoice_number"),
	lawFirmId: uuid("law_firm_id").notNull(),
	note: text(),
	paymentDate: date("payment_date"),
	paymentSource: text("payment_source"),
	recordedBy: text("recorded_by"),
	stripeInvoiceId: text("stripe_invoice_id"),
	stripeRefundedCents: bigint("stripe_refunded_cents", { mode: "number" }).default(0).notNull(),
	stripeSessionId: text("stripe_session_id"),
	surchargeDisputedCents: bigint("surcharge_disputed_cents", { mode: "number" }).default(0).notNull(),
	trustAccountId: uuid("trust_account_id"),
	trustTransactionId: uuid("trust_transaction_id"),
}, (table) => [
	foreignKey({
			columns: [table.invoiceId, table.lawFirmId],
			foreignColumns: [invoices.id, invoices.lawFirmId],
			name: "invoice_payments_law_firm_id_invoice_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.invoiceId],
			foreignColumns: [invoices.id],
			name: "invoice_payments_invoice_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "invoice_payments_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.recordedBy],
			foreignColumns: [users.id],
			name: "invoice_payments_recorded_by_fkey"
		}).onDelete("restrict"),
	check("invoice_payments_charge_model_check", sql`charge_model = ANY (ARRAY['destination'::text, 'direct'::text])`),
	index("invoice_payments_firm_invoice_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.invoiceId.asc().nullsLast()),
	index("invoice_payments_invoice_idx").using("btree", table.invoiceId.asc().nullsLast(), table.sortOrder.asc().nullsLast()),
	index("invoice_payments_paid_day_idx").using("btree", table.paymentDate.asc().nullsLast()),
	check("invoice_payments_stripe_disputed_cents_check", sql`(stripe_disputed_cents >= 0) AND (stripe_disputed_cents <= stripe_refunded_cents)`),
	check("invoice_payments_stripe_refunded_cents_check", sql`stripe_refunded_cents >= 0`),
	check("invoice_payments_surcharge_cents_check", sql`surcharge_cents >= 0`),
	check("invoice_payments_surcharge_disputed_cents_check", sql`(surcharge_disputed_cents >= 0) AND (surcharge_disputed_cents <= surcharge_refunded_cents)`),
	check("invoice_payments_surcharge_refunded_cents_check", sql`(surcharge_refunded_cents >= 0) AND (surcharge_refunded_cents <= surcharge_cents)`),
	index("invoice_payments_trust_txn_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.trustTransactionId.asc().nullsLast()),
]);

export const invoices = pgTable("invoices", {
	dueDate: date("due_date"),
	// TODO: failed to parse database type 'citext'
	clientName: text("client_name"),
	// TODO: failed to parse database type 'citext'
	status: text().default('draft').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	totalCents: bigint("total_cents", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	taxRate: numeric("tax_rate"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	totalHours: numeric("total_hours"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amountPaidCents: bigint("amount_paid_cents", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	balanceDueCents: bigint("balance_due_cents", { mode: "number" }).generatedAlwaysAs(sql`((total_cents - amount_paid_cents) - COALESCE(total_written_off_cents, (0)::bigint))`),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	paymentPlanEnabled: boolean("payment_plan_enabled").default(false).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	planRegularStartDate: date("plan_regular_start_date"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	splitRecipientCount: integer("split_recipient_count"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	billingClientAddress: text("billing_client_address"),
	billingClientName: text("billing_client_name"),
	billingContactEmail: text("billing_contact_email"),
	billingContactName: text("billing_contact_name"),
	billingContactTitle: text("billing_contact_title"),
	billingEmail: citext("billing_email"),
	billingEmails: text("billing_emails").array().default([""]).notNull(),
	billingPlanId: uuid("billing_plan_id"),
	billingPlanName: text("billing_plan_name"),
	billingPlanPeriodId: uuid("billing_plan_period_id"),
	billingPlanType: text("billing_plan_type"),
	billingSnapshotAt: timestamp("billing_snapshot_at", { withTimezone: true, mode: 'date' }),
	calendarSync: jsonb("calendar_sync"),
	clientContextId: uuid("client_context_id"),
	clientEmail: citext("client_email"),
	clientId: uuid("client_id"),
	contextType: text("context_type"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	flatFeesAmountCents: bigint("flat_fees_amount_cents", { mode: "number" }).default(0).notNull(),
	googleLastModified: timestamp("google_last_modified", { withTimezone: true, mode: 'date' }),
	id: uuid().defaultRandom().primaryKey().notNull(),
	invoiceDate: date("invoice_date"),
	invoiceName: text("invoice_name"),
	invoiceNumber: text("invoice_number").notNull(),
	isBankFeePassedOn: boolean("is_bank_fee_passed_on").default(false).notNull(),
	isCardFeePassedOn: boolean("is_card_fee_passed_on").default(false).notNull(),
	isPaid: boolean("is_paid").default(false).notNull(),
	isRecurringRetainer: boolean("is_recurring_retainer").default(false).notNull(),
	lastSyncedToGoogle: timestamp("last_synced_to_google", { withTimezone: true, mode: 'date' }),
	lastSyncedToOutlook: timestamp("last_synced_to_outlook", { withTimezone: true, mode: 'date' }),
	lawFirmId: uuid("law_firm_id").notNull(),
	matterClientId: uuid("matter_client_id"),
	matterId: uuid("matter_id"),
	nextPaymentDate: date("next_payment_date"),
	notes: text(),
	outlookLastModified: timestamp("outlook_last_modified", { withTimezone: true, mode: 'date' }),
	paidDate: timestamp("paid_date", { withTimezone: true, mode: 'date' }),
	payLinkInstallmentId: text("pay_link_installment_id"),
	payLinkToken: text("pay_link_token"),
	planDownPaymentCents: bigint("plan_down_payment_cents", { mode: "number" }),
	planFrequencyDays: integer("plan_frequency_days"),
	planInstallmentCents: bigint("plan_installment_cents", { mode: "number" }),
	planPreReminderDays: integer("plan_pre_reminder_days"),
	planStartDate: date("plan_start_date"),
	remitTo: text("remit_to"),
	remitToAddress: text("remit_to_address"),
	remitToCity: text("remit_to_city"),
	remitToName: text("remit_to_name"),
	remitToState: text("remit_to_state"),
	remitToZip: text("remit_to_zip"),
	splitGroupId: uuid("split_group_id"),
	splitMode: text("split_mode"),
	splitShareCents: bigint("split_share_cents", { mode: "number" }),
	splitSharePercent: numeric("split_share_percent"),
	stripeCardPaymentIntentAccountId: text("stripe_card_payment_intent_account_id"),
	stripeCardPaymentIntentId: text("stripe_card_payment_intent_id"),
	stripeCheckoutSessionAccountId: text("stripe_checkout_session_account_id"),
	stripeCheckoutSessionId: text("stripe_checkout_session_id"),
	stripeInvoiceAccountId: text("stripe_invoice_account_id"),
	stripeInvoiceId: text("stripe_invoice_id"),
	stripePaymentIntentId: text("stripe_payment_intent_id"),
	stripePaymentRequested: boolean("stripe_payment_requested").default(false).notNull(),
	stripePaymentRequestedBy: text("stripe_payment_requested_by"),
	stripePaymentStatus: text("stripe_payment_status"),
	taxCents: bigint("tax_cents", { mode: "number" }).default(0).notNull(),
	totalWrittenOffCents: bigint("total_written_off_cents", { mode: "number" }).default(0).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	updatedBy: text("updated_by"),
}, (table) => [
	foreignKey({
			columns: [table.billingPlanId],
			foreignColumns: [billingPlans.id],
			name: "invoices_plan_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.clientContextId],
			foreignColumns: [clients.id],
			name: "invoices_client_context_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.clientId],
			foreignColumns: [clients.id],
			name: "invoices_client_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "invoices_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId, table.matterId],
			foreignColumns: [matters.id, matters.lawFirmId],
			name: "invoices_law_firm_id_matter_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "invoices_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.stripePaymentRequestedBy],
			foreignColumns: [users.id],
			name: "invoices_stripe_payment_requested_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.updatedBy],
			foreignColumns: [users.id],
			name: "invoices_updated_by_fkey"
		}).onDelete("restrict"),
	uniqueIndex("invoices_name_unique_idx").using("btree", sql`law_firm_id`, sql`COALESCE(matter_id, client_context_id)`, sql`lower(invoice_name)`).where(sql`((invoice_name IS NOT NULL) AND (invoice_name <> ''::text))`),
	uniqueIndex("invoices_number_unique_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.invoiceNumber.asc().nullsLast()).where(sql`((invoice_number IS NOT NULL) AND (invoice_number <> ''::text))`),
	uniqueIndex("invoices_pay_link_token_key").using("btree", table.payLinkToken.asc().nullsLast()).where(sql`(pay_link_token IS NOT NULL)`),
	check("invoices_amount_paid_cents_check", sql`amount_paid_cents >= 0`),
	index("invoices_billing_plan_idx").using("btree", table.billingPlanId.asc().nullsLast()).where(sql`(billing_plan_id IS NOT NULL)`),
	index("invoices_billing_plan_period_idx").using("btree", table.billingPlanPeriodId.asc().nullsLast()).where(sql`(billing_plan_period_id IS NOT NULL)`),
	check("invoices_billing_plan_type_check", sql`(billing_plan_type IS NULL) OR (billing_plan_type = 'retainer'::text)`),
	check("invoices_check", sql`(matter_id IS NOT NULL) <> (client_context_id IS NOT NULL)`),
	index("invoices_client_context_fk_idx").using("btree", table.clientContextId.asc().nullsLast()).where(sql`(client_context_id IS NOT NULL)`),
	index("invoices_client_fk_idx").using("btree", table.clientId.asc().nullsLast()).where(sql`(client_id IS NOT NULL)`),
	check("invoices_context_type_check", sql`(context_type IS NULL) OR (context_type = ANY (ARRAY['matter'::text, 'client'::text]))`),
	index("invoices_firm_due_all_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.dueDate.asc().nullsLast()),
	index("invoices_firm_matter_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.matterId.asc().nullsLast()).where(sql`(matter_id IS NOT NULL)`),
	unique("invoices_law_firm_id_id_key").on(table.id, table.lawFirmId),
	index("invoices_name_prefix_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.invoiceName.asc().nullsLast()).where(sql`(invoice_name IS NOT NULL)`),
	index("invoices_outstanding_idx").using("btree", table.lawFirmId.asc().nullsLast()).where(sql`(balance_due_cents > 0)`),
	check("invoices_split_share_cents_check", sql`(split_share_cents IS NULL) OR (split_share_cents >= 0)`),
	check("invoices_status_check", sql`status = ANY (ARRAY['draft'::text, 'outstanding'::text, 'overdue'::text, 'partially_paid'::text, 'paid'::text, 'credited'::text, 'voided'::text])`),
	check("invoices_stripe_payment_status_check", sql`(stripe_payment_status IS NULL) OR (stripe_payment_status = ANY (ARRAY['completed'::text, 'pending'::text, 'voided'::text, 'failed'::text]))`),
	check("invoices_total_cents_check", sql`total_cents >= 0`),
]);

export const lawFirms = pgTable("law_firms", {
	website: text(),
	// TODO: failed to parse database type 'citext'
	directChargesEnabled: boolean("direct_charges_enabled").default(false).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	storageQuotaBytes: bigint("storage_quota_bytes", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	storageUsedBytes: bigint("storage_used_bytes", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	storageUsageRecountedAt: timestamp("storage_usage_recounted_at", { withTimezone: true, mode: 'date' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	address: text(),
	billingStatus: text("billing_status").default('comped').notNull(),
	city: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	deletionPurgeAfter: timestamp("deletion_purge_after", { withTimezone: true, mode: 'date' }),
	deletionRequestedBy: text("deletion_requested_by"),
	description: text(),
	email: citext("email"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	logoObjectPath: text("logo_object_path"),
	name: text().notNull(),
	pendingDeletionAt: timestamp("pending_deletion_at", { withTimezone: true, mode: 'date' }),
	phone: text(),
	plan: jsonb().default({}).notNull(),
	planId: text("plan_id").default('starter').notNull(),
	settings: jsonb().default({}).notNull(),
	state: text(),
	storageFileCount: bigint("storage_file_count", { mode: "number" }),
	storageHardLimit: boolean("storage_hard_limit").default(false).notNull(),
	storageReservedBytes: bigint("storage_reserved_bytes", { mode: "number" }).default(0).notNull(),
	storageUsageUpdatedAt: timestamp("storage_usage_updated_at", { withTimezone: true, mode: 'date' }),
	storageWarnAtPercent: integer("storage_warn_at_percent").default(85).notNull(),
	stripeAccountId: text("stripe_account_id"),
	stripeChargesEnabled: boolean("stripe_charges_enabled").default(false).notNull(),
	stripeOnboardingComplete: boolean("stripe_onboarding_complete").default(false).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	zip: text(),
}, (table) => [
	foreignKey({
			columns: [table.deletionRequestedBy],
			foreignColumns: [users.id],
			name: "law_firms_deletion_requested_by_fkey"
		}).onDelete("restrict"),
	check("law_firms_billing_status_check", sql`billing_status = ANY (ARRAY['comped'::text, 'active'::text, 'trialing'::text, 'incomplete'::text, 'past_due'::text, 'canceled'::text])`),
	index("law_firms_created_at_idx").using("btree", table.createdAt.desc().nullsFirst()),
	check("law_firms_plan_id_check", sql`plan_id = ANY (ARRAY['starter'::text, 'basic'::text, 'professional'::text, 'enterprise'::text])`),
	index("law_firms_plan_idx").using("btree", table.planId.asc().nullsLast(), table.billingStatus.asc().nullsLast()),
	index("law_firms_purge_eligible_idx").using("btree", table.deletionPurgeAfter.asc().nullsLast()).where(sql`(pending_deletion_at IS NOT NULL)`),
	check("law_firms_storage_quota_bytes_check", sql`(storage_quota_bytes IS NULL) OR (storage_quota_bytes >= 0)`),
	check("law_firms_storage_reserved_bytes_check", sql`storage_reserved_bytes >= 0`),
	check("law_firms_storage_used_bytes_check", sql`storage_used_bytes >= 0`),
	check("law_firms_storage_warn_at_percent_check", sql`(storage_warn_at_percent >= 1) AND (storage_warn_at_percent <= 100)`),
]);

export const leads = pgTable("leads", {
	convertedAt: timestamp("converted_at", { withTimezone: true, mode: 'date' }),
	convertedClientId: uuid("converted_client_id"),
	convertedMatterId: uuid("converted_matter_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	disqualifyReason: text("disqualify_reason"),
	email: text(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	name: text().notNull(),
	notes: text(),
	organization: text(),
	phone: text(),
	referralSource: text("referral_source"),
	stageDate: date("stage_date"),
	stageId: uuid("stage_id"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.convertedMatterId],
			foreignColumns: [matters.id],
			name: "leads_converted_matter_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "leads_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId, table.stageId],
			foreignColumns: [leadStages.id, leadStages.lawFirmId],
			name: "leads_stage_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "leads_law_firm_id_fkey"
		}).onDelete("cascade"),
	index("leads_firm_email_idx").using("btree", sql`law_firm_id`, sql`lower(email)`).where(sql`(email IS NOT NULL)`),
	index("leads_firm_stage_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.stageId.asc().nullsLast()),
	unique("leads_law_firm_id_id_key").on(table.id, table.lawFirmId),
]);

export const leadStages = pgTable("lead_stages", {
	color: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	isClosed: boolean("is_closed").default(false).notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	name: text().notNull(),
	parentStageId: uuid("parent_stage_id"),
	practiceAreaId: uuid("practice_area_id"),
	sortOrder: integer("sort_order").default(0).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "lead_stages_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.parentStageId],
			foreignColumns: [table.id],
			name: "lead_stages_parent_stage_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.practiceAreaId],
			foreignColumns: [practiceAreas.id],
			name: "lead_stages_practice_area_id_fkey"
		}).onDelete("set null"),
	index("lead_stages_firm_pa_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.practiceAreaId.asc().nullsLast()),
	unique("lead_stages_law_firm_id_id_key").on(table.id, table.lawFirmId),
	index("lead_stages_parent_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.parentStageId.asc().nullsLast()),
]);

export const legalHolds = pgTable("legal_holds", {
	clientId: uuid("client_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	fileId: uuid("file_id"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	matterId: uuid("matter_id"),
	placedAt: timestamp("placed_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	placedBy: text("placed_by"),
	reason: text(),
	releasedAt: timestamp("released_at", { withTimezone: true, mode: 'date' }),
	releasedBy: text("released_by"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId, table.fileId],
			foreignColumns: [files.id, files.lawFirmId],
			name: "legal_holds_law_firm_id_file_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.matterId],
			foreignColumns: [matters.id, matters.lawFirmId],
			name: "legal_holds_law_firm_id_matter_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "legal_holds_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.placedBy],
			foreignColumns: [users.id],
			name: "legal_holds_placed_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.releasedBy],
			foreignColumns: [users.id],
			name: "legal_holds_released_by_fkey"
		}).onDelete("restrict"),
	index("legal_holds_client_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.clientId.asc().nullsLast()).where(sql`((client_id IS NOT NULL) AND (released_at IS NULL))`),
	index("legal_holds_file_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.fileId.asc().nullsLast()).where(sql`((file_id IS NOT NULL) AND (released_at IS NULL))`),
	unique("legal_holds_law_firm_id_id_key").on(table.id, table.lawFirmId),
	index("legal_holds_matter_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.matterId.asc().nullsLast()).where(sql`((matter_id IS NOT NULL) AND (released_at IS NULL))`),
	check("legal_holds_one_subject", sql`num_nonnulls(matter_id, client_id, file_id) = 1`),
]);

export const lockLeases = pgTable("lock_leases", {
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	domain: text().notNull(),
	lockedUntil: timestamp("locked_until", { withTimezone: true, mode: 'date' }).notNull(),
	lockKey: text("lock_key").notNull(),
	ownerToken: uuid("owner_token").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.domain, table.lockKey], name: "lock_leases_pkey"}),
]);

export const matterCategories = pgTable("matter_categories", {
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	level: integer().default(0).notNull(),
	name: text().notNull(),
	parentId: uuid("parent_id"),
	path: text(),
	sortOrder: integer("sort_order").default(0).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "matter_categories_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "matter_categories_law_firm_id_fkey"
		}).onDelete("cascade"),
	unique("matter_categories_law_firm_id_id_key").on(table.id, table.lawFirmId),
	index("matter_categories_parent_idx").using("btree", table.parentId.asc().nullsLast()),
]);

export const matterClients = pgTable("matter_clients", {
	billingPortionBp: integer("billing_portion_bp"),
	clientId: uuid("client_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	matterId: uuid("matter_id").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.clientId, table.lawFirmId],
			foreignColumns: [clients.id, clients.lawFirmId],
			name: "matter_clients_law_firm_id_client_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.matterId, table.lawFirmId],
			foreignColumns: [matters.id, matters.lawFirmId],
			name: "matter_clients_law_firm_id_matter_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.matterId, table.clientId], name: "matter_clients_pkey"}),
	check("matter_clients_billing_portion_bp_range", sql`(billing_portion_bp IS NULL) OR ((billing_portion_bp >= 0) AND (billing_portion_bp <= 10000))`),
	index("matter_clients_client_idx").using("btree", table.clientId.asc().nullsLast()),
	index("matter_clients_firm_client_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.clientId.asc().nullsLast()),
	index("matter_clients_firm_matter_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.matterId.asc().nullsLast(), table.clientId.asc().nullsLast()),
]);

export const matterContacts = pgTable("matter_contacts", {
	contactId: uuid("contact_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	matterId: uuid("matter_id").notNull(),
	notes: text(),
	role: text().default('other').notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "matter_contacts_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId, table.contactId],
			foreignColumns: [contacts.id, contacts.lawFirmId],
			name: "matter_contacts_contact_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.matterId],
			foreignColumns: [matters.id, matters.lawFirmId],
			name: "matter_contacts_law_firm_id_matter_id_fkey"
		}).onDelete("cascade"),
	index("matter_contacts_contact_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.contactId.asc().nullsLast()),
	unique("matter_contacts_law_firm_id_id_key").on(table.id, table.lawFirmId),
	index("matter_contacts_matter_idx").using("btree", table.matterId.asc().nullsLast()),
	check("matter_contacts_role_check", sql`role = ANY (ARRAY['opposing_counsel'::text, 'opposing_party'::text, 'co_counsel'::text, 'judge'::text, 'witness'::text, 'expert'::text, 'adjuster'::text, 'court_clerk'::text, 'mediator'::text, 'guardian_ad_litem'::text, 'other'::text])`),
	unique("matter_contacts_unique_link").on(table.lawFirmId, table.matterId, table.contactId),
]);

export const matterFieldDefs = pgTable("matter_field_defs", {
	archived: boolean().default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	fieldType: text("field_type").default('text').notNull(),
	helpText: text("help_text"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	label: text().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	options: jsonb().default([]).notNull(),
	practiceAreaId: uuid("practice_area_id"),
	required: boolean().default(false).notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "matter_field_defs_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "matter_field_defs_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.practiceAreaId],
			foreignColumns: [practiceAreas.id],
			name: "matter_field_defs_practice_area_id_fkey"
		}).onDelete("cascade"),
	check("matter_field_defs_field_type_check", sql`field_type = ANY (ARRAY['text'::text, 'textarea'::text, 'number'::text, 'currency'::text, 'date'::text, 'select'::text, 'multiselect'::text, 'checkbox'::text, 'url'::text, 'email'::text, 'phone'::text])`),
	index("matter_field_defs_firm_pa_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.practiceAreaId.asc().nullsLast()),
	unique("matter_field_defs_law_firm_id_id_key").on(table.id, table.lawFirmId),
]);

export const matterMembers = pgTable("matter_members", {
	role: text().default('member').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	hourlyRateCents: bigint("hourly_rate_cents", { mode: "number" }),
	joinedAt: timestamp("joined_at", { withTimezone: true, mode: 'date' }),
	lawFirmId: uuid("law_firm_id").notNull(),
	matterId: uuid("matter_id").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	userId: text("user_id").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.matterId, table.lawFirmId],
			foreignColumns: [matters.id, matters.lawFirmId],
			name: "matter_members_law_firm_id_matter_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "matter_members_user_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.matterId, table.userId], name: "matter_members_pkey"}),
	index("matter_members_firm_matter_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.matterId.asc().nullsLast()),
	check("matter_members_hourly_rate_cents_check", sql`(hourly_rate_cents IS NULL) OR (hourly_rate_cents >= 0)`),
	check("matter_members_role_check", sql`role = ANY (ARRAY['lead'::text, 'member'::text])`),
	index("matter_members_user_idx").using("btree", table.userId.asc().nullsLast()),
]);

export const matters = pgTable("matters", {
	isBillable: boolean("is_billable").default(true).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	billingMethod: text("billing_method").default('hourly').notNull(),
	budgetCents: bigint("budget_cents", { mode: "number" }),
	budgetIncludesExpenses: boolean("budget_includes_expenses").default(true).notNull(),
	category: text(),
	closeDate: date("close_date"),
	contingencyPercent: numeric("contingency_percent"),
	courtId: uuid("court_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	customFields: jsonb("custom_fields").default({}).notNull(),
	description: text(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	leadUserId: text("lead_user_id"),
	matterNumber: text("matter_number"),
	matterReferenceId: text("matter_reference_id").notNull(),
	name: text().notNull(),
	openDate: date("open_date"),
	paymentOngoing: boolean("payment_ongoing").default(false).notNull(),
	practiceAreaId: uuid("practice_area_id"),
	stageId: uuid("stage_id"),
	stagePipelineId: uuid("stage_pipeline_id"),
	status: text().default('active').notNull(),
	statuteOfLimitationsDate: date("statute_of_limitations_date"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.courtId],
			foreignColumns: [courts.id],
			name: "matters_court_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "matters_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "matters_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.leadUserId],
			foreignColumns: [users.id],
			name: "matters_lead_user_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.practiceAreaId],
			foreignColumns: [practiceAreas.id],
			name: "matters_practice_area_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.stageId],
			foreignColumns: [matterStages.id],
			name: "matters_stage_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.stagePipelineId],
			foreignColumns: [matterStagePipelines.id],
			name: "matters_stage_pipeline_id_fkey"
		}).onDelete("set null"),
	check("matters_billing_method_check", sql`billing_method = ANY (ARRAY['hourly'::text, 'flat'::text, 'contingency'::text, 'pro_bono'::text])`),
	check("matters_budget_cents_check", sql`(budget_cents IS NULL) OR (budget_cents >= 0)`),
	check("matters_contingency_percent_check", sql`(contingency_percent IS NULL) OR ((contingency_percent >= (0)::numeric) AND (contingency_percent <= (100)::numeric))`),
	index("matters_court_idx").using("btree", table.courtId.asc().nullsLast()).where(sql`(court_id IS NOT NULL)`),
	index("matters_desc_trgm_idx").using("gin", table.description.asc().nullsLast()),
	index("matters_firm_created_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.createdAt.desc().nullsFirst(), table.id.asc().nullsLast()),
	index("matters_firm_sol_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.statuteOfLimitationsDate.asc().nullsLast()),
	index("matters_firm_stage_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.stageId.asc().nullsLast()),
	index("matters_firm_status_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.status.asc().nullsLast()),
	unique("matters_law_firm_id_id_key").on(table.id, table.lawFirmId),
	unique("matters_law_firm_id_matter_reference_id_key").on(table.lawFirmId, table.matterReferenceId),
	index("matters_name_trgm_idx").using("gin", table.name.asc().nullsLast()),
	index("matters_number_trgm_idx").using("gin", table.matterNumber.asc().nullsLast()),
	index("matters_practice_area_idx").using("btree", table.practiceAreaId.asc().nullsLast()).where(sql`(practice_area_id IS NOT NULL)`),
	index("matters_stage_fk_idx").using("btree", table.stageId.asc().nullsLast()).where(sql`(stage_id IS NOT NULL)`),
	index("matters_stage_pipeline_idx").using("btree", table.stagePipelineId.asc().nullsLast()).where(sql`(stage_pipeline_id IS NOT NULL)`),
	check("matters_status_check", sql`status = ANY (ARRAY['active'::text, 'pending'::text, 'on_hold'::text, 'completed'::text, 'blocked'::text, 'closed'::text, 'archived'::text])`),
]);

export const matterStagePipelines = pgTable("matter_stage_pipelines", {
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	isDefault: boolean("is_default").default(false).notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	name: text().notNull(),
	practiceAreaId: uuid("practice_area_id"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "matter_stage_pipelines_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.practiceAreaId],
			foreignColumns: [practiceAreas.id],
			name: "matter_stage_pipelines_practice_area_id_fkey"
		}).onDelete("set null"),
	uniqueIndex("matter_stage_pipelines_one_default_idx").using("btree", sql`law_firm_id`, sql`COALESCE(practice_area_id, '00000000-0000-0000-0000-00000000000`).where(sql`is_default`),
	index("matter_stage_pipelines_firm_pa_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.practiceAreaId.asc().nullsLast()),
	unique("matter_stage_pipelines_law_firm_id_id_key").on(table.id, table.lawFirmId),
]);

export const matterStages = pgTable("matter_stages", {
	color: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	isClosed: boolean("is_closed").default(false).notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	name: text().notNull(),
	parentStageId: uuid("parent_stage_id"),
	pipelineId: uuid("pipeline_id").notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "matter_stages_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.parentStageId],
			foreignColumns: [table.id],
			name: "matter_stages_parent_stage_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.pipelineId],
			foreignColumns: [matterStagePipelines.id],
			name: "matter_stages_pipeline_id_fkey"
		}).onDelete("cascade"),
	unique("matter_stages_law_firm_id_id_key").on(table.id, table.lawFirmId),
	index("matter_stages_parent_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.parentStageId.asc().nullsLast()),
	index("matter_stages_pipeline_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.pipelineId.asc().nullsLast()),
]);

export const members = pgTable("members", {
	isOwner: boolean("is_owner").default(false).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	defaultHourlyRateCents: bigint("default_hourly_rate_cents", { mode: "number" }),
	invitedAt: timestamp("invited_at", { withTimezone: true, mode: 'date' }),
	invitedBy: text("invited_by"),
	joinedAt: timestamp("joined_at", { withTimezone: true, mode: 'date' }),
	lawFirmId: uuid("law_firm_id").notNull(),
	presentAsFirm: boolean("present_as_firm").default(false).notNull(),
	roleId: uuid("role_id"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	userId: text("user_id").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.invitedBy],
			foreignColumns: [users.id],
			name: "members_invited_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "members_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.roleId],
			foreignColumns: [roles.id],
			name: "members_role_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "members_user_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.lawFirmId, table.userId], name: "members_pkey"}),
	uniqueIndex("members_one_owner_per_firm_idx").using("btree", table.lawFirmId.asc().nullsLast()).where(sql`is_owner`),
	check("members_default_hourly_rate_cents_check", sql`(default_hourly_rate_cents IS NULL) OR (default_hourly_rate_cents >= 0)`),
	index("members_user_idx").using("btree", table.userId.asc().nullsLast()),
]);

export const messages = pgTable("messages", {
	attachments: jsonb(),
	content: text().default("").notNull(),
	conversationId: uuid("conversation_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'date' }),
	deletedBy: text("deleted_by"),
	editedAt: timestamp("edited_at", { withTimezone: true, mode: 'date' }),
	id: uuid().defaultRandom().primaryKey().notNull(),
	kind: text().default('user').notNull(),
	lawFirmId: uuid("law_firm_id"),
	matterId: uuid("matter_id"),
	mentions: jsonb().default([]).notNull(),
	read: boolean().default(false).notNull(),
	readAt: timestamp("read_at", { withTimezone: true, mode: 'date' }),
	readByClient: boolean("read_by_client").default(false).notNull(),
	readByFirm: boolean("read_by_firm").default(false).notNull(),
	senderName: text("sender_name"),
	senderType: text("sender_type"),
	senderUserId: text("sender_user_id"),
	sentAsFirm: boolean("sent_as_firm").default(false).notNull(),
	status: text().default('sent'),
	systemEvent: jsonb("system_event"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }),
}, (table) => [
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversations.id],
			name: "messages_conversation_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.deletedBy],
			foreignColumns: [users.id],
			name: "messages_deleted_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "messages_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.senderUserId],
			foreignColumns: [users.id],
			name: "messages_sender_user_id_fkey"
		}).onDelete("restrict"),
	pgPolicy("messages_realtime_select", { as: "permissive", for: "select", to: ["public"], using: sql`messaging_realtime_message_access(conversation_id, (auth.jwt() ->> 'sub'::text))` }),
	index("messages_client_unread_idx").using("btree", table.conversationId.asc().nullsLast()).where(sql`((sender_type = 'firm_member'::text) AND (read_by_client = false))`),
	index("messages_conversation_created_idx").using("btree", table.conversationId.asc().nullsLast(), table.createdAt.desc().nullsFirst(), table.content.asc().nullsLast()),
	index("messages_deleted_by_idx").using("btree", table.deletedBy.asc().nullsLast()).where(sql`(deleted_by IS NOT NULL)`),
	index("messages_firm_idx").using("btree", table.lawFirmId.asc().nullsLast()),
	index("messages_firm_unread_idx").using("btree", table.conversationId.asc().nullsLast()).where(sql`((sender_type = 'client'::text) AND (read_by_firm = false))`),
	check("messages_kind_check", sql`kind = ANY (ARRAY['user'::text, 'system'::text])`),
	check("messages_sender_type_check", sql`(sender_type IS NULL) OR (sender_type = ANY (ARRAY['client'::text, 'firm_member'::text]))`),
]);

export const noteLinks = pgTable("note_links", {
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	createdFromNote: boolean("created_from_note").default(false).notNull(),
	fileId: uuid("file_id"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	linkType: text("link_type").notNull(),
	noteId: uuid("note_id").notNull(),
	replyId: uuid("reply_id"),
	taskId: uuid("task_id"),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "note_links_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId, table.noteId],
			foreignColumns: [notes.id, notes.lawFirmId],
			name: "note_links_law_firm_id_note_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.taskId],
			foreignColumns: [tasks.id, tasks.lawFirmId],
			name: "note_links_law_firm_id_task_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "note_links_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.replyId],
			foreignColumns: [noteReplies.id],
			name: "note_links_reply_id_fkey"
		}).onDelete("set null"),
	uniqueIndex("note_links_file_uniq").using("btree", table.noteId.asc().nullsLast(), table.fileId.asc().nullsLast()).where(sql`(file_id IS NOT NULL)`),
	uniqueIndex("note_links_task_uniq").using("btree", table.noteId.asc().nullsLast(), table.taskId.asc().nullsLast()).where(sql`(task_id IS NOT NULL)`),
	index("note_links_file_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.fileId.asc().nullsLast()).where(sql`(file_id IS NOT NULL)`),
	index("note_links_firm_note_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.noteId.asc().nullsLast()),
	index("note_links_firm_task_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.taskId.asc().nullsLast()),
	unique("note_links_law_firm_id_id_key").on(table.id, table.lawFirmId),
	check("note_links_link_type_check", sql`link_type = ANY (ARRAY['task'::text, 'file'::text])`),
	index("note_links_note_idx").using("btree", table.noteId.asc().nullsLast()),
	check("note_links_target_ck", sql`((link_type = 'task'::text) AND (task_id IS NOT NULL) AND (file_id IS NULL)) OR ((link_type = 'file'::text) AND (file_id IS NOT NULL) AND (task_id IS NULL))`),
	index("note_links_task_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.taskId.asc().nullsLast()).where(sql`(task_id IS NOT NULL)`),
]);

export const noteReplies = pgTable("note_replies", {
	content: text().default("").notNull(),
	contentHtml: text("content_html"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	editedAt: timestamp("edited_at", { withTimezone: true, mode: 'date' }),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	mentions: jsonb().default([]).notNull(),
	noteId: uuid("note_id").notNull(),
	parentReplyId: uuid("parent_reply_id"),
	retractedAt: timestamp("retracted_at", { withTimezone: true, mode: 'date' }),
	retractedBy: text("retracted_by"),
	retractionReason: text("retraction_reason"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "note_replies_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId, table.noteId],
			foreignColumns: [notes.id, notes.lawFirmId],
			name: "note_replies_law_firm_id_note_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "note_replies_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.parentReplyId],
			foreignColumns: [table.id],
			name: "note_replies_parent_reply_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.retractedBy],
			foreignColumns: [users.id],
			name: "note_replies_retracted_by_fkey"
		}).onDelete("restrict"),
	index("note_replies_firm_note_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.noteId.asc().nullsLast()),
	unique("note_replies_law_firm_id_id_key").on(table.id, table.lawFirmId),
	index("note_replies_note_idx").using("btree", table.noteId.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	index("note_replies_parent_idx").using("btree", table.parentReplyId.asc().nullsLast()),
]);

export const notes = pgTable("notes", {
	clientId: uuid("client_id"),
	content: text().default("").notNull(),
	contentHtml: text("content_html"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	editedAt: timestamp("edited_at", { withTimezone: true, mode: 'date' }),
	editedBy: text("edited_by"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	matterId: uuid("matter_id"),
	mentions: jsonb().default([]).notNull(),
	noteDate: date("note_date").default(sql`CURRENT_DATE`),
	noteType: text("note_type").default('general'),
	pinnedAt: timestamp("pinned_at", { withTimezone: true, mode: 'date' }),
	pinnedBy: text("pinned_by"),
	retractedAt: timestamp("retracted_at", { withTimezone: true, mode: 'date' }),
	retractedBy: text("retracted_by"),
	retractionReason: text("retraction_reason"),
	subject: text(),
	taskId: uuid("task_id"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "notes_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.editedBy],
			foreignColumns: [users.id],
			name: "notes_edited_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId, table.clientId],
			foreignColumns: [clients.id, clients.lawFirmId],
			name: "notes_law_firm_id_client_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.matterId],
			foreignColumns: [matters.id, matters.lawFirmId],
			name: "notes_law_firm_id_matter_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.taskId],
			foreignColumns: [tasks.id, tasks.lawFirmId],
			name: "notes_law_firm_id_task_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "notes_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.pinnedBy],
			foreignColumns: [users.id],
			name: "notes_pinned_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.retractedBy],
			foreignColumns: [users.id],
			name: "notes_retracted_by_fkey"
		}).onDelete("restrict"),
	index("notes_author_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.createdBy.asc().nullsLast()).where(sql`(created_by IS NOT NULL)`),
	index("notes_client_date_idx").using("btree", table.clientId.asc().nullsLast(), table.noteDate.desc().nullsFirst(), table.createdAt.desc().nullsFirst()).where(sql`(client_id IS NOT NULL)`),
	index("notes_firm_client_created_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.clientId.asc().nullsLast(), table.createdAt.desc().nullsFirst(), table.id.desc().nullsFirst()).where(sql`(client_id IS NOT NULL)`),
	index("notes_firm_date_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.noteDate.desc().nullsFirst(), table.createdAt.desc().nullsFirst()),
	index("notes_firm_matter_created_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.matterId.asc().nullsLast(), table.createdAt.desc().nullsFirst(), table.id.desc().nullsFirst()).where(sql`(matter_id IS NOT NULL)`),
	index("notes_firm_task_created_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.taskId.asc().nullsLast(), table.createdAt.desc().nullsFirst(), table.id.desc().nullsFirst()).where(sql`(task_id IS NOT NULL)`),
	index("notes_firm_task_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.taskId.asc().nullsLast()),
	unique("notes_law_firm_id_id_key").on(table.id, table.lawFirmId),
	index("notes_matter_date_idx").using("btree", table.matterId.asc().nullsLast(), table.noteDate.desc().nullsFirst(), table.createdAt.desc().nullsFirst()).where(sql`(matter_id IS NOT NULL)`),
	check("notes_one_parent", sql`((((matter_id IS NOT NULL))::integer + ((task_id IS NOT NULL))::integer) + ((client_id IS NOT NULL))::integer) = 1`),
	index("notes_pinned_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.pinnedAt.desc().nullsFirst()).where(sql`(pinned_at IS NOT NULL)`),
	index("notes_task_date_idx").using("btree", table.taskId.asc().nullsLast(), table.noteDate.desc().nullsFirst(), table.createdAt.desc().nullsFirst()).where(sql`(task_id IS NOT NULL)`),
]);

export const noteTemplates = pgTable("note_templates", {
	contentHtml: text("content_html").default("").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	label: text().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	noteType: text("note_type").default('general').notNull(),
	subject: text().default("").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "note_templates_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "note_templates_law_firm_id_fkey"
		}).onDelete("cascade"),
	unique("note_templates_law_firm_id_id_key").on(table.id, table.lawFirmId),
	index("note_templates_law_firm_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.label.asc().nullsLast()),
]);

export const noteTypes = pgTable("note_types", {
	color: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	label: text().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	value: text().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "note_types_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "note_types_law_firm_id_fkey"
		}).onDelete("cascade"),
	unique("note_types_law_firm_id_id_key").on(table.id, table.lawFirmId),
	unique("note_types_law_firm_id_value_key").on(table.lawFirmId, table.value),
	index("note_types_law_firm_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.label.asc().nullsLast()),
]);

export const noteVersions = pgTable("note_versions", {
	content: text().default("").notNull(),
	contentHtml: text("content_html"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	editedBy: text("edited_by"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	noteDate: date("note_date"),
	noteId: uuid("note_id").notNull(),
	noteType: text("note_type"),
	subject: text(),
	version: integer().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.editedBy],
			foreignColumns: [users.id],
			name: "note_versions_edited_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId, table.noteId],
			foreignColumns: [notes.id, notes.lawFirmId],
			name: "note_versions_law_firm_id_note_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "note_versions_law_firm_id_fkey"
		}).onDelete("cascade"),
	index("note_versions_firm_note_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.noteId.asc().nullsLast()),
	unique("note_versions_law_firm_id_id_key").on(table.id, table.lawFirmId),
	unique("note_versions_note_id_version_key").on(table.noteId, table.version),
]);

export const notifications = pgTable("notifications", {
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	actionUrl: text("action_url"),
	body: text().notNull(),
	createdBy: text("created_by"),
	dedupeBucket: bigint("dedupe_bucket", { mode: "number" }),
	dedupeHash: text("dedupe_hash"),
	entityId: uuid("entity_id"),
	entityType: text("entity_type"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	matterId: uuid("matter_id"),
	read: boolean().default(false).notNull(),
	title: text().notNull(),
	type: text().notNull(),
	userId: text("user_id").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "notifications_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "notifications_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "notifications_user_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("notifications_realtime_select", { as: "permissive", for: "select", to: ["public"], using: sql`((auth.jwt() ->> 'sub'::text) = user_id)` }),
	uniqueIndex("notifications_dedupe_uq").using("btree", table.lawFirmId.asc().nullsLast(), table.userId.asc().nullsLast(), table.dedupeHash.asc().nullsLast(), table.dedupeBucket.asc().nullsLast()).where(sql`(dedupe_hash IS NOT NULL)`),
	index("notifications_created_at_idx").using("btree", table.createdAt.asc().nullsLast()),
	index("notifications_entity_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.entityType.asc().nullsLast(), table.entityId.asc().nullsLast()),
	check("notifications_entity_type_check", sql`entity_type = ANY (ARRAY['task'::text, 'matter'::text, 'invoice'::text, 'message'::text, 'note'::text, 'file'::text])`),
	index("notifications_unread_idx").using("btree", table.userId.asc().nullsLast(), table.createdAt.desc().nullsFirst()).where(sql`(NOT read)`),
	index("notifications_user_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.userId.asc().nullsLast(), table.createdAt.desc().nullsFirst()),
]);

export const oauthStates = pgTable("oauth_states", {
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	provider: text(),
	redirectUri: text("redirect_uri"),
	returnUrl: text("return_url"),
	state: text().primaryKey().notNull(),
	userId: text("user_id"),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "oauth_states_user_id_fkey"
		}).onDelete("cascade"),
	check("oauth_states_provider_check", sql`provider = ANY (ARRAY['google'::text, 'microsoft'::text])`),
	index("oauth_states_user_id_idx").using("btree", table.userId.asc().nullsLast()),
]);

export const practiceAreas = pgTable("practice_areas", {
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	name: text().notNull(),
	sortOrder: integer("sort_order"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "practice_areas_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "practice_areas_law_firm_id_fkey"
		}).onDelete("cascade"),
	unique("practice_areas_law_firm_id_id_key").on(table.id, table.lawFirmId),
]);

export const rateLimits = pgTable("rate_limits", {
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'date' }).notNull(),
	hits: integer().default(0).notNull(),
	key: text().primaryKey().notNull(),
}, (table) => [
	index("rate_limits_expires_at_idx").using("btree", table.expiresAt.asc().nullsLast()),
]);

export const reminders = pgTable("reminders", {
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	eventId: uuid("event_id"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	invoiceId: uuid("invoice_id"),
	isOptedOut: boolean("is_opted_out").default(false).notNull(),
	lastSentAt: timestamp("last_sent_at", { withTimezone: true, mode: 'date' }),
	lawFirmId: uuid("law_firm_id").notNull(),
	nextRunAt: timestamp("next_run_at", { withTimezone: true, mode: 'date' }),
	preDueDays: integer("pre_due_days"),
	preDueSentAt: timestamp("pre_due_sent_at", { withTimezone: true, mode: 'date' }),
	recentManualSends: timestamp("recent_manual_sends", { withTimezone: true, mode: 'date' }).array().default([]).notNull(),
	sentCount: integer("sent_count").default(0).notNull(),
	signatureParticipantId: text("signature_participant_id"),
	taskId: uuid("task_id"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId, table.eventId],
			foreignColumns: [events.id, events.lawFirmId],
			name: "reminders_law_firm_id_event_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.invoiceId],
			foreignColumns: [invoices.id, invoices.lawFirmId],
			name: "reminders_law_firm_id_invoice_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.signatureParticipantId],
			foreignColumns: [signatureParticipants.id, signatureParticipants.lawFirmId],
			name: "reminders_law_firm_id_signature_participant_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.taskId],
			foreignColumns: [tasks.id, tasks.lawFirmId],
			name: "reminders_law_firm_id_task_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "reminders_law_firm_id_fkey"
		}).onDelete("cascade"),
	uniqueIndex("reminders_event_uq").using("btree", table.lawFirmId.asc().nullsLast(), table.eventId.asc().nullsLast()).where(sql`(event_id IS NOT NULL)`),
	uniqueIndex("reminders_invoice_uq").using("btree", table.lawFirmId.asc().nullsLast(), table.invoiceId.asc().nullsLast()).where(sql`(invoice_id IS NOT NULL)`),
	uniqueIndex("reminders_participant_uq").using("btree", table.lawFirmId.asc().nullsLast(), table.signatureParticipantId.asc().nullsLast()).where(sql`(signature_participant_id IS NOT NULL)`),
	uniqueIndex("reminders_task_uq").using("btree", table.lawFirmId.asc().nullsLast(), table.taskId.asc().nullsLast()).where(sql`(task_id IS NOT NULL)`),
	index("reminders_event_idx").using("btree", table.eventId.asc().nullsLast()).where(sql`(event_id IS NOT NULL)`),
	index("reminders_invoice_idx").using("btree", table.invoiceId.asc().nullsLast()).where(sql`(invoice_id IS NOT NULL)`),
	unique("reminders_law_firm_id_id_key").on(table.id, table.lawFirmId),
	index("reminders_next_run_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.nextRunAt.asc().nullsLast()).where(sql`(next_run_at IS NOT NULL)`),
	check("reminders_parent_ck", sql`num_nonnulls(invoice_id, task_id, event_id, signature_participant_id) = 1`),
	index("reminders_participant_idx").using("btree", table.signatureParticipantId.asc().nullsLast()).where(sql`(signature_participant_id IS NOT NULL)`),
	check("reminders_pre_due_days_check", sql`(pre_due_days IS NULL) OR (pre_due_days >= 0)`),
	check("reminders_sent_count_check", sql`sent_count >= 0`),
	index("reminders_task_idx").using("btree", table.taskId.asc().nullsLast()).where(sql`(task_id IS NOT NULL)`),
]);

export const roles = pgTable("roles", {
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	isBuiltIn: boolean("is_built_in").default(false).notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	name: text().notNull(),
	permissions: text().array().default([""]).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "roles_law_firm_id_fkey"
		}).onDelete("cascade"),
	unique("roles_law_firm_id_id_key").on(table.id, table.lawFirmId),
	unique("roles_law_firm_id_name_key").on(table.lawFirmId, table.name),
	index("roles_perms_gin").using("gin", table.permissions.asc().nullsLast()),
]);

export const signatureAuditEvents = pgTable("signature_audit_events", {
	actorUid: text("actor_uid"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	eventType: text("event_type"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	ip: text(),
	lawFirmId: uuid("law_firm_id").notNull(),
	metadata: jsonb(),
	participantId: text("participant_id"),
	sessionId: uuid("session_id").notNull(),
	userAgent: text("user_agent"),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "signature_audit_events_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.sessionId, table.lawFirmId],
			foreignColumns: [signatureSessions.id, signatureSessions.lawFirmId],
			name: "signature_audit_events_law_firm_id_session_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.sessionId],
			foreignColumns: [signatureSessions.id],
			name: "signature_audit_events_session_id_fkey"
		}).onDelete("cascade"),
	check("signature_audit_events_event_type_check", sql`(event_type IS NULL) OR (event_type = ANY (ARRAY['session.created'::text, 'session.viewed'::text, 'document.viewed'::text, 'consent.given'::text, 'session.completed'::text, 'session.expired'::text, 'session.cancelled'::text, 'participant.declined'::text, 'participant.removed'::text, 'email.sent'::text, 'reminder.sent'::text, 'accesscode.verified'::text, 'accesscode.failed'::text]))`),
	index("signature_audit_events_firm_session_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.sessionId.asc().nullsLast()),
	unique("signature_audit_events_law_firm_id_id_key").on(table.id, table.lawFirmId),
	index("signature_audit_events_session_id_idx").using("btree", table.sessionId.asc().nullsLast(), table.createdAt.asc().nullsLast()),
]);

export const signatureChallenges = pgTable("signature_challenges", {
	attempts: integer().default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'date' }),
	id: uuid().defaultRandom().primaryKey().notNull(),
	kind: text().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	lifetimeAttempts: integer("lifetime_attempts").default(0).notNull(),
	lockedUntil: timestamp("locked_until", { withTimezone: true, mode: 'date' }),
	participantId: text("participant_id").notNull(),
	secretHash: text("secret_hash"),
	sessionId: uuid("session_id").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	verifiedAt: timestamp("verified_at", { withTimezone: true, mode: 'date' }),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId, table.participantId],
			foreignColumns: [signatureParticipants.id, signatureParticipants.lawFirmId],
			name: "signature_challenges_law_firm_id_participant_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.sessionId],
			foreignColumns: [signatureSessions.id, signatureSessions.lawFirmId],
			name: "signature_challenges_law_firm_id_session_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "signature_challenges_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.participantId],
			foreignColumns: [signatureParticipants.id],
			name: "signature_challenges_participant_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.sessionId],
			foreignColumns: [signatureSessions.id],
			name: "signature_challenges_session_id_fkey"
		}).onDelete("cascade"),
	uniqueIndex("signature_challenges_participant_kind_uq").using("btree", table.participantId.asc().nullsLast(), table.kind.asc().nullsLast()),
	index("signature_challenges_firm_part_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.participantId.asc().nullsLast()),
	index("signature_challenges_firm_session_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.sessionId.asc().nullsLast()),
	check("signature_challenges_kind_check", sql`kind = ANY (ARRAY['otp'::text, 'access_code'::text])`),
	unique("signature_challenges_law_firm_id_id_key").on(table.id, table.lawFirmId),
	index("signature_challenges_session_idx").using("btree", table.sessionId.asc().nullsLast()),
]);

export const signatureFields = pgTable("signature_fields", {
	config: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	fieldType: text("field_type"),
	heightPercent: numeric("height_percent"),
	id: text().default(sql`gen_random_uuid()`).notNull(),
	label: text(),
	lawFirmId: uuid("law_firm_id").notNull(),
	page: integer(),
	required: boolean(),
	sessionId: uuid("session_id").notNull(),
	signerId: text("signer_id"),
	sortOrder: integer("sort_order"),
	style: text(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	widthPercent: numeric("width_percent"),
	xPercent: numeric("x_percent"),
	yPercent: numeric("y_percent"),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "signature_fields_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.sessionId, table.lawFirmId],
			foreignColumns: [signatureSessions.id, signatureSessions.lawFirmId],
			name: "signature_fields_law_firm_id_session_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.sessionId],
			foreignColumns: [signatureSessions.id],
			name: "signature_fields_session_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.id, table.sessionId], name: "signature_fields_pkey"}),
	check("signature_fields_field_type_check", sql`(field_type IS NULL) OR (field_type = ANY (ARRAY['signature'::text, 'initials'::text, 'date'::text, 'text'::text, 'checkbox'::text]))`),
	index("signature_fields_firm_session_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.sessionId.asc().nullsLast()),
]);

export const signatureParticipants = pgTable("signature_participants", {
	name: text(),
	// TODO: failed to parse database type 'citext'
	clientUserId: text("client_user_id"),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'date' }),
	consent: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	deliveryMethod: text("delivery_method"),
	email: citext("email"),
	emailVerified: boolean("email_verified").default(false).notNull(),
	facilitatedBy: text("facilitated_by"),
	fieldValues: jsonb("field_values"),
	id: text().default(sql`gen_random_uuid()`).primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	memberUserId: text("member_user_id"),
	requiresVerification: boolean("requires_verification").default(false).notNull(),
	roleLabel: text("role_label"),
	sessionId: uuid("session_id").notNull(),
	signerIp: text("signer_ip"),
	signerName: text("signer_name"),
	signerUid: text("signer_uid"),
	signingOrder: integer("signing_order"),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'date' }),
	status: text().default('waiting').notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	workingObjectPath: text("working_object_path"),
}, (table) => [
	foreignKey({
			columns: [table.clientUserId],
			foreignColumns: [users.id],
			name: "signature_participants_client_user_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.facilitatedBy],
			foreignColumns: [users.id],
			name: "signature_participants_facilitated_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "signature_participants_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.memberUserId],
			foreignColumns: [users.id],
			name: "signature_participants_member_user_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.sessionId, table.lawFirmId],
			foreignColumns: [signatureSessions.id, signatureSessions.lawFirmId],
			name: "signature_participants_law_firm_id_session_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.sessionId],
			foreignColumns: [signatureSessions.id],
			name: "signature_participants_session_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("signature_participants_select", { as: "permissive", for: "select", to: ["authenticated"], using: sql`((client_user_id = (auth.jwt() ->> 'sub'::text)) OR (member_user_id = (auth.jwt() ->> 'sub'::text)) OR rls_is_firm_member(law_firm_id, (auth.jwt() ->> 'sub'::text)))` }),
	index("signature_participants_client_idx").using("btree", table.clientUserId.asc().nullsLast()),
	index("signature_participants_firm_session_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.sessionId.asc().nullsLast()),
	index("signature_participants_firm_status_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.status.asc().nullsLast()),
	unique("signature_participants_law_firm_id_id_key").on(table.id, table.lawFirmId),
	index("signature_participants_member_idx").using("btree", table.memberUserId.asc().nullsLast()),
	index("signature_participants_session_order_idx").using("btree", table.sessionId.asc().nullsLast(), table.signingOrder.asc().nullsLast()),
	check("signature_participants_status_check", sql`status = ANY (ARRAY['active'::text, 'waiting'::text, 'completed'::text, 'declined'::text, 'cancelled'::text, 'expired'::text])`),
]);

export const signatureParticipantTokens = pgTable("signature_participant_tokens", {
	consumedAt: timestamp("consumed_at", { withTimezone: true, mode: 'date' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	deliveryMethod: text("delivery_method"),
	lawFirmId: uuid("law_firm_id").notNull(),
	participantId: text("participant_id").notNull(),
	sessionId: uuid("session_id").notNull(),
	token: text().primaryKey().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "signature_participant_tokens_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.participantId, table.lawFirmId],
			foreignColumns: [signatureParticipants.id, signatureParticipants.lawFirmId],
			name: "signature_participant_tokens_law_firm_id_participant_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.sessionId, table.lawFirmId],
			foreignColumns: [signatureSessions.id, signatureSessions.lawFirmId],
			name: "signature_participant_tokens_law_firm_id_session_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.sessionId],
			foreignColumns: [signatureSessions.id],
			name: "signature_participant_tokens_session_id_fkey"
		}).onDelete("cascade"),
	index("signature_participant_tokens_firm_part_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.participantId.asc().nullsLast()),
	index("signature_participant_tokens_firm_session_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.sessionId.asc().nullsLast()),
	index("signature_participant_tokens_participant_idx").using("btree", table.participantId.asc().nullsLast()),
	index("signature_participant_tokens_session_id_idx").using("btree", table.sessionId.asc().nullsLast()),
]);

export const signatureProcessingJobs = pgTable("signature_processing_jobs", {
	attempt: integer().default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	failureCode: text("failure_code"),
	failureDetail: text("failure_detail"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	inputRevision: text("input_revision"),
	kind: text().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: 'date' }),
	leaseOwner: text("lease_owner"),
	leaseToken: uuid("lease_token"),
	nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	phase: text(),
	phaseState: jsonb("phase_state"),
	sessionId: uuid("session_id"),
	sourceId: uuid("source_id").notNull(),
	status: text().default('queued').notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId, table.sessionId],
			foreignColumns: [signatureSessions.id, signatureSessions.lawFirmId],
			name: "signature_processing_jobs_law_firm_id_session_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.sourceId],
			foreignColumns: [signatureSources.id, signatureSources.lawFirmId],
			name: "signature_processing_jobs_law_firm_id_source_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "signature_processing_jobs_law_firm_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("signature_processing_jobs_select", { as: "permissive", for: "select", to: ["authenticated"], using: sql`rls_is_firm_member(law_firm_id, (auth.jwt() ->> 'sub'::text))` }),
	uniqueIndex("signature_processing_jobs_live_idx").using("btree", sql`law_firm_id`, sql`kind`, sql`source_id`, sql`COALESCE(session_id, '00000000-0000-0000-0000-000000000000'::uu`).where(sql`(status = ANY (ARRAY['queued'::text, 'leased'::text]))`),
	check("signature_processing_jobs_finalize_names_session", sql`(kind <> 'finalize'::text) OR (session_id IS NOT NULL)`),
	index("signature_processing_jobs_firm_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.sourceId.asc().nullsLast(), table.createdAt.desc().nullsFirst()),
	check("signature_processing_jobs_kind_check", sql`kind = ANY (ARRAY['prepare'::text, 'finalize'::text])`),
	unique("signature_processing_jobs_law_firm_id_id_key").on(table.id, table.lawFirmId),
	index("signature_processing_jobs_lease_idx").using("btree", table.leaseExpiresAt.asc().nullsLast()).where(sql`(status = 'leased'::text)`),
	index("signature_processing_jobs_ready_idx").using("btree", table.nextAttemptAt.asc().nullsLast()).where(sql`(status = 'queued'::text)`),
	index("signature_processing_jobs_session_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.sessionId.asc().nullsLast()),
	check("signature_processing_jobs_status_check", sql`status = ANY (ARRAY['queued'::text, 'leased'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])`),
]);

export const signatureSessions = pgTable("signature_sessions", {
	deliveryDocumentHash: text("delivery_document_hash"),
	// TODO: failed to parse database type 'citext'
	auditDetail: text("audit_detail"),
	auditedAt: timestamp("audited_at", { withTimezone: true, mode: 'date' }),
	auditResult: text("audit_result"),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'date' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	currentSignerOrder: integer("current_signer_order"),
	deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: 'date' }),
	deliveryAttempts: integer("delivery_attempts").default(0).notNull(),
	deliveryLeaseExpiresAt: timestamp("delivery_lease_expires_at", { withTimezone: true, mode: 'date' }),
	deliveryOwedAt: timestamp("delivery_owed_at", { withTimezone: true, mode: 'date' }),
	destinationFolderId: uuid("destination_folder_id"),
	destinationLabel: text("destination_label"),
	documentHash: text("document_hash"),
	emailSignersOnComplete: boolean("email_signers_on_complete").default(false).notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'date' }).default(sql`(now() + '30 days'::interval)`).notNull(),
	fileName: text("file_name"),
	finalObjectPath: text("final_object_path"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	notifyEmail: citext("notify_email"),
	notifyName: text("notify_name"),
	objectPath: text("object_path"),
	routingMode: text("routing_mode").default('sequential').notNull(),
	signedDocumentHash: text("signed_document_hash"),
	signedObjectPath: text("signed_object_path"),
	sourceId: uuid("source_id").notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'date' }),
	status: text().default('pending').notNull(),
	token: text().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	workingObjectPath: text("working_object_path"),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "signature_sessions_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId, table.destinationFolderId],
			foreignColumns: [files.id, files.lawFirmId],
			name: "signature_sessions_law_firm_id_destination_folder_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.lawFirmId, table.sourceId],
			foreignColumns: [signatureSources.id, signatureSources.lawFirmId],
			name: "signature_sessions_source_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "signature_sessions_law_firm_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("signature_sessions_select", { as: "permissive", for: "select", to: ["authenticated"], using: sql`rls_is_firm_member(law_firm_id, (auth.jwt() ->> 'sub'::text))` }),
	index("signature_sessions_audit_idx").using("btree", table.auditedAt.asc().nullsFirst(), table.completedAt.asc().nullsLast()).where(sql`(status = 'completed'::text)`),
	check("signature_sessions_audit_result_check", sql`(audit_result IS NULL) OR (audit_result = ANY (ARRAY['ok'::text, 'mismatch'::text, 'unreadable'::text]))`),
	index("signature_sessions_creator_open_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.createdBy.asc().nullsLast(), table.createdAt.desc().nullsFirst()).where(sql`(status = ANY (ARRAY['pending'::text, 'in_progress'::text]))`),
	check("signature_sessions_delivered_requires_owed", sql`(delivered_at IS NULL) OR (delivery_owed_at IS NOT NULL)`),
	index("signature_sessions_delivery_hash_idx").using("btree", table.deliveryDocumentHash.asc().nullsLast()),
	index("signature_sessions_delivery_owed_idx").using("btree", table.deliveryOwedAt.asc().nullsLast()).where(sql`((delivery_owed_at IS NOT NULL) AND (delivered_at IS NULL))`),
	index("signature_sessions_destination_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.destinationFolderId.asc().nullsLast()),
	index("signature_sessions_firm_completed_path_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.objectPath.asc().nullsLast()).where(sql`(status = 'completed'::text)`),
	index("signature_sessions_firm_created_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.createdAt.desc().nullsFirst()),
	unique("signature_sessions_law_firm_id_id_key").on(table.id, table.lawFirmId),
	check("signature_sessions_routing_mode_check", sql`routing_mode = ANY (ARRAY['sequential'::text, 'parallel'::text])`),
	index("signature_sessions_settled_sweep_idx").using("btree", table.updatedAt.asc().nullsLast()).where(sql`(status = ANY (ARRAY['completed'::text, 'cancelled'::text, 'expired'::text]))`),
	index("signature_sessions_signed_hash_idx").using("btree", table.signedDocumentHash.asc().nullsLast()),
	index("signature_sessions_source_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.sourceId.asc().nullsLast()),
	check("signature_sessions_status_check", sql`status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'completed'::text, 'cancelled'::text, 'expired'::text])`),
	index("signature_sessions_status_idx").using("btree", table.status.asc().nullsLast()),
	unique("signature_sessions_token_key").on(table.token),
]);

export const signatureSources = pgTable("signature_sources", {
	objectGeneration: text("object_generation"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	preparedGeneration: text("prepared_generation"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	digestState: text("digest_state"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	digestAlgorithm: text("digest_algorithm"),
	digestLibraryVersion: text("digest_library_version"),
	digestStateBytes: bigint("digest_state_bytes", { mode: "number" }),
	digestStateGeneration: text("digest_state_generation"),
	documentHash: text("document_hash"),
	failureCode: text("failure_code"),
	failureDetail: text("failure_detail"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	objectPath: text("object_path").notNull(),
	operationId: uuid("operation_id"),
	pageCount: integer("page_count"),
	preparedHash: text("prepared_hash"),
	preparedObjectPath: text("prepared_object_path"),
	preparedSizeBytes: bigint("prepared_size_bytes", { mode: "number" }),
	profileVersion: integer("profile_version").default(1).notNull(),
	sizeBytes: bigint("size_bytes", { mode: "number" }),
	status: text().default('pending').notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	uploadedBy: text("uploaded_by"),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "signature_sources_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.uploadedBy],
			foreignColumns: [users.id],
			name: "signature_sources_uploaded_by_fkey"
		}).onDelete("restrict"),
	pgPolicy("signature_sources_select", { as: "permissive", for: "select", to: ["authenticated"], using: sql`rls_is_firm_member(law_firm_id, (auth.jwt() ->> 'sub'::text))` }),
	check("signature_sources_failure_code_check", sql`(failure_code IS NULL) OR (failure_code = ANY (ARRAY['PDF_INVALID'::text, 'PDF_ENCRYPTED'::text, 'PDF_EXISTING_SIGNATURE'::text, 'PDF_UNSUPPORTED_FORM'::text, 'PDF_RESOURCE_LIMIT'::text, 'FILE_TOO_LARGE'::text, 'SOURCE_CHANGED'::text]))`),
	index("signature_sources_firm_status_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.status.asc().nullsLast(), table.createdAt.desc().nullsFirst()),
	unique("signature_sources_law_firm_id_id_key").on(table.id, table.lawFirmId),
	unique("signature_sources_law_firm_id_object_path_key").on(table.lawFirmId, table.objectPath),
	index("signature_sources_preparing_idx").using("btree", table.status.asc().nullsLast(), table.updatedAt.asc().nullsLast()).where(sql`(status = ANY (ARRAY['pending'::text, 'preparing'::text]))`),
	check("signature_sources_status_check", sql`status = ANY (ARRAY['pending'::text, 'preparing'::text, 'ready'::text, 'failed'::text])`),
	index("signature_sources_uploaded_by_idx").using("btree", table.uploadedBy.asc().nullsLast()),
]);

export const signatureTemplates = pgTable("signature_templates", {
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	description: text(),
	fields: jsonb(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	name: text(),
	routingMode: text("routing_mode"),
	signerRoles: jsonb("signer_roles"),
	sourceFileName: text("source_file_name"),
	sourceId: uuid("source_id"),
	sourceObjectPath: text("source_object_path"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "signature_templates_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId, table.sourceId],
			foreignColumns: [signatureSources.id, signatureSources.lawFirmId],
			name: "signature_templates_source_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "signature_templates_law_firm_id_fkey"
		}).onDelete("cascade"),
	unique("signature_templates_law_firm_id_id_key").on(table.id, table.lawFirmId),
	index("signature_templates_source_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.sourceId.asc().nullsLast()),
]);

export const storageReservations = pgTable("storage_reservations", {
	createdBy: text("created_by").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	bytes: bigint({ mode: "number" }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'date' }).notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "storage_reservations_created_by_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "storage_reservations_law_firm_id_fkey"
		}).onDelete("cascade"),
	check("storage_reservations_bytes_check", sql`bytes >= 0`),
	index("storage_reservations_created_by_idx").using("btree", table.createdBy.asc().nullsLast()),
	check("storage_reservations_expiry_after_creation", sql`expires_at > created_at`),
	index("storage_reservations_firm_expiry_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.expiresAt.asc().nullsLast()),
	unique("storage_reservations_law_firm_id_id_key").on(table.id, table.lawFirmId),
]);

export const stripeEvents = pgTable("stripe_events", {
	claimedAt: timestamp("claimed_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	endpoint: text().default('payments').notNull(),
	eventId: text("event_id").notNull(),
	processedAt: timestamp("processed_at", { withTimezone: true, mode: 'date' }),
	status: text().default('processing').notNull(),
}, (table) => [
	primaryKey({ columns: [table.eventId, table.endpoint], name: "stripe_events_pkey"}),
	check("stripe_events_endpoint_check", sql`endpoint = ANY (ARRAY['payments'::text, 'subscriptions'::text])`),
	check("stripe_events_processed_when_done", sql`(status = 'done'::text) = (processed_at IS NOT NULL)`),
	check("stripe_events_status_check", sql`status = ANY (ARRAY['processing'::text, 'done'::text])`),
]);

export const stripeFundRecoveries = pgTable("stripe_fund_recoveries", {
	stripeObjectId: text("stripe_object_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	recoveredCents: bigint("recovered_cents", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	restoredCents: bigint("restored_cents", { mode: "number" }).default(0).notNull(),
	source: text().notNull(),
	stripePaymentIntentId: text("stripe_payment_intent_id").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "stripe_fund_recoveries_law_firm_id_fkey"
		}).onDelete("cascade"),
	unique("stripe_fund_recoveries_law_firm_id_id_key").on(table.id, table.lawFirmId),
	index("stripe_fund_recoveries_payment_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.stripePaymentIntentId.asc().nullsLast()),
	check("stripe_fund_recoveries_recovered_cents_check", sql`recovered_cents > 0`),
	check("stripe_fund_recoveries_restored_cents_check", sql`(restored_cents >= 0) AND (restored_cents <= recovered_cents)`),
	check("stripe_fund_recoveries_source_check", sql`source = ANY (ARRAY['trust_transfer'::text, 'firm_transfer'::text, 'firm_card'::text])`),
	unique("stripe_fund_recoveries_stripe_object_id_key").on(table.stripeObjectId),
]);

export const taskAssignees = pgTable("task_assignees", {
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	taskId: uuid("task_id").notNull(),
	userId: text("user_id").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId, table.taskId],
			foreignColumns: [tasks.id, tasks.lawFirmId],
			name: "task_assignees_law_firm_id_task_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "task_assignees_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "task_assignees_user_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.taskId, table.userId], name: "task_assignees_pkey"}),
	index("task_assignees_firm_task_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.taskId.asc().nullsLast()),
	index("task_assignees_firm_user_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.userId.asc().nullsLast()),
	index("task_assignees_user_idx").using("btree", table.userId.asc().nullsLast()),
]);

export const taskClients = pgTable("task_clients", {
	clientId: uuid("client_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	taskId: uuid("task_id").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.clientId],
			foreignColumns: [clients.id],
			name: "task_clients_client_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.taskId],
			foreignColumns: [tasks.id, tasks.lawFirmId],
			name: "task_clients_law_firm_id_task_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "task_clients_law_firm_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.taskId, table.clientId], name: "task_clients_pkey"}),
	index("task_clients_client_idx").using("btree", table.clientId.asc().nullsLast()),
	index("task_clients_firm_task_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.taskId.asc().nullsLast()),
]);

export const taskDependencies = pgTable("task_dependencies", {
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	dependsOnTaskId: uuid("depends_on_task_id").notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	taskId: uuid("task_id").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId, table.dependsOnTaskId],
			foreignColumns: [tasks.id, tasks.lawFirmId],
			name: "task_dependencies_law_firm_id_depends_on_task_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId, table.taskId],
			foreignColumns: [tasks.id, tasks.lawFirmId],
			name: "task_dependencies_law_firm_id_task_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "task_dependencies_law_firm_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.taskId, table.dependsOnTaskId], name: "task_dependencies_pkey"}),
	check("task_dependencies_check", sql`task_id <> depends_on_task_id`),
	index("task_dependencies_depends_on_idx").using("btree", table.dependsOnTaskId.asc().nullsLast()),
	index("task_dependencies_firm_depends_on_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.dependsOnTaskId.asc().nullsLast()),
	index("task_dependencies_firm_task_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.taskId.asc().nullsLast()),
]);

export const taskReminderDeliveries = pgTable("task_reminder_deliveries", {
	claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true, mode: 'date' }),
	claimToken: uuid("claim_token"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lastSentAt: timestamp("last_sent_at", { withTimezone: true, mode: 'date' }),
	lawFirmId: uuid("law_firm_id").notNull(),
	recipientKey: text("recipient_key").notNull(),
	sentCount: integer("sent_count").default(0).notNull(),
	taskId: uuid("task_id").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId, table.taskId],
			foreignColumns: [tasks.id, tasks.lawFirmId],
			name: "task_reminder_deliveries_law_firm_id_task_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "task_reminder_deliveries_law_firm_id_fkey"
		}).onDelete("cascade"),
	check("task_reminder_deliveries_check", sql`(claim_token IS NULL) = (claim_expires_at IS NULL)`),
	unique("task_reminder_deliveries_law_firm_id_id_key").on(table.id, table.lawFirmId),
	unique("task_reminder_deliveries_law_firm_id_task_id_recipient_key_key").on(table.lawFirmId, table.taskId, table.recipientKey),
	check("task_reminder_deliveries_sent_count_check", sql`sent_count >= 0`),
]);

export const tasks = pgTable("tasks", {
	allDay: boolean("all_day").default(false).notNull(),
	calendarSync: jsonb("calendar_sync"),
	courtId: uuid("court_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	description: text(),
	dueAt: timestamp("due_at", { withTimezone: true, mode: 'date' }),
	dueDate: date("due_date"),
	dueDateTimezone: text("due_date_timezone"),
	endsAt: timestamp("ends_at", { withTimezone: true, mode: 'date' }),
	googleCalendarId: text("google_calendar_id"),
	googleEventId: text("google_event_id"),
	googleLastModified: timestamp("google_last_modified", { withTimezone: true, mode: 'date' }),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lastSyncedToGoogle: timestamp("last_synced_to_google", { withTimezone: true, mode: 'date' }),
	lastSyncedToOutlook: timestamp("last_synced_to_outlook", { withTimezone: true, mode: 'date' }),
	lawFirmId: uuid("law_firm_id").notNull(),
	location: text(),
	matterId: uuid("matter_id"),
	outlookChangeKey: text("outlook_change_key"),
	outlookId: text("outlook_id"),
	outlookLastModified: timestamp("outlook_last_modified", { withTimezone: true, mode: 'date' }),
	practiceAreaId: uuid("practice_area_id"),
	priority: text().default('medium').notNull(),
	recurrence: jsonb(),
	reminderRecipientIds: text("reminder_recipient_ids").array().default([""]).notNull(),
	sendReminderEarly: boolean("send_reminder_early").default(false).notNull(),
	source: text(),
	status: text().default('open').notNull(),
	title: text().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.courtId],
			foreignColumns: [courts.id],
			name: "tasks_court_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "tasks_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId, table.matterId],
			foreignColumns: [matters.id, matters.lawFirmId],
			name: "tasks_law_firm_id_matter_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "tasks_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.practiceAreaId],
			foreignColumns: [practiceAreas.id],
			name: "tasks_practice_area_id_fkey"
		}).onDelete("set null"),
	index("tasks_court_idx").using("btree", table.courtId.asc().nullsLast()).where(sql`(court_id IS NOT NULL)`),
	index("tasks_created_by_idx").using("btree", table.createdBy.asc().nullsLast()).where(sql`(created_by IS NOT NULL)`),
	index("tasks_desc_trgm_idx").using("gin", table.description.asc().nullsLast()),
	check("tasks_ends_after_start", sql`(ends_at IS NULL) OR ((due_date IS NOT NULL) AND (ends_at > COALESCE(due_at, ((due_date + '12:00:00'::time without time zone) AT TIME ZONE 'UTC'::text))))`),
	index("tasks_firm_created_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.createdAt.desc().nullsFirst(), table.id.asc().nullsLast()),
	index("tasks_firm_due_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.dueDate.asc().nullsLast()),
	index("tasks_firm_matter_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.matterId.asc().nullsLast()),
	index("tasks_firm_status_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.status.asc().nullsLast()),
	index("tasks_firm_title_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.title.asc().nullsLast()),
	unique("tasks_law_firm_id_id_key").on(table.id, table.lawFirmId),
	index("tasks_practice_area_idx").using("btree", table.practiceAreaId.asc().nullsLast()).where(sql`(practice_area_id IS NOT NULL)`),
	check("tasks_status_check", sql`status = ANY (ARRAY['open'::text, 'in_progress'::text, 'completed'::text, 'blocked'::text])`),
	index("tasks_title_trgm_idx").using("gin", table.title.asc().nullsLast()),
]);

export const taskSubtasks = pgTable("task_subtasks", {
	assigneeUserId: text("assignee_user_id"),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'date' }),
	completedBy: text("completed_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	isCompleted: boolean("is_completed").default(false).notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
	taskId: uuid("task_id").notNull(),
	title: text().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.assigneeUserId],
			foreignColumns: [users.id],
			name: "task_subtasks_assignee_user_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.completedBy],
			foreignColumns: [users.id],
			name: "task_subtasks_completed_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "task_subtasks_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.taskId],
			foreignColumns: [tasks.id],
			name: "task_subtasks_task_id_fkey"
		}).onDelete("cascade"),
	index("task_subtasks_assignee_user_id_idx").using("btree", table.assigneeUserId.asc().nullsLast()),
	unique("task_subtasks_law_firm_id_id_key").on(table.id, table.lawFirmId),
	index("task_subtasks_task_idx").using("btree", table.taskId.asc().nullsLast(), table.sortOrder.asc().nullsLast()),
]);

export const templateFieldPlacements = pgTable("template_field_placements", {
	bold: boolean().default(false).notNull(),
	bulletList: boolean("bullet_list").default(false).notNull(),
	color: text().default('#000000').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	fieldName: text("field_name").notNull(),
	fieldType: text("field_type").default('text').notNull(),
	fontFamily: text("font_family").default('times').notNull(),
	fontSize: numeric("font_size"),
	heightPercent: numeric("height_percent").notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	imageMimeType: text("image_mime_type"),
	imageObjectPath: text("image_object_path"),
	italic: boolean().default(false).notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	page: integer().notNull(),
	repeaterName: text("repeater_name"),
	repeaterRowIndex: integer("repeater_row_index"),
	richText: jsonb("rich_text"),
	sortOrder: integer("sort_order").default(0).notNull(),
	templateId: uuid("template_id").notNull(),
	textAlign: text("text_align").default('left').notNull(),
	textContent: text("text_content"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	widthPercent: numeric("width_percent").notNull(),
	xPercent: numeric("x_percent").notNull(),
	yPercent: numeric("y_percent").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "template_field_placements_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.templateId],
			foreignColumns: [templates.id],
			name: "template_field_placements_template_id_fkey"
		}).onDelete("cascade"),
	check("template_field_placements_field_type_check", sql`field_type = ANY (ARRAY['text'::text, 'date'::text, 'checkbox'::text, 'textbox'::text, 'image'::text])`),
	check("template_field_placements_font_family_check", sql`font_family = ANY (ARRAY['helvetica'::text, 'times'::text, 'courier'::text, 'calibri'::text, 'cambria'::text, 'pt-serif'::text, 'pt-sans'::text])`),
	index("template_field_placements_template_id_idx").using("btree", table.templateId.asc().nullsLast()),
	check("template_field_placements_text_align_check", sql`text_align = ANY (ARRAY['left'::text, 'center'::text, 'right'::text])`),
]);

export const templateFolders = pgTable("template_folders", {
	color: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	name: text().notNull(),
	parentFolderId: uuid("parent_folder_id"),
	sortOrder: integer("sort_order"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "template_folders_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.parentFolderId],
			foreignColumns: [table.id],
			name: "template_folders_parent_folder_id_fkey"
		}).onDelete("set null"),
	index("template_folders_sibling_name_idx").using("btree", sql`law_firm_id`, sql`parent_folder_id`, sql`lower(name)`),
]);

export const templates = pgTable("templates", {
	assets: jsonb().default([]).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	docxObjectPath: text("docx_object_path"),
	fields: text().array().default([""]).notNull(),
	folderId: uuid("folder_id"),
	htmlObjectPath: text("html_object_path"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	name: text().notNull(),
	overlayPdfObjectPath: text("overlay_pdf_object_path"),
	overlaySourceObjectPath: text("overlay_source_object_path"),
	repeaters: jsonb().default([]).notNull(),
	type: text().default('html').notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.folderId],
			foreignColumns: [templateFolders.id],
			name: "templates_folder_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "templates_law_firm_id_fkey"
		}).onDelete("cascade"),
	index("templates_firm_folder_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.folderId.asc().nullsLast()),
	check("templates_type_check", sql`type = ANY (ARRAY['html'::text, 'docx'::text, 'overlay'::text])`),
]);

export const trustAccounts = pgTable("trust_accounts", {
	status: text().default('active').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	accountNumberLast4: text("account_number_last4"),
	accountType: text("account_type").default('iolta').notNull(),
	bankName: text("bank_name"),
	bookBalanceCents: bigint("book_balance_cents", { mode: "number" }).default(0).notNull(),
	bookCloseDate: date("book_close_date"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	interestBeneficiary: text("interest_beneficiary"),
	ioltaTin: text("iolta_tin"),
	lawFirmId: uuid("law_firm_id").notNull(),
	name: text().notNull(),
	routingNumberLast4: text("routing_number_last4"),
	stripeChargesEnabled: boolean("stripe_charges_enabled").default(false).notNull(),
	stripeConnectedAccountId: text("stripe_connected_account_id"),
	stripeOnboardingComplete: boolean("stripe_onboarding_complete").default(false).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	updatedBy: text("updated_by"),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "trust_accounts_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "trust_accounts_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.updatedBy],
			foreignColumns: [users.id],
			name: "trust_accounts_updated_by_fkey"
		}).onDelete("restrict"),
	uniqueIndex("trust_accounts_stripe_acct_uidx").using("btree", table.stripeConnectedAccountId.asc().nullsLast()).where(sql`(stripe_connected_account_id IS NOT NULL)`),
	check("trust_accounts_account_number_last4_check", sql`(account_number_last4 IS NULL) OR (account_number_last4 ~ '^[0-9]{4}$'::text)`),
	check("trust_accounts_account_type_check", sql`account_type = ANY (ARRAY['iolta'::text, 'trust'::text, 'separate_interest'::text])`),
	check("trust_accounts_book_balance_nonneg", sql`book_balance_cents >= 0`),
	check("trust_accounts_interest_beneficiary_check", sql`(interest_beneficiary IS NULL) OR (interest_beneficiary = ANY (ARRAY['bar_foundation'::text, 'client'::text, 'firm'::text]))`),
	unique("trust_accounts_law_firm_id_id_key").on(table.id, table.lawFirmId),
	check("trust_accounts_status_check", sql`status = ANY (ARRAY['active'::text, 'inactive'::text])`),
]);

export const trustDepositFees = pgTable("trust_deposit_fees", {
	trustTransactionId: uuid("trust_transaction_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	feeCents: bigint("fee_cents", { mode: "number" }).notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	status: text().default('accrued').notNull(),
	stripeInvoiceId: text("stripe_invoice_id"),
	stripeInvoiceItemId: text("stripe_invoice_item_id"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "trust_deposit_fees_law_firm_id_fkey"
		}).onDelete("cascade"),
	check("trust_deposit_fees_fee_cents_check", sql`fee_cents >= 0`),
	unique("trust_deposit_fees_law_firm_id_trust_transaction_id_key").on(table.lawFirmId, table.trustTransactionId),
	check("trust_deposit_fees_status_check", sql`status = ANY (ARRAY['accrued'::text, 'billed'::text, 'waived'::text])`),
]);

export const trustInterestRemittances = pgTable("trust_interest_remittances", {
	periodEnd: date("period_end"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	interestEarnedCents: bigint("interest_earned_cents", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amountRemittedCents: bigint("amount_remitted_cents", { mode: "number" }).default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	notes: text(),
	periodStart: date("period_start"),
	referenceNumber: text("reference_number"),
	remittanceDate: date("remittance_date"),
	remittedTo: text("remitted_to"),
	status: text().default('pending').notNull(),
	trustAccountId: uuid("trust_account_id").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	updatedBy: text("updated_by"),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "trust_interest_remittances_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId, table.trustAccountId],
			foreignColumns: [trustAccounts.id, trustAccounts.lawFirmId],
			name: "trust_interest_remittances_law_firm_id_trust_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "trust_interest_remittances_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.updatedBy],
			foreignColumns: [users.id],
			name: "trust_interest_remittances_updated_by_fkey"
		}).onDelete("restrict"),
	index("trust_interest_remit_account_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.trustAccountId.asc().nullsLast(), table.periodEnd.desc().nullsFirst()),
	check("trust_interest_remittances_status_check", sql`status = ANY (ARRAY['pending'::text, 'remitted'::text])`),
]);

export const trustMinimumBalances = pgTable("trust_minimum_balances", {
	trustAccountId: uuid("trust_account_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	clientId: uuid("client_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	minimumCents: bigint("minimum_cents", { mode: "number" }).default(0).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	updatedBy: text("updated_by"),
}, (table) => [
	foreignKey({
			columns: [table.clientId],
			foreignColumns: [clients.id],
			name: "trust_minimum_balances_client_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "trust_minimum_balances_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId, table.trustAccountId],
			foreignColumns: [trustAccounts.id, trustAccounts.lawFirmId],
			name: "trust_minimum_balances_law_firm_id_trust_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "trust_minimum_balances_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.updatedBy],
			foreignColumns: [users.id],
			name: "trust_minimum_balances_updated_by_fkey"
		}).onDelete("restrict"),
	index("trust_minimum_balances_client_id_idx").using("btree", table.clientId.asc().nullsLast()),
	unique("trust_minimum_balances_law_firm_id_client_id_trust_account__key").on(table.lawFirmId, table.clientId, table.trustAccountId),
	check("trust_minimum_balances_minimum_cents_check", sql`minimum_cents >= 0`),
]);

export const trustReconciliations = pgTable("trust_reconciliations", {
	reconciliationDate: date("reconciliation_date").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	bankStatementBalanceCents: bigint("bank_statement_balance_cents", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	bookBalanceCents: bigint("book_balance_cents", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	isReconciled: boolean("is_reconciled").default(false).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	adjustments: jsonb().default([]).notNull(),
	clientLedgerTotalCents: bigint("client_ledger_total_cents", { mode: "number" }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	discrepancyCents: bigint("discrepancy_cents", { mode: "number" }).notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	notes: text(),
	outstandingTransactionIds: uuid("outstanding_transaction_ids").array(),
	reconciledAt: timestamp("reconciled_at", { withTimezone: true, mode: 'date' }),
	reconciledBy: text("reconciled_by"),
	trustAccountId: uuid("trust_account_id").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "trust_reconciliations_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId, table.trustAccountId],
			foreignColumns: [trustAccounts.id, trustAccounts.lawFirmId],
			name: "trust_reconciliations_law_firm_id_trust_account_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "trust_reconciliations_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.reconciledBy],
			foreignColumns: [users.id],
			name: "trust_reconciliations_reconciled_by_fkey"
		}).onDelete("restrict"),
	index("trust_recon_firm_account_date_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.trustAccountId.asc().nullsLast(), table.reconciliationDate.desc().nullsFirst(), table.createdAt.desc().nullsFirst(), table.id.desc().nullsFirst()),
	index("trust_recon_firm_date_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.reconciliationDate.desc().nullsFirst(), table.createdAt.desc().nullsFirst(), table.id.desc().nullsFirst()),
]);

export const trustTransactions = pgTable("trust_transactions", {
	type: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	status: text().default('completed').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	clientBalanceAfterCents: bigint("client_balance_after_cents", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	accountBalanceAfterCents: bigint("account_balance_after_cents", { mode: "number" }),
	amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
	chargeModel: text("charge_model").default('destination').notNull(),
	clearedAt: timestamp("cleared_at", { withTimezone: true, mode: 'date' }),
	clearedInReconciliationId: uuid("cleared_in_reconciliation_id"),
	clientId: uuid("client_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	description: text(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	invoiceId: uuid("invoice_id"),
	lawFirmId: uuid("law_firm_id").notNull(),
	matterId: uuid("matter_id"),
	payee: text(),
	referenceNumber: text("reference_number"),
	reversesTransactionId: uuid("reverses_transaction_id"),
	source: text(),
	stripePaymentIntentId: text("stripe_payment_intent_id"),
	stripeSessionId: text("stripe_session_id"),
	transferGroupId: uuid("transfer_group_id"),
	transferTo: text("transfer_to"),
	transferToAccountId: uuid("transfer_to_account_id"),
	trustAccountId: uuid("trust_account_id").notNull(),
	txnDate: date("txn_date").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	voidedAt: timestamp("voided_at", { withTimezone: true, mode: 'date' }),
	voidedBy: text("voided_by"),
	voidReason: text("void_reason"),
}, (table) => [
	foreignKey({
			columns: [table.clientId],
			foreignColumns: [clients.id],
			name: "trust_transactions_client_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "trust_transactions_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId, table.invoiceId],
			foreignColumns: [invoices.id, invoices.lawFirmId],
			name: "trust_txn_invoice_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.lawFirmId, table.matterId],
			foreignColumns: [matters.id, matters.lawFirmId],
			name: "trust_transactions_law_firm_id_matter_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.lawFirmId, table.transferToAccountId],
			foreignColumns: [trustAccounts.id, trustAccounts.lawFirmId],
			name: "trust_transactions_law_firm_id_transfer_to_account_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId, table.trustAccountId],
			foreignColumns: [trustAccounts.id, trustAccounts.lawFirmId],
			name: "trust_transactions_law_firm_id_trust_account_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "trust_transactions_law_firm_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.reversesTransactionId],
			foreignColumns: [table.id],
			name: "trust_transactions_reverses_transaction_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.voidedBy],
			foreignColumns: [users.id],
			name: "trust_transactions_voided_by_fkey"
		}).onDelete("restrict"),
	uniqueIndex("trust_txn_stripe_pi_uidx").using("btree", table.lawFirmId.asc().nullsLast(), table.stripePaymentIntentId.asc().nullsLast()).where(sql`((stripe_payment_intent_id IS NOT NULL) AND (status <> 'void'::text))`),
	uniqueIndex("trust_txn_stripe_session_uidx").using("btree", table.lawFirmId.asc().nullsLast(), table.stripeSessionId.asc().nullsLast()).where(sql`(stripe_session_id IS NOT NULL)`),
	check("trust_transactions_amount_cents_check", sql`amount_cents > 0`),
	check("trust_transactions_charge_model_check", sql`charge_model = ANY (ARRAY['destination'::text, 'direct'::text])`),
	index("trust_transactions_client_id_idx").using("btree", table.clientId.asc().nullsLast()),
	index("trust_transactions_invoice_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.invoiceId.asc().nullsLast()).where(sql`(invoice_id IS NOT NULL)`),
	index("trust_transactions_matter_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.matterId.asc().nullsLast()).where(sql`(matter_id IS NOT NULL)`),
	check("trust_transactions_source_check", sql`source = ANY (ARRAY['check'::text, 'wire'::text, 'ach'::text, 'cash'::text, 'credit_card'::text, 'interest'::text, 'stripe'::text, 'other'::text])`),
	check("trust_transactions_status_check", sql`status = ANY (ARRAY['completed'::text, 'pending'::text, 'void'::text])`),
	check("trust_transactions_transfer_to_check", sql`transfer_to = ANY (ARRAY['operating'::text, 'other'::text])`),
	check("trust_transactions_type_check", sql`type = ANY (ARRAY['deposit'::text, 'withdrawal'::text, 'transfer'::text, 'refund'::text])`),
	index("trust_txn_account_balance_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.trustAccountId.asc().nullsLast(), table.clientId.asc().nullsLast(), table.status.asc().nullsLast(), table.type.asc().nullsLast(), table.amountCents.asc().nullsLast()).where(sql`(status <> 'void'::text)`),
	index("trust_txn_client_balance_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.clientId.asc().nullsLast(), table.trustAccountId.asc().nullsLast(), table.status.asc().nullsLast(), table.type.asc().nullsLast(), table.amountCents.asc().nullsLast()).where(sql`(status <> 'void'::text)`),
	index("trust_txn_firm_account_date_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.trustAccountId.asc().nullsLast(), table.txnDate.desc().nullsFirst()),
	index("trust_txn_firm_client_date_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.clientId.asc().nullsLast(), table.txnDate.desc().nullsFirst()),
	index("trust_txn_firm_date_created_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.txnDate.desc().nullsFirst(), table.createdAt.desc().nullsFirst()),
	index("trust_txn_transfer_group_idx").using("btree", table.transferGroupId.asc().nullsLast()).where(sql`(transfer_group_id IS NOT NULL)`),
	index("trust_txn_uncleared_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.trustAccountId.asc().nullsLast()).where(sql`((status = 'completed'::text) AND (cleared_at IS NULL))`),
]);

export const userOauthTokens = pgTable("user_oauth_tokens", {
	accessToken: text("access_token"),
	appCalendarId: text("app_calendar_id"),
	calendarId: text("calendar_id"),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'date' }),
	isSyncFromProvider: boolean("is_sync_from_provider").default(false).notNull(),
	isSyncToProvider: boolean("is_sync_to_provider").default(false).notNull(),
	meta: jsonb().default({}).notNull(),
	provider: text().notNull(),
	refreshToken: text("refresh_token"),
	scope: text(),
	syncCursor: text("sync_cursor"),
	tokenUpdatedAt: timestamp("token_updated_at", { withTimezone: true, mode: 'date' }),
	userId: text("user_id").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "user_oauth_tokens_user_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.userId, table.provider], name: "user_oauth_tokens_pkey"}),
	check("user_oauth_tokens_provider_check", sql`provider = ANY (ARRAY['google'::text, 'microsoft'::text])`),
]);

export const users = pgTable("users", {
	id: text().primaryKey().notNull(),
	// TODO: failed to parse database type 'citext'
	consentIp: text("consent_ip"),
	consentVersion: text("consent_version"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'date' }),
	email: citext("email").notNull(),
	identityErasedAt: timestamp("identity_erased_at", { withTimezone: true, mode: 'date' }),
	isAdmin: boolean("is_admin").default(false).notNull(),
	name: text(),
	photoObjectPath: text("photo_object_path"),
	preferences: jsonb().default({}).notNull(),
	privacyAcceptedAt: timestamp("privacy_accepted_at", { withTimezone: true, mode: 'date' }),
	termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true, mode: 'date' }),
	timezone: text(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	userType: text("user_type").default('pending').notNull(),
}, (table) => [
	index("users_created_at_idx").using("btree", table.createdAt.desc().nullsFirst()),
	index("users_email_idx").using("btree", table.email.asc().nullsLast()),
	index("users_email_trgm_idx").using("gin", sql`((email)::text)`),
	index("users_lower_email_idx").using("btree", sql`lower((email)::text)`),
	index("users_name_trgm_idx").using("gin", table.name.asc().nullsLast()),
	index("users_pending_erasure_idx").using("btree", table.deletedAt.asc().nullsLast()).where(sql`((deleted_at IS NOT NULL) AND (identity_erased_at IS NULL))`),
	check("users_user_type_check", sql`user_type = ANY (ARRAY['firm_member'::text, 'client'::text, 'pending'::text])`),
]);

export const utbmsCodes = pgTable("utbms_codes", {
	code: text().notNull(),
	codeType: text("code_type").notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	isActive: boolean("is_active").default(true).notNull(),
	name: text().notNull(),
	practiceSet: text("practice_set"),
}, (table) => [
	unique("utbms_codes_code_key").on(table.code),
	check("utbms_codes_code_type_check", sql`code_type = ANY (ARRAY['task'::text, 'activity'::text, 'expense'::text])`),
	index("utbms_codes_type_idx").using("btree", table.codeType.asc().nullsLast(), table.practiceSet.asc().nullsLast()),
]);

export const wordTemplates = pgTable("word_templates", {
	assets: jsonb().default([]).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	createdBy: text("created_by"),
	fields: text().array().default([""]).notNull(),
	htmlObjectPath: text("html_object_path"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	lawFirmId: uuid("law_firm_id").notNull(),
	name: text().notNull(),
	originalFileName: text("original_file_name"),
	repeaters: jsonb().default([]).notNull(),
	sourceObjectPath: text("source_object_path"),
	type: text().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "word_templates_created_by_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.lawFirmId],
			foreignColumns: [lawFirms.id],
			name: "word_templates_law_firm_id_fkey"
		}).onDelete("cascade"),
	uniqueIndex("word_templates_firm_type_name_key").using("btree", sql`law_firm_id`, sql`type`, sql`lower(name)`).where(sql`(type = ANY (ARRAY['docx'::text, 'pdf-form'::text]))`),
	check("word_templates_body_present", sql`((type = 'html'::text) AND (html_object_path IS NOT NULL) AND (source_object_path IS NULL)) OR ((type = ANY (ARRAY['docx'::text, 'pdf-form'::text])) AND (source_object_path IS NOT NULL) AND (html_object_path IS NULL))`),
	index("word_templates_created_by_idx").using("btree", table.createdBy.asc().nullsLast()),
	index("word_templates_firm_name_idx").using("btree", table.lawFirmId.asc().nullsLast(), table.name.asc().nullsLast()),
	unique("word_templates_law_firm_id_id_key").on(table.id, table.lawFirmId),
	check("word_templates_name_check", sql`(length(btrim(name)) >= 1) AND (length(btrim(name)) <= 200)`),
	check("word_templates_original_file_name_check", sql`(original_file_name IS NULL) OR (length(original_file_name) <= 255)`),
	check("word_templates_type_check", sql`type = ANY (ARRAY['html'::text, 'docx'::text, 'pdf-form'::text])`),
]);
