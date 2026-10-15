/**
 * ENTITY ID HANDLING, swept across the matters/tasks/clients/contacts/leads slice.
 *
 * This is not a per-module spec. It pins ONE pair of invariants over every route
 * in that slice that takes an entity id in its path, driven from a single table
 * so a route added tomorrow is one line rather than a new file.
 *
 *   (1) A MALFORMED id is REFUSED, never a 500. Those columns are uuid, so a
 *       value that is not a uuid reaches Postgres as a 22P02 cast error unless
 *       the code guards it. A 500 tells the caller the server is broken when the
 *       request was, and it is logged and alerted on as a server fault.
 *
 *   (2) ANOTHER FIRM'S id is NEVER served. A real entity is seeded in firm B and
 *       then addressed through firm A's URL as firm A's owner. The answer must be
 *       404 or 403, and firm B's data must be byte-identical afterwards. Status
 *       alone is not enough: a route that answers 404 after writing has already
 *       leaked. The whole of firm B is fingerprinted either side of the call.
 *
 * WHY THE THIRD ASSERTION IN EVERY CROSS-FIRM CASE. Each cross-firm test ends by
 * repeating the SAME request with firm A's OWN id and asserting it succeeds. A
 * refusal that happens because the body failed validation, or because the URL was
 * wrong, proves nothing about the id; the control is what proves the request
 * reached the id at all. It runs after the cross-firm call so the pristine world
 * is what the leak check sees.
 *
 * Fixtures are plain SQL through the test pool. A fixture built by the code under
 * test cannot fail when that code is wrong.
 *
 * SKIPPED, with reasons. These routes carry a path id but are not swept here:
 *
 *   POST /matters/:matterId/notes/:noteId/links/file
 *     The body is a GCS object path, not an id, and the service resolves it
 *     against a live bucket-backed `files` row. The control could not be made
 *     green without a storage fixture, and a case whose control is red proves
 *     nothing about the path id.
 *   POST /client-portal/lawfirm/:lawFirmId/matters/:matterId/documents
 *   POST /client-portal/.../document-requests/:requestId/items/:itemId/fulfill
 *   GET/DELETE /client-portal/.../fulfillments/:fulfillmentId
 *     multipart/form-data uploads through multer. Reaching the id needs a real
 *     file part, and the fulfillment routes additionally need a stored object.
 *   POST /client-portal/lawfirm/:lawFirmId/matters/:matterId/documents/refresh-url
 *     Same as links/file: keyed by object path against live storage.
 *   Every route whose only path id is `:lawFirmId`
 *     `:lawFirmId` is the tenant itself, gated by verifyToken + the membership
 *     assertion rather than by an entity lookup. tests/tenancy covers it.
 *   POST /leads/:leadId/send-intake-form
 *     Swept for `:leadId`. The template id it also takes is in the BODY, not the
 *     path, so it is outside this sweep's stated invariant.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  createFirmMember,
  ownerOf,
  createPortalUser,
  as,
  tokenFor,
  drainEvents,
  type Actor,
} from '../support/setupInProcess';
import {
  MALFORMED_ID, absentId, firmFingerprint, refusalVerdict, rowJson,
} from '../support/idSweep';

jest.setTimeout(120_000);

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type Ids = Record<string, string>;

interface World {
  firmId: string;
  owner: Actor;
  portal: Actor;
  ids: Ids;
}

/**
 * The table each path param names. Used to read back the exact firm B row a
 * cross-firm request targeted, so "unchanged" is asserted on the row itself and
 * not only on the firm-wide fingerprint.
 */
const PARAM_TABLE: Record<string, string> = {
  matterId: 'matters',
  taskId: 'tasks',
  clientId: 'clients',
  contactId: 'contacts',
  leadId: 'leads',
  leadStageId: 'lead_stages',
  intakeTemplateId: 'intake_form_templates',
  categoryId: 'matter_categories',
  fieldDefId: 'matter_field_defs',
  pipelineId: 'matter_stage_pipelines',
  stageId: 'matter_stages',
  deadlineTemplateId: 'deadline_set_templates',
  matterNoteId: 'notes',
  matterReplyId: 'note_replies',
  matterNoteLinkId: 'note_links',
  matterTimeEntryId: 'activities',
  taskNoteId: 'notes',
  taskReplyId: 'note_replies',
  taskTimeEntryId: 'activities',
  clientNoteId: 'notes',
  clientReplyId: 'note_replies',
  clientTimeEntryId: 'activities',
  matterEventId: 'events',
  clientEventId: 'events',
  matterContactLinkId: 'matter_contacts',
  clientContactLinkId: 'contact_clients',
  subtaskId: 'task_subtasks',
  // recurrenceGroupId is deliberately absent: `events.recurrence_group_id`
  // is a TEXT column and names a SET of events, not one row, so there is no row
  // to read back. The firm-wide fingerprint is what proves nothing moved, and the
  // malformed case there is about the route refusing an unknown group rather than
  // about a uuid cast.
  invoiceId: 'invoices',
  notificationId: 'notifications',
};

/**
 * Every tenant-scoped table this slice writes. The fingerprint below is taken
 * over all of them, so a cross-firm request that creates, edits or deletes
 * ANYTHING in firm B is caught even when the row it touched is not the one the
 * URL named.
 */
const FIRM_TABLES = [
  'matters', 'matter_clients', 'matter_members', 'matter_contacts', 'events',
  'notes', 'note_replies', 'note_links', 'note_versions',
  'matter_categories', 'matter_field_defs', 'matter_stages', 'matter_stage_pipelines',
  'deadline_set_templates', 'tasks', 'task_subtasks',
  'clients', 'client_company_links', 'contact_clients',
  'contacts', 'leads', 'lead_stages', 'intake_form_templates',
  'activities', 'invoices', 'notifications',
];

const fingerprint = (lawFirmId: string) => firmFingerprint(FIRM_TABLES, lawFirmId);

/**
 * One firm, fully populated: every entity this sweep addresses by id, wired to
 * each other the way the routes expect to find them.
 */
async function seedWorld(label: string): Promise<World> {
  const firm = await createFirm({ name: `Firm ${label}` });
  const owner = await ownerOf(firm.id);
  const { uid: portalUid } = await createPortalUser();
  const q = (sql: string, params: any[] = []) => testPool.query(sql, params);

  const ids: Ids = {
    practiceAreaId: randomUUID(),
    matterId: randomUUID(),
    taskId: randomUUID(),
    // A second task, so the seeded note->task link does not occupy the pair the
    // `links/task` control needs (matter_note_links_task_uniq is on
    // (note_id, task_id)). Without it that control hit the unique index and the
    // case reported a 500 that had nothing to do with the id under test.
    linkedTaskId: randomUUID(),
    clientId: randomUUID(),
    contactId: randomUUID(),
    leadId: randomUUID(),
    leadStageId: randomUUID(),
    intakeTemplateId: randomUUID(),
    categoryId: randomUUID(),
    fieldDefId: randomUUID(),
    pipelineId: randomUUID(),
    stageId: randomUUID(),
    deadlineTemplateId: randomUUID(),
    matterNoteId: randomUUID(),
    matterReplyId: randomUUID(),
    matterNoteLinkId: randomUUID(),
    matterTimeEntryId: randomUUID(),
    taskNoteId: randomUUID(),
    taskReplyId: randomUUID(),
    taskTimeEntryId: randomUUID(),
    clientNoteId: randomUUID(),
    clientReplyId: randomUUID(),
    clientTimeEntryId: randomUUID(),
    matterEventId: randomUUID(),
    clientEventId: randomUUID(),
    matterContactLinkId: randomUUID(),
    clientContactLinkId: randomUUID(),
    subtaskId: randomUUID(),
    recurrenceGroupId: randomUUID(),
    invoiceId: randomUUID(),
    notificationId: randomUUID(),
  };

  await q(`insert into practice_areas (id, law_firm_id, name) values ($1,$2,$3)`,
    [ids.practiceAreaId, firm.id, `PA ${label}`]);

  // The portal caller is this firm's own client record, so portal routes have a
  // real association to resolve before they ever look at an entity id.
  await q(
    `insert into clients (id, law_firm_id, name, client_type, user_id, email)
     values ($1,$2,$3,'person',$4,$5)`,
    [ids.clientId, firm.id, `Client ${label}`, portalUid, `client-${label}@example.test`],
  );

  await q(
    `insert into matters (id, law_firm_id, name, matter_reference_id, status, created_by)
     values ($1,$2,$3,$4,'active',$5)`,
    [ids.matterId, firm.id, `Matter ${label}`, `REF-${label}-1`, owner.uid],
  );
  await q(`insert into matter_clients (matter_id, client_id, law_firm_id) values ($1,$2,$3)`,
    [ids.matterId, ids.clientId, firm.id]);
  await q(
    `insert into matter_members (matter_id, user_id, law_firm_id, role, joined_at)
     values ($1,$2,$3,'lead',now())`,
    [ids.matterId, owner.uid, firm.id],
  );
  // A SECOND matter member, and the one the remove/hourly-rate cases target. A
  // matter must keep at least one member, so aiming those at the owner made the
  // control fail on that rule rather than on anything to do with the matter id.
  const spare = await createFirmMember(firm.id, { isOwner: false, permissions: [] });
  ids.spareMemberUid = spare.uid;
  await q(
    `insert into matter_members (matter_id, user_id, law_firm_id, role, joined_at)
     values ($1,$2,$3,'member',now())`,
    [ids.matterId, spare.uid, firm.id],
  );

  await q(
    `insert into tasks (id, law_firm_id, title, status, matter_id, created_by)
     values ($1,$2,$3,'open',$4,$5)`,
    [ids.taskId, firm.id, `Task ${label}`, ids.matterId, owner.uid],
  );
  await q(
    `insert into tasks (id, law_firm_id, title, status, matter_id, created_by)
     values ($1,$2,$3,'open',$4,$5)`,
    [ids.linkedTaskId, firm.id, `Linked task ${label}`, ids.matterId, owner.uid],
  );
  await q(
    `insert into task_subtasks (id, law_firm_id, task_id, title, sort_order)
     values ($1,$2,$3,$4,0)`,
    [ids.subtaskId, firm.id, ids.taskId, `Subtask ${label}`],
  );

  await q(
    `insert into contacts (id, law_firm_id, name, contact_type, category)
     values ($1,$2,$3,'person','witness')`,
    [ids.contactId, firm.id, `Contact ${label}`],
  );
  await q(
    `insert into matter_contacts (id, law_firm_id, matter_id, contact_id, role)
     values ($1,$2,$3,$4,'witness')`,
    [ids.matterContactLinkId, firm.id, ids.matterId, ids.contactId],
  );
  await q(
    `insert into contact_clients (id, law_firm_id, contact_id, client_id, relationship)
     values ($1,$2,$3,$4,'Spouse')`,
    [ids.clientContactLinkId, firm.id, ids.contactId, ids.clientId],
  );

  await q(`insert into lead_stages (id, law_firm_id, name, sort_order) values ($1,$2,$3,0)`,
    [ids.leadStageId, firm.id, `Stage ${label}`]);
  await q(
    `insert into leads (id, law_firm_id, name, email, stage_id, created_by)
     values ($1,$2,$3,$4,$5,$6)`,
    [ids.leadId, firm.id, `Lead ${label}`, `lead-${label}@example.test`, ids.leadStageId, owner.uid],
  );
  await q(
    `insert into intake_form_templates (id, law_firm_id, name, public_token, fields, is_active)
     values ($1,$2,$3,$4,'[]'::jsonb,true)`,
    [ids.intakeTemplateId, firm.id, `Intake ${label}`, `tok-${label}-${randomUUID().slice(0, 8)}`],
  );

  await q(
    `insert into matter_categories (id, law_firm_id, name, level, sort_order)
     values ($1,$2,$3,0,0)`,
    [ids.categoryId, firm.id, `Category ${label}`],
  );
  await q(
    `insert into matter_field_defs (id, law_firm_id, label, field_type, sort_order)
     values ($1,$2,$3,'text',0)`,
    [ids.fieldDefId, firm.id, `Field ${label}`],
  );
  await q(
    `insert into matter_stage_pipelines (id, law_firm_id, name, is_default)
     values ($1,$2,$3,true)`,
    [ids.pipelineId, firm.id, `Pipeline ${label}`],
  );
  await q(
    `insert into matter_stages (id, law_firm_id, pipeline_id, name, sort_order)
     values ($1,$2,$3,$4,0)`,
    [ids.stageId, firm.id, ids.pipelineId, `MStage ${label}`],
  );
  await q(
    `insert into deadline_set_templates (id, law_firm_id, name, items)
     values ($1,$2,$3,$4::jsonb)`,
    [ids.deadlineTemplateId, firm.id, `Deadlines ${label}`,
      JSON.stringify([{ title: 'Answer due', type: 'filing_deadline', offsetDays: 30, offsetDirection: 'after', relativeTo: 'trigger' }])],
  );

  await q(
    `insert into events (id, law_firm_id, matter_id, type, title, status, date, created_by)
     values ($1,$2,$3,'meeting',$4,'upcoming', now() + interval '10 days', $5)`,
    [ids.matterEventId, firm.id, ids.matterId, `Event ${label}`, owner.uid],
  );
  await q(
    `insert into events (id, law_firm_id, matter_id, type, title, status, date,
                                recurrence_group_id, created_by)
     values (gen_random_uuid(),$1,$2,'meeting',$3,'upcoming', now() + interval '20 days', $4, $5)`,
    [firm.id, ids.matterId, `Recurring ${label}`, ids.recurrenceGroupId, owner.uid],
  );
  await q(
    `insert into events (id, law_firm_id, client_id, type, title, status, date, created_by)
     values ($1,$2,$3,'meeting',$4,'upcoming', now() + interval '10 days', $5)`,
    [ids.clientEventId, firm.id, ids.clientId, `CEvent ${label}`, owner.uid],
  );

  // Notes on all three parents, each with a reply, and a matter note carrying a
  // linked task and a linked time entry so the link and time routes have a real
  // target to name.
  await q(
    `insert into notes (id, law_firm_id, matter_id, content, note_type, created_by)
     values ($1,$2,$3,$4,'general',$5)`,
    [ids.matterNoteId, firm.id, ids.matterId, `Matter note ${label}`, owner.uid],
  );
  await q(
    // Like note_links below, a reply carries no parent column since migration
    // 0207: the note it hangs off names the parent, and the reply cascades
    // through it.
    `insert into note_replies (id, law_firm_id, note_id, content, created_by)
     values ($1,$2,$3,$4,$5)`,
    [ids.matterReplyId, firm.id, ids.matterNoteId, `Reply ${label}`, owner.uid],
  );
  await q(
    // note_links carries no parent column since migration 0202: the note it
    // hangs off already names the matter, and the link cascades through it.
    `insert into note_links (id, law_firm_id, note_id, link_type, task_id, created_by)
     values ($1,$2,$3,'task',$4,$5)`,
    [ids.matterNoteLinkId, firm.id, ids.matterNoteId, ids.linkedTaskId, owner.uid],
  );

  await q(
    `insert into notes (id, law_firm_id, task_id, content, note_type, created_by)
     values ($1,$2,$3,$4,'general',$5)`,
    [ids.taskNoteId, firm.id, ids.taskId, `Task note ${label}`, owner.uid],
  );
  await q(
    `insert into note_replies (id, law_firm_id, note_id, content, created_by)
     values ($1,$2,$3,$4,$5)`,
    [ids.taskReplyId, firm.id, ids.taskNoteId, `Reply ${label}`, owner.uid],
  );

  await q(
    `insert into notes (id, law_firm_id, client_id, content, note_type, created_by)
     values ($1,$2,$3,$4,'general',$5)`,
    [ids.clientNoteId, firm.id, ids.clientId, `Client note ${label}`, owner.uid],
  );
  await q(
    `insert into note_replies (id, law_firm_id, note_id, content, created_by)
     values ($1,$2,$3,$4,$5)`,
    [ids.clientReplyId, firm.id, ids.clientNoteId, `Reply ${label}`, owner.uid],
  );

  // Time entries are the money side of a note. Money is integer cents.
  await q(
    `insert into activities (kind, id, law_firm_id, matter_id, user_id, activity_date, hours, rate_cents,
                               description, name, linked_note_id)
     values ('time', $1,$2,$3,$4,current_date,1.5,25000,'Note time','Note',$5)`,
    [ids.matterTimeEntryId, firm.id, ids.matterId, owner.uid, ids.matterNoteId],
  );
  await q(
    `insert into activities (kind, id, law_firm_id, matter_id, user_id, activity_date, hours, rate_cents,
                               description, name, linked_note_id)
     values ('time', $1,$2,$3,$4,current_date,1.0,25000,'Task note time','Note',$5)`,
    [ids.taskTimeEntryId, firm.id, ids.matterId, owner.uid, ids.taskNoteId],
  );
  await q(
    `insert into activities (kind, id, law_firm_id, client_id, user_id, activity_date, hours, rate_cents,
                               description, name, linked_note_id)
     values ('time', $1,$2,$3,$4,current_date,1.0,25000,'Client note time','Note',$5)`,
    [ids.clientTimeEntryId, firm.id, ids.clientId, owner.uid, ids.clientNoteId],
  );

  await q(
    `insert into invoices (id, law_firm_id, client_id, client_context_id, context_type,
                           invoice_number, status, total_cents, invoice_date, due_date)
     values ($1,$2,$3,$3,'client',$4,'outstanding',250000, current_date, current_date + 30)`,
    [ids.invoiceId, firm.id, ids.clientId, `INV-${label}-1`],
  );
  await q(
    `insert into notifications (id, law_firm_id, user_id, type, title, body, read)
     values ($1,$2,$3,'general',$4,'body',false)`,
    [ids.notificationId, firm.id, portalUid, `Notice ${label}`],
  );

  return {
    firmId: firm.id,
    owner,
    portal: { uid: portalUid, api: as(tokenFor({ uid: portalUid })) },
    ids,
  };
}

/** One swept route. */
interface RouteCase {
  /** Human name, and the it.each label. */
  name: string;
  method: Method;
  /** Built from a param map so the target id can be swapped without string surgery. */
  path: (ids: Ids, firmId: string) => string;
  /** Which key of `ids` this case swaps: the entity id under test. */
  param: string;
  /** The smallest body that PASSES validation, so the id is actually reached. */
  body?: (w: World) => any;
  /** The portal-user routes authenticate as a client, not a firm member. */
  actor?: 'owner' | 'portal';
  /**
   * Statuses the control (firm A's own id) may answer. Default: anything under
   * 400. Named per route only where a healthy request legitimately is not 2xx.
   */
  controlOk?: number[];
  /** Overrides the refusal set for the malformed case. Default [400, 403, 404]. */
  malformedOk?: number[];
  /** Overrides the refusal set for a well-formed absent id. Default: `malformedOk`'s. */
  absentOk?: number[];
  /** Overrides the refusal set for the cross-firm case. Default [403, 404]. */
  crossOk?: number[];
}

const FIRM = (w: string) => `/api/lawfirms/${w}`;

/* eslint-disable max-len */
const ROUTES: RouteCase[] = [
  // ── matters ────────────────────────────────────────────────────────────
  { name: 'GET /matters/:matterId', method: 'get', param: 'matterId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}` },
  { name: 'PUT /matters/:matterId', method: 'put', param: 'matterId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}`, body: () => ({ name: 'Renamed' }) },
    // 409: the seeded matter carries a time entry, and the delete refuses a matter
  // with billing records. That refusal is only reachable once the matter has been
  // found by id in this firm, which is exactly what the control has to prove.
  { name: 'DELETE /matters/:matterId', method: 'delete', param: 'matterId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}`, controlOk: [409] },
  { name: 'PATCH /matters/:matterId/legal-hold', method: 'patch', param: 'matterId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/legal-hold`, body: () => ({ legalHold: true, reason: 'sweep' }) },
  { name: 'POST /matters/:matterId/update-practice-area', method: 'post', param: 'matterId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/update-practice-area`, body: (w) => ({ practiceAreaId: w.ids.practiceAreaId }) },
  { name: 'GET /matters/:matterId/activity', method: 'get', param: 'matterId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/activity` },
  { name: 'GET /matters/:matterId/conflict-checks', method: 'get', param: 'matterId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/conflict-checks` },
  { name: 'POST /matters/:matterId/conflict-checks/run', method: 'post', param: 'matterId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/conflict-checks/run` },
  { name: 'GET /matters/:matterId/events/graph', method: 'get', param: 'matterId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/events/graph` },
  { name: 'GET /matters/:matterId/events', method: 'get', param: 'matterId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/events` },
  { name: 'POST /matters/:matterId/events', method: 'post', param: 'matterId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/events`, body: () => ({ type: 'meeting', title: 'Swept', date: '2027-03-04T10:00:00.000Z' }) },
  { name: 'POST /matters/:matterId/deadline-sets/:templateId/apply [matterId]', method: 'post', param: 'matterId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/deadline-sets/${i.deadlineTemplateId}/apply`, body: () => ({ anchorDate: '2027-03-04' }) },
  { name: 'POST /matters/:matterId/deadline-sets/:templateId/apply [templateId]', method: 'post', param: 'deadlineTemplateId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/deadline-sets/${i.deadlineTemplateId}/apply`, body: () => ({ anchorDate: '2027-03-04' }) },
  { name: 'DELETE /matters/:matterId/events/recurrence/:groupId [matterId]', method: 'delete', param: 'matterId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/events/recurrence/${i.recurrenceGroupId}` },
  { name: 'DELETE /matters/:matterId/events/recurrence/:groupId [groupId]', method: 'delete', param: 'recurrenceGroupId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/events/recurrence/${i.recurrenceGroupId}` },
  { name: 'POST /matters/:matterId/events/:eventId/cancel [matterId]', method: 'post', param: 'matterId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/events/${i.matterEventId}/cancel`, body: () => ({ reason: 'swept' }) },
  { name: 'POST /matters/:matterId/events/:eventId/cancel [eventId]', method: 'post', param: 'matterEventId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/events/${i.matterEventId}/cancel`, body: () => ({ reason: 'swept' }) },
  { name: 'POST /matters/:matterId/events/:eventId/postpone', method: 'post', param: 'matterEventId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/events/${i.matterEventId}/postpone`, body: () => ({ newDate: '2027-04-04T10:00:00.000Z', reason: 'swept' }) },
  { name: 'PUT /matters/:matterId/events/:eventId', method: 'put', param: 'matterEventId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/events/${i.matterEventId}`, body: () => ({ title: 'Swept title' }) },
  { name: 'DELETE /matters/:matterId/events/:eventId', method: 'delete', param: 'matterEventId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/events/${i.matterEventId}` },

  // ── matter categories ──────────────────────────────────────────────────
  { name: 'PUT /matters/categories/:categoryId', method: 'put', param: 'categoryId', path: (i, f) => `${FIRM(f)}/matters/categories/${i.categoryId}`, body: () => ({ name: 'Renamed category' }) },
  { name: 'DELETE /matters/categories/:categoryId', method: 'delete', param: 'categoryId', path: (i, f) => `${FIRM(f)}/matters/categories/${i.categoryId}` },

  // ── matter clients ─────────────────────────────────────────────────────
  { name: 'GET /matters/:matterId/clients', method: 'get', param: 'matterId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/clients` },
  { name: 'PUT /matters/:matterId/clients/billing-portions', method: 'put', param: 'matterId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/clients/billing-portions`, body: () => ({ portions: {} }) },
  { name: 'POST /matters/:matterId/clients', method: 'post', param: 'matterId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/clients`, body: () => ({ client: { name: 'Swept Client' } }) },
  { name: 'PUT /matters/:matterId/clients/:clientId [matterId]', method: 'put', param: 'matterId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/clients/${i.clientId}`, body: () => ({ client: { name: 'Swept Client' } }) },
  { name: 'PUT /matters/:matterId/clients/:clientId [clientId]', method: 'put', param: 'clientId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/clients/${i.clientId}`, body: () => ({ client: { name: 'Swept Client' } }) },
  { name: 'DELETE /matters/:matterId/clients/:clientId', method: 'delete', param: 'clientId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/clients/${i.clientId}` },

  // ── matter contacts ────────────────────────────────────────────────────
  { name: 'GET /matters/:matterId/contacts', method: 'get', param: 'matterId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/contacts` },
  { name: 'POST /matters/:matterId/contacts', method: 'post', param: 'matterId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/contacts`, body: () => ({ name: 'Swept Contact', role: 'witness' }) },
  { name: 'PUT /matters/:matterId/contacts/:linkId [matterId]', method: 'put', param: 'matterId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/contacts/${i.matterContactLinkId}`, body: () => ({ role: 'expert' }) },
  { name: 'PUT /matters/:matterId/contacts/:linkId [linkId]', method: 'put', param: 'matterContactLinkId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/contacts/${i.matterContactLinkId}`, body: () => ({ role: 'expert' }) },
  { name: 'DELETE /matters/:matterId/contacts/:linkId', method: 'delete', param: 'matterContactLinkId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/contacts/${i.matterContactLinkId}` },

  // ── matter members ─────────────────────────────────────────────────────
  { name: 'POST /matters/:matterId/members', method: 'post', param: 'matterId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/members`, body: (w) => ({ targetUserIds: [w.ids.spareMemberUid], role: 'member' }) },
  { name: 'POST /matters/:matterId/members/remove', method: 'post', param: 'matterId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/members/remove`, body: (w) => ({ targetUserIds: [w.ids.spareMemberUid] }) },
  { name: 'PUT /matters/:matterId/members/hourly-rate', method: 'put', param: 'matterId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/members/hourly-rate`, body: (w) => ({ userId: w.ids.spareMemberUid, hourlyRate: 300 }) },

  // ── matter notes (shared notes router) ─────────────────────────────────
  { name: 'GET /matters/:matterId/notes', method: 'get', param: 'matterId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/notes` },
  { name: 'GET /matters/:matterId/notes/:noteId [matterId]', method: 'get', param: 'matterId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/notes/${i.matterNoteId}` },
  { name: 'GET /matters/:matterId/notes/:noteId [noteId]', method: 'get', param: 'matterNoteId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/notes/${i.matterNoteId}` },
  { name: 'GET /matters/:matterId/notes/:noteId/versions', method: 'get', param: 'matterNoteId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/notes/${i.matterNoteId}/versions` },
  { name: 'POST /matters/:matterId/notes', method: 'post', param: 'matterId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/notes`, body: () => ({ content: 'Swept note' }) },
  { name: 'PUT /matters/:matterId/notes/:noteId', method: 'put', param: 'matterNoteId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/notes/${i.matterNoteId}`, body: () => ({ content: 'Swept edit' }) },
  { name: 'PUT /matters/:matterId/notes/:noteId/pin', method: 'put', param: 'matterNoteId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/notes/${i.matterNoteId}/pin`, body: () => ({ pinned: true }) },
  { name: 'DELETE /matters/:matterId/notes/:noteId', method: 'delete', param: 'matterNoteId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/notes/${i.matterNoteId}`, body: () => ({ reason: 'swept' }) },
  { name: 'POST /matters/:matterId/notes/:noteId/time', method: 'post', param: 'matterNoteId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/notes/${i.matterNoteId}/time`, body: () => ({ timeSpent: 1.5 }) },
  { name: 'PUT /matters/:matterId/notes/:noteId/time/:timeEntryId', method: 'put', param: 'matterTimeEntryId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/notes/${i.matterNoteId}/time/${i.matterTimeEntryId}`, body: () => ({ timeSpent: 2 }) },
  { name: 'DELETE /matters/:matterId/notes/:noteId/time/:timeEntryId', method: 'delete', param: 'matterTimeEntryId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/notes/${i.matterNoteId}/time/${i.matterTimeEntryId}` },
  { name: 'GET /matters/:matterId/notes/:noteId/replies', method: 'get', param: 'matterNoteId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/notes/${i.matterNoteId}/replies` },
  { name: 'POST /matters/:matterId/notes/:noteId/replies', method: 'post', param: 'matterNoteId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/notes/${i.matterNoteId}/replies`, body: () => ({ content: 'Swept reply' }) },
  { name: 'PUT /matters/:matterId/notes/:noteId/replies/:replyId', method: 'put', param: 'matterReplyId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/notes/${i.matterNoteId}/replies/${i.matterReplyId}`, body: () => ({ content: 'Swept reply edit' }) },
  { name: 'DELETE /matters/:matterId/notes/:noteId/replies/:replyId', method: 'delete', param: 'matterReplyId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/notes/${i.matterNoteId}/replies/${i.matterReplyId}`, body: () => ({ reason: 'swept' }) },
  { name: 'POST /matters/:matterId/notes/:noteId/tasks', method: 'post', param: 'matterNoteId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/notes/${i.matterNoteId}/tasks`, body: () => ({ title: 'Swept task' }) },
  { name: 'POST /matters/:matterId/notes/:noteId/links/task', method: 'post', param: 'matterNoteId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/notes/${i.matterNoteId}/links/task`, body: (w) => ({ taskId: w.ids.taskId }) },
  { name: 'DELETE /matters/:matterId/notes/:noteId/links/:linkId', method: 'delete', param: 'matterNoteLinkId', path: (i, f) => `${FIRM(f)}/matters/${i.matterId}/notes/${i.matterNoteId}/links/${i.matterNoteLinkId}` },

  // ── matter field definitions ───────────────────────────────────────────
  { name: 'PUT /matter-field-defs/:defId', method: 'put', param: 'fieldDefId', path: (i, f) => `${FIRM(f)}/matter-field-defs/${i.fieldDefId}`, body: () => ({ label: 'Swept field' }) },
  { name: 'DELETE /matter-field-defs/:defId', method: 'delete', param: 'fieldDefId', path: (i, f) => `${FIRM(f)}/matter-field-defs/${i.fieldDefId}` },

  // ── matter stages and pipelines ────────────────────────────────────────
  { name: 'PUT /matter-stages/:stageId', method: 'put', param: 'stageId', path: (i, f) => `${FIRM(f)}/matter-stages/${i.stageId}`, body: () => ({ name: 'Swept stage' }) },
  { name: 'DELETE /matter-stages/:stageId', method: 'delete', param: 'stageId', path: (i, f) => `${FIRM(f)}/matter-stages/${i.stageId}` },
  { name: 'PUT /matter-stage-pipelines/:pipelineId', method: 'put', param: 'pipelineId', path: (i, f) => `${FIRM(f)}/matter-stage-pipelines/${i.pipelineId}`, body: () => ({ name: 'Swept pipeline' }) },
  { name: 'DELETE /matter-stage-pipelines/:pipelineId', method: 'delete', param: 'pipelineId', path: (i, f) => `${FIRM(f)}/matter-stage-pipelines/${i.pipelineId}` },

  // ── deadline sets ──────────────────────────────────────────────────────
  { name: 'GET /deadline-sets/:templateId', method: 'get', param: 'deadlineTemplateId', path: (i, f) => `${FIRM(f)}/deadline-sets/${i.deadlineTemplateId}` },
  { name: 'PUT /deadline-sets/:templateId', method: 'put', param: 'deadlineTemplateId', path: (i, f) => `${FIRM(f)}/deadline-sets/${i.deadlineTemplateId}`, body: () => ({ name: 'Swept set' }) },
  { name: 'DELETE /deadline-sets/:templateId', method: 'delete', param: 'deadlineTemplateId', path: (i, f) => `${FIRM(f)}/deadline-sets/${i.deadlineTemplateId}` },

  // ── tasks ──────────────────────────────────────────────────────────────
  { name: 'GET /tasks/matter/:matterId', method: 'get', param: 'matterId', path: (i, f) => `${FIRM(f)}/tasks/matter/${i.matterId}` },
  { name: 'GET /tasks/:taskId', method: 'get', param: 'taskId', path: (i, f) => `${FIRM(f)}/tasks/${i.taskId}` },
  { name: 'GET /tasks/:taskId/dependencies', method: 'get', param: 'taskId', path: (i, f) => `${FIRM(f)}/tasks/${i.taskId}/dependencies` },
  { name: 'PUT /tasks/:taskId', method: 'put', param: 'taskId', path: (i, f) => `${FIRM(f)}/tasks/${i.taskId}`, body: () => ({ title: 'Swept task title' }) },
  { name: 'DELETE /tasks/:taskId', method: 'delete', param: 'taskId', path: (i, f) => `${FIRM(f)}/tasks/${i.taskId}` },

  // ── subtasks ───────────────────────────────────────────────────────────
  { name: 'GET /tasks/:taskId/subtasks', method: 'get', param: 'taskId', path: (i, f) => `${FIRM(f)}/tasks/${i.taskId}/subtasks` },
  { name: 'POST /tasks/:taskId/subtasks/reorder', method: 'post', param: 'taskId', path: (i, f) => `${FIRM(f)}/tasks/${i.taskId}/subtasks/reorder`, body: (w) => ({ subtaskIds: [w.ids.subtaskId] }) },
  { name: 'POST /tasks/:taskId/subtasks', method: 'post', param: 'taskId', path: (i, f) => `${FIRM(f)}/tasks/${i.taskId}/subtasks`, body: () => ({ title: 'Swept subtask' }) },
  { name: 'PUT /tasks/:taskId/subtasks/:subtaskId [taskId]', method: 'put', param: 'taskId', path: (i, f) => `${FIRM(f)}/tasks/${i.taskId}/subtasks/${i.subtaskId}`, body: () => ({ title: 'Swept subtask edit' }) },
  { name: 'PUT /tasks/:taskId/subtasks/:subtaskId [subtaskId]', method: 'put', param: 'subtaskId', path: (i, f) => `${FIRM(f)}/tasks/${i.taskId}/subtasks/${i.subtaskId}`, body: () => ({ title: 'Swept subtask edit' }) },
  { name: 'DELETE /tasks/:taskId/subtasks/:subtaskId', method: 'delete', param: 'subtaskId', path: (i, f) => `${FIRM(f)}/tasks/${i.taskId}/subtasks/${i.subtaskId}` },

  // ── task notes (shared notes router) ───────────────────────────────────
  { name: 'GET /tasks/:taskId/notes', method: 'get', param: 'taskId', path: (i, f) => `${FIRM(f)}/tasks/${i.taskId}/notes` },
  { name: 'GET /tasks/:taskId/notes/:noteId', method: 'get', param: 'taskNoteId', path: (i, f) => `${FIRM(f)}/tasks/${i.taskId}/notes/${i.taskNoteId}` },
  { name: 'GET /tasks/:taskId/notes/:noteId/versions', method: 'get', param: 'taskNoteId', path: (i, f) => `${FIRM(f)}/tasks/${i.taskId}/notes/${i.taskNoteId}/versions` },
  { name: 'POST /tasks/:taskId/notes', method: 'post', param: 'taskId', path: (i, f) => `${FIRM(f)}/tasks/${i.taskId}/notes`, body: () => ({ content: 'Swept task note' }) },
  { name: 'PUT /tasks/:taskId/notes/:noteId', method: 'put', param: 'taskNoteId', path: (i, f) => `${FIRM(f)}/tasks/${i.taskId}/notes/${i.taskNoteId}`, body: () => ({ content: 'Swept edit' }) },
  { name: 'PUT /tasks/:taskId/notes/:noteId/pin', method: 'put', param: 'taskNoteId', path: (i, f) => `${FIRM(f)}/tasks/${i.taskId}/notes/${i.taskNoteId}/pin`, body: () => ({ pinned: true }) },
  { name: 'DELETE /tasks/:taskId/notes/:noteId', method: 'delete', param: 'taskNoteId', path: (i, f) => `${FIRM(f)}/tasks/${i.taskId}/notes/${i.taskNoteId}`, body: () => ({ reason: 'swept' }) },
  { name: 'POST /tasks/:taskId/notes/:noteId/time', method: 'post', param: 'taskNoteId', path: (i, f) => `${FIRM(f)}/tasks/${i.taskId}/notes/${i.taskNoteId}/time`, body: () => ({ timeSpent: 1 }) },
  { name: 'PUT /tasks/:taskId/notes/:noteId/time/:timeEntryId', method: 'put', param: 'taskTimeEntryId', path: (i, f) => `${FIRM(f)}/tasks/${i.taskId}/notes/${i.taskNoteId}/time/${i.taskTimeEntryId}`, body: () => ({ timeSpent: 2 }) },
  { name: 'DELETE /tasks/:taskId/notes/:noteId/time/:timeEntryId', method: 'delete', param: 'taskTimeEntryId', path: (i, f) => `${FIRM(f)}/tasks/${i.taskId}/notes/${i.taskNoteId}/time/${i.taskTimeEntryId}` },
  { name: 'GET /tasks/:taskId/notes/:noteId/replies', method: 'get', param: 'taskNoteId', path: (i, f) => `${FIRM(f)}/tasks/${i.taskId}/notes/${i.taskNoteId}/replies` },
  { name: 'POST /tasks/:taskId/notes/:noteId/replies', method: 'post', param: 'taskNoteId', path: (i, f) => `${FIRM(f)}/tasks/${i.taskId}/notes/${i.taskNoteId}/replies`, body: () => ({ content: 'Swept reply' }) },
  { name: 'PUT /tasks/:taskId/notes/:noteId/replies/:replyId', method: 'put', param: 'taskReplyId', path: (i, f) => `${FIRM(f)}/tasks/${i.taskId}/notes/${i.taskNoteId}/replies/${i.taskReplyId}`, body: () => ({ content: 'Swept reply edit' }) },
  { name: 'DELETE /tasks/:taskId/notes/:noteId/replies/:replyId', method: 'delete', param: 'taskReplyId', path: (i, f) => `${FIRM(f)}/tasks/${i.taskId}/notes/${i.taskNoteId}/replies/${i.taskReplyId}`, body: () => ({ reason: 'swept' }) },

  // ── clients ────────────────────────────────────────────────────────────
  { name: 'GET /clients/:clientId/company-relationships', method: 'get', param: 'clientId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/company-relationships` },
  { name: 'GET /clients/:clientId', method: 'get', param: 'clientId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}` },
  { name: 'PUT /clients/:clientId', method: 'put', param: 'clientId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}`, body: () => ({ name: 'Swept client name' }) },
    // 409 for the same reason as DELETE /matters/:matterId: the client has an
  // invoice, and the refusal comes after the client is resolved by id.
  { name: 'DELETE /clients/:clientId', method: 'delete', param: 'clientId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}`, controlOk: [409] },
  { name: 'POST /clients/:clientId/revoke-portal-access', method: 'post', param: 'clientId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/revoke-portal-access` },
  { name: 'POST /clients/:clientId/matters', method: 'post', param: 'clientId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/matters`, body: (w) => ({ matterIds: [w.ids.matterId] }) },
  { name: 'DELETE /clients/:clientId/matters/:matterId [clientId]', method: 'delete', param: 'clientId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/matters/${i.matterId}` },
  { name: 'DELETE /clients/:clientId/matters/:matterId [matterId]', method: 'delete', param: 'matterId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/matters/${i.matterId}` },
  { name: 'GET /clients/:clientId/matters', method: 'get', param: 'clientId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/matters` },
  { name: 'GET /clients/:clientId/portal-files', method: 'get', param: 'clientId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/portal-files` },
  { name: 'GET /clients/:clientId/tasks', method: 'get', param: 'clientId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/tasks` },
  { name: 'GET /clients/:clientId/contacts', method: 'get', param: 'clientId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/contacts` },
  { name: 'POST /clients/:clientId/contacts', method: 'post', param: 'clientId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/contacts`, body: () => ({ name: 'Swept Related Person' }) },
  { name: 'PUT /clients/:clientId/contacts/:linkId [clientId]', method: 'put', param: 'clientId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/contacts/${i.clientContactLinkId}`, body: () => ({ relationship: 'Swept' }) },
  { name: 'PUT /clients/:clientId/contacts/:linkId [linkId]', method: 'put', param: 'clientContactLinkId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/contacts/${i.clientContactLinkId}`, body: () => ({ relationship: 'Swept' }) },
  { name: 'DELETE /clients/:clientId/contacts/:linkId', method: 'delete', param: 'clientContactLinkId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/contacts/${i.clientContactLinkId}` },
  { name: 'GET /clients/:clientId/events', method: 'get', param: 'clientId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/events` },
  { name: 'POST /clients/:clientId/events', method: 'post', param: 'clientId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/events`, body: () => ({ type: 'meeting', title: 'Swept', date: '2027-03-04T10:00:00.000Z' }) },
  { name: 'PUT /clients/:clientId/events/:eventId [clientId]', method: 'put', param: 'clientId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/events/${i.clientEventId}`, body: () => ({ source: 'client', title: 'Swept event' }) },
  { name: 'PUT /clients/:clientId/events/:eventId [eventId]', method: 'put', param: 'clientEventId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/events/${i.clientEventId}`, body: () => ({ source: 'client', title: 'Swept event' }) },
  { name: 'DELETE /clients/:clientId/events/:eventId', method: 'delete', param: 'clientEventId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/events/${i.clientEventId}` },
  { name: 'GET /clients/:clientId/billing-rates', method: 'get', param: 'clientId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/billing-rates` },
  { name: 'PUT /clients/:clientId/billing-rates', method: 'put', param: 'clientId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/billing-rates`, body: () => ({ defaultRate: 275 }) },

  // ── client notes (shared notes router) ─────────────────────────────────
  { name: 'GET /clients/:clientId/notes', method: 'get', param: 'clientId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/notes` },
  { name: 'GET /clients/:clientId/notes/:noteId', method: 'get', param: 'clientNoteId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/notes/${i.clientNoteId}` },
  { name: 'GET /clients/:clientId/notes/:noteId/versions', method: 'get', param: 'clientNoteId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/notes/${i.clientNoteId}/versions` },
  { name: 'POST /clients/:clientId/notes', method: 'post', param: 'clientId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/notes`, body: () => ({ content: 'Swept client note' }) },
  { name: 'PUT /clients/:clientId/notes/:noteId', method: 'put', param: 'clientNoteId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/notes/${i.clientNoteId}`, body: () => ({ content: 'Swept edit' }) },
  { name: 'PUT /clients/:clientId/notes/:noteId/pin', method: 'put', param: 'clientNoteId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/notes/${i.clientNoteId}/pin`, body: () => ({ pinned: true }) },
  { name: 'DELETE /clients/:clientId/notes/:noteId', method: 'delete', param: 'clientNoteId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/notes/${i.clientNoteId}`, body: () => ({ reason: 'swept' }) },
  { name: 'POST /clients/:clientId/notes/:noteId/time', method: 'post', param: 'clientNoteId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/notes/${i.clientNoteId}/time`, body: () => ({ timeSpent: 1 }) },
  { name: 'PUT /clients/:clientId/notes/:noteId/time/:timeEntryId', method: 'put', param: 'clientTimeEntryId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/notes/${i.clientNoteId}/time/${i.clientTimeEntryId}`, body: () => ({ timeSpent: 2 }) },
  { name: 'DELETE /clients/:clientId/notes/:noteId/time/:timeEntryId', method: 'delete', param: 'clientTimeEntryId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/notes/${i.clientNoteId}/time/${i.clientTimeEntryId}` },
  { name: 'GET /clients/:clientId/notes/:noteId/replies', method: 'get', param: 'clientNoteId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/notes/${i.clientNoteId}/replies` },
  { name: 'POST /clients/:clientId/notes/:noteId/replies', method: 'post', param: 'clientNoteId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/notes/${i.clientNoteId}/replies`, body: () => ({ content: 'Swept reply' }) },
  { name: 'PUT /clients/:clientId/notes/:noteId/replies/:replyId', method: 'put', param: 'clientReplyId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/notes/${i.clientNoteId}/replies/${i.clientReplyId}`, body: () => ({ content: 'Swept reply edit' }) },
  { name: 'DELETE /clients/:clientId/notes/:noteId/replies/:replyId', method: 'delete', param: 'clientReplyId', path: (i, f) => `${FIRM(f)}/clients/${i.clientId}/notes/${i.clientNoteId}/replies/${i.clientReplyId}`, body: () => ({ reason: 'swept' }) },

  // ── contacts ───────────────────────────────────────────────────────────
  { name: 'GET /contacts/:contactId', method: 'get', param: 'contactId', path: (i, f) => `${FIRM(f)}/contacts/${i.contactId}` },
  { name: 'PUT /contacts/:contactId', method: 'put', param: 'contactId', path: (i, f) => `${FIRM(f)}/contacts/${i.contactId}`, body: () => ({ name: 'Swept contact name' }) },
  { name: 'DELETE /contacts/:contactId', method: 'delete', param: 'contactId', path: (i, f) => `${FIRM(f)}/contacts/${i.contactId}` },

  // ── leads ──────────────────────────────────────────────────────────────
  { name: 'POST /leads/:leadId/convert', method: 'post', param: 'leadId', path: (i, f) => `${FIRM(f)}/leads/${i.leadId}/convert`, body: () => ({ createMatter: false }) },
  { name: 'POST /leads/:leadId/send-intake-form', method: 'post', param: 'leadId', path: (i, f) => `${FIRM(f)}/leads/${i.leadId}/send-intake-form`, body: (w) => ({ intakeFormTemplateId: w.ids.intakeTemplateId }) },
  { name: 'GET /leads/:leadId', method: 'get', param: 'leadId', path: (i, f) => `${FIRM(f)}/leads/${i.leadId}` },
  { name: 'PUT /leads/:leadId', method: 'put', param: 'leadId', path: (i, f) => `${FIRM(f)}/leads/${i.leadId}`, body: () => ({ name: 'Swept lead' }) },
  { name: 'DELETE /leads/:leadId', method: 'delete', param: 'leadId', path: (i, f) => `${FIRM(f)}/leads/${i.leadId}` },

  // ── lead stages ────────────────────────────────────────────────────────
  { name: 'PUT /lead-stages/:stageId', method: 'put', param: 'leadStageId', path: (i, f) => `${FIRM(f)}/lead-stages/${i.leadStageId}`, body: () => ({ name: 'Swept lead stage' }) },
  { name: 'DELETE /lead-stages/:stageId', method: 'delete', param: 'leadStageId', path: (i, f) => `${FIRM(f)}/lead-stages/${i.leadStageId}` },

  // ── intake forms ───────────────────────────────────────────────────────
  { name: 'POST /intake-forms/:templateId/regenerate-token', method: 'post', param: 'intakeTemplateId', path: (i, f) => `${FIRM(f)}/intake-forms/${i.intakeTemplateId}/regenerate-token` },
  { name: 'GET /intake-forms/:templateId', method: 'get', param: 'intakeTemplateId', path: (i, f) => `${FIRM(f)}/intake-forms/${i.intakeTemplateId}` },
  { name: 'PUT /intake-forms/:templateId', method: 'put', param: 'intakeTemplateId', path: (i, f) => `${FIRM(f)}/intake-forms/${i.intakeTemplateId}`, body: () => ({ name: 'Swept intake form' }) },
  { name: 'DELETE /intake-forms/:templateId', method: 'delete', param: 'intakeTemplateId', path: (i, f) => `${FIRM(f)}/intake-forms/${i.intakeTemplateId}` },

  // ── client portal (the caller is a portal client, not a firm member) ───
  { name: 'PORTAL GET /matters/:matterId', method: 'get', actor: 'portal', param: 'matterId', path: (i, f) => `/api/client-portal/lawfirm/${f}/matters/${i.matterId}` },
  { name: 'PORTAL GET /matters/:matterId/documents', method: 'get', actor: 'portal', param: 'matterId', path: (i, f) => `/api/client-portal/lawfirm/${f}/matters/${i.matterId}/documents` },
  { name: 'PORTAL GET /invoices/:invoiceId', method: 'get', actor: 'portal', param: 'invoiceId', path: (i, f) => `/api/client-portal/lawfirm/${f}/invoices/${i.invoiceId}` },
    // Two refusals are legitimate here, and which one you get depends on the
  // ENVIRONMENT rather than on the id. With Stripe configured it is 400
  // 'Payment has not been requested for this invoice', which stripe.service
  // raises only AFTER loading the invoice by id. With no STRIPE_SECRET_KEY, as
  // on CI where there is no .env, the service reports 503 before it gets that
  // far. Both prove what this control exists to prove: the route was reached
  // and refused for a Stripe reason, not for an id reason. Seeding past either
  // needs a real Stripe checkout session the harness cannot produce.
  { name: 'PORTAL GET /billing/pay/:invoiceId', method: 'get', actor: 'portal', param: 'invoiceId', path: (i, f) => `/api/client-portal/lawfirm/${f}/billing/pay/${i.invoiceId}`, controlOk: [400, 503] },
    // Mark-as-read is idempotent by design and its UPDATE is scoped to the
  // caller's OWN user_id, so any id the caller does not own is a no-op that
  // still answers 200. Nothing of the other firm is read back or changed, which
  // is what the fingerprint below actually proves; the status is not the
  // evidence here. Pinned as 200 rather than loosened, so a change to that
  // behaviour shows up as a failure to be looked at.
  { name: 'PORTAL POST /notifications/:notificationId/read', method: 'post', actor: 'portal', param: 'notificationId', path: (i, f) => `/api/client-portal/lawfirm/${f}/notifications/${i.notificationId}/read`, malformedOk: [200], crossOk: [200] },
];
/* eslint-enable max-len */

let A: World;
let B: World;

beforeEach(async () => {
  A = await seedWorld('A');
  B = await seedWorld('B');
  await drainEvents();
});

const send = (w: World, r: RouteCase, path: string) => {
  const api = r.actor === 'portal' ? w.portal.api : w.owner.api;
  const req = api[r.method](path);
  return r.body ? req.send(r.body(w)) : req.send();
};

describe.each(ROUTES.map((r) => [r.name, r] as const))(
  '%s',
  (_name, route) => {
    /**
     * BREAKS WHEN: the repository behind this route stops guarding the id and
     * hands a non-uuid string to a uuid column, which Postgres answers with
     * 22P02 and the error middleware turns into a 500.
     */
    it('refuses a malformed id instead of failing with a 500', async () => {
      const ids = { ...A.ids, [route.param]: MALFORMED_ID };
      const res = await send(A, route, route.path(ids, A.firmId));

      expect(refusalVerdict(res, route.malformedOk ?? [400, 403, 404])).toBe('refused');
    });

    /**
     * The control for the case above. A well-formed id that names nothing must
     * be refused the same way, so the malformed case is pinning "refused", not
     * "happens to fail some unrelated shape check on the string".
     */
    it('refuses a well-formed id that names nothing', async () => {
      const ids = { ...A.ids, [route.param]: absentId() };
      const res = await send(A, route, route.path(ids, A.firmId));

      expect(refusalVerdict(res, route.absentOk ?? route.malformedOk ?? [400, 403, 404])).toBe('refused');
    });

    /**
     * BREAKS WHEN: the lookup behind this route drops its law_firm_id predicate,
     * so firm A's owner can read or write a row that belongs to firm B. The
     * fingerprint catches a write that still answered 404, and the control at
     * the end catches a "pass" that only happened because the request never
     * reached the id.
     */
    it("never serves another firm's id, and leaves that firm's data untouched", async () => {
      const table = PARAM_TABLE[route.param];
      const before = await fingerprint(B.firmId);
      const beforeRow = table ? await rowJson(table, B.ids[route.param]) : null;

      const crossIds = { ...A.ids, [route.param]: B.ids[route.param] };
      const res = await send(A, route, route.path(crossIds, A.firmId));

      expect(route.crossOk ?? [403, 404]).toContain(res.status);
      await drainEvents();
      expect(await fingerprint(B.firmId)).toEqual(before);
      if (table) expect(await rowJson(table, B.ids[route.param])).toEqual(beforeRow);

      // Control. Without it a refusal proves nothing: the same 404 would appear
      // if the URL were wrong or the body were rejected before the id was read.
      const control = await send(A, route, route.path(A.ids, A.firmId));
      const ok = route.controlOk;
      if (ok) expect(ok).toContain(control.status);
      else expect(control.status).toBeLessThan(400);
    });
  },
);
