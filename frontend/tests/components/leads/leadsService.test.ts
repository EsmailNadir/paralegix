/**
 * The leads service, tested OFFLINE against a fake transport.
 *
 * `leads.service.ts` reports 0%. A lead is a prospect that has not become a
 * client yet, and the pipeline is the one screen where a record is moved by
 * dragging it: every drag is a stage write, and the only thing separating "moved
 * to Consultation" from "deleted" is which verb and url the service picked for a
 * request the user never sees.
 *
 * WHAT GETS THE MOST ATTENTION
 * 1. THE STAGE A LEAD MOVES TO. A stage change is a PUT of `{ stageId }` to the
 *    lead's own url; a delete is a DELETE to that same url. Same path, same
 *    lead, opposite outcomes, so the method and the body are asserted together.
 * 2. ORDERED LISTS. `reorderStages` sends the whole pipeline as one ordered
 *    array and the server stores the positions from it, so the exact array that
 *    leaves the browser is the whole instruction.
 * 3. THE WINDOW. `applyListWindow` clamps the limit. An unclamped page is one
 *    request that pulls every lead a firm has ever taken.
 * 4. NORMALISATION. Every read passes through `normalizeLead` /
 *    `normalizeStage` / `normalizeTemplate`, which decide what a missing field
 *    becomes. Those defaults are what the leads list and lead page render.
 *
 * The public intake endpoints are the one part of this service a stranger
 * reaches, so they are checked for the OPPOSITE property: no credential on the
 * wire.
 */
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import leadsService from '@/services/leads.service';

const LAW_FIRM_ID = 'firm-1';
const LEAD_ID = 'lead-9';
const STAGE_ID = 'stage-4';
const TEMPLATE_ID = 'tpl-2';

let api: ApiMock;

/** Query parameters of a recorded call, read back the way a server reads them. */
const paramsOf = (url: string): URLSearchParams => new URL(url, 'http://x').searchParams;

/** The parsed JSON body of a recorded call. */
const bodyOf = (call: { body: unknown }): Record<string, unknown> =>
  call.body as Record<string, unknown>;

beforeEach(() => {
  api = installApiMock();
  // The dev-only duplicate-GET guard warns when a spec hits the same endpoint
  // twice inside its window, which is normal here and would otherwise bury the
  // real output.
  __resetDuplicateRequestGuard();
});

afterEach(() => {
  api.restore();
});

describe('normalising one lead', () => {
  const readLead = async (raw: Record<string, unknown>) => {
    api.get(`/leads/${LEAD_ID}`, { lead: { id: LEAD_ID, ...raw } });
    return leadsService.getLead(LAW_FIRM_ID, LEAD_ID);
  };

  it('unwraps the `lead` envelope', async () => {
    const lead = await readLead({ name: 'Pat Prospect' });

    expect(lead.name).toBe('Pat Prospect');
  });

  it('accepts a BARE lead record with no envelope', async () => {
    api.get(`/leads/${LEAD_ID}`, { id: LEAD_ID, name: 'Bare Pat' });

    // The route has answered both shapes. Reading only the envelope would show
    // an empty detail panel for a lead that loaded fine.
    expect((await leadsService.getLead(LAW_FIRM_ID, LEAD_ID)).name).toBe('Bare Pat');
  });

  it('turns a blank string field into null', async () => {
    const lead = await readLead({ email: '   ', phone: '555-0100' });

    // A whitespace-only email is not an email. Kept as a string it renders as a
    // mailto link to nowhere and passes any `if (lead.email)` check.
    expect(lead.email).toBeNull();
    expect(lead.phone).toBe('555-0100');
  });

  it('falls back updatedAt to createdAt when the server omits it', async () => {
    const lead = await readLead({ createdAt: '2026-01-02T03:04:05.000Z' });

    // The list sorts and labels by updatedAt. Undefined sorts unpredictably and
    // renders as a blank timestamp on a lead that does have an age.
    expect(lead.updatedAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('keeps stageId and stageDate as sent', async () => {
    const lead = await readLead({ stageId: STAGE_ID, stageDate: '2026-03-14' });

    // stageDate is a day-only `date` column and arrives as a raw 'YYYY-MM-DD'
    // string. Parsing it into a Date here would shift it by the viewer's offset.
    expect(lead.stageId).toBe(STAGE_ID);
    expect(lead.stageDate).toBe('2026-03-14');
  });

  it('reads the latest intake submission only when the key is present', async () => {
    const withKey = await readLead({ latestIntakeSubmission: null });
    expect('latestIntakeSubmission' in withKey).toBe(true);

    const withoutKey = await readLead({});
    // Absent means "this read did not join the submission", which is different
    // from "there is no submission". Fabricating a null would tell the detail
    // panel no form was ever sent.
    expect('latestIntakeSubmission' in withoutKey).toBe(false);
  });

  it('narrows an unknown submission status to `sent`', async () => {
    const lead = await readLead({
      latestIntakeSubmission: { id: 'sub-1', status: 'banana' },
    });

    // The status drives which badge and which actions the panel offers. An
    // unrecognised value must land on the pending state, not on `completed`.
    expect(lead.latestIntakeSubmission?.status).toBe('sent');
  });

  it('keeps a real submission status', async () => {
    const lead = await readLead({
      latestIntakeSubmission: { id: 'sub-1', status: 'completed' },
    });

    expect(lead.latestIntakeSubmission?.status).toBe('completed');
  });

  it('drops a submission with no id', async () => {
    const lead = await readLead({ latestIntakeSubmission: { status: 'completed' } });

    // The panel links to the submission by id. An id-less one is a dead link
    // announcing a completed form nobody can open.
    expect(lead.latestIntakeSubmission).toBeNull();
  });
});

describe('the paged lead list', () => {
  const PAGE = { leads: [], totalItems: 0 };

  it('always sends a limit', async () => {
    api.get('/leads', PAGE);

    await leadsService.listLeadsPaged(LAW_FIRM_ID);

    expect(paramsOf(api.calls('GET')[0].url).get('limit')).toBe('50');
  });

  it('CLAMPS a limit above the maximum', async () => {
    api.get('/leads', PAGE);

    await leadsService.listLeadsPaged(LAW_FIRM_ID, { limit: 100000 });

    // The cap is what stops one request pulling every lead the firm has ever
    // taken in.
    expect(Number(paramsOf(api.calls('GET')[0].url).get('limit'))).toBeLessThanOrEqual(500);
  });

  it('RAISES a limit of zero to one', async () => {
    api.get('/leads', PAGE);

    await leadsService.listLeadsPaged(LAW_FIRM_ID, { limit: 0 });

    // `limit=0` is a request for no rows, which renders as a permanently empty
    // pipeline rather than as an error.
    expect(paramsOf(api.calls('GET')[0].url).get('limit')).toBe('1');
  });

  it('defaults to page 1 and sends no offset', async () => {
    api.get('/leads', PAGE);

    await leadsService.listLeadsPaged(LAW_FIRM_ID);

    const params = paramsOf(api.calls('GET')[0].url);
    expect(params.get('page')).toBe('1');
    expect(params.has('offset')).toBe(false);
  });

  it('lets an explicit OFFSET win over a page', async () => {
    api.get('/leads', PAGE);

    await leadsService.listLeadsPaged(LAW_FIRM_ID, { page: 5, offset: 120 });

    // Sending both lets the server pick, and the two disagree: page 5 of 50 is
    // offset 200, not 120. The older offset callers are the ones that must keep
    // working.
    const params = paramsOf(api.calls('GET')[0].url);
    expect(params.get('offset')).toBe('120');
    expect(params.has('page')).toBe(false);
  });

  it('passes the stage filter under its own key', async () => {
    api.get('/leads', PAGE);

    await leadsService.listLeadsPaged(LAW_FIRM_ID, { stageId: STAGE_ID });

    expect(paramsOf(api.calls('GET')[0].url).get('stageId')).toBe(STAGE_ID);
  });

  it('OMITS the stage filter when none was given', async () => {
    api.get('/leads', PAGE);

    await leadsService.listLeadsPaged(LAW_FIRM_ID, { search: 'anything' });

    // `stageId=undefined` filters to a stage of that name, which is none, and
    // the list shows no leads.
    expect(api.calls('GET')[0].url).not.toContain('stageId');
  });

  it('TRIMS a search term and keeps its inner spaces', async () => {
    api.get('/leads', PAGE);

    await leadsService.listLeadsPaged(LAW_FIRM_ID, { search: '  Acme Holdings  ' });

    // Read back through URLSearchParams, not decodeURIComponent: a query string
    // encodes a space as `+`, which decodeURIComponent leaves as a literal plus.
    expect(paramsOf(api.calls('GET')[0].url).get('search')).toBe('Acme Holdings');
  });

  it('OMITS a whitespace-only search', async () => {
    api.get('/leads', PAGE);

    await leadsService.listLeadsPaged(LAW_FIRM_ID, { search: '   ' });

    // A blank search sent as a parameter becomes part of the React Query key, so
    // clearing a search box would fetch a differently-spelled copy of the page
    // it already had.
    expect(api.calls('GET')[0].url).not.toContain('search');
  });

  it('serialises a multi-column sort as field:dir pairs IN ORDER', async () => {
    api.get('/leads', PAGE);

    await leadsService.listLeadsPaged(LAW_FIRM_ID, {
      sort: [{ field: 'stageId', sort: 'asc' }, { field: 'updatedAt', sort: 'desc' }],
    });

    // The order of the pairs is the order of the sort. Reversed, the grid orders
    // by the tiebreaker.
    expect(paramsOf(api.calls('GET')[0].url).get('sort')).toBe('stageId:asc,updatedAt:desc');
  });

  it('sends the single sortBy/order pair when that is what the caller has', async () => {
    api.get('/leads', PAGE);

    await leadsService.listLeadsPaged(LAW_FIRM_ID, { sortBy: 'name', order: 'asc' });

    const params = paramsOf(api.calls('GET')[0].url);
    expect(params.get('sortBy')).toBe('name');
    expect(params.get('order')).toBe('asc');
    expect(params.has('sort')).toBe(false);
  });

  it('sends the timezone header on the paged read', async () => {
    api.get('/leads', PAGE);

    await leadsService.listLeadsPaged(LAW_FIRM_ID);

    // The paged route reports day-bucketed stage ages, so it needs the caller's
    // zone to decide which day a lead moved.
    expect(api.calls('GET')[0].headers['x-timezone']).toBeTruthy();
  });

  it('falls back totalItems to the number of rows returned', async () => {
    api.get('/leads', { leads: [{ id: 'a' }, { id: 'b' }] });

    // A pager told `undefined` renders NaN pages. Two rows and no count is at
    // least a truthful floor.
    expect((await leadsService.listLeadsPaged(LAW_FIRM_ID)).totalItems).toBe(2);
  });

  it('keeps the server total when it is larger than the page', async () => {
    api.get('/leads', { leads: [{ id: 'a' }], totalItems: 240 });

    // The positive half: overwriting the real total with the page size collapses
    // the pager to one page and hides everything past row one.
    expect((await leadsService.listLeadsPaged(LAW_FIRM_ID)).totalItems).toBe(240);
  });

  it('DROPS a row the server sent with no id', async () => {
    api.get('/leads', { leads: [{ id: 'l1', name: 'Real' }, { name: 'Headless' }] });

    const { leads } = await leadsService.listLeadsPaged(LAW_FIRM_ID);

    // Every row in the list is keyed and opened by its id. An id-less row
    // renders as an entry that cannot be opened or converted.
    expect(leads).toHaveLength(1);
    expect(leads[0].id).toBe('l1');
  });

  it('throws when the list is refused', async () => {
    api.get('/leads', { status: 403, body: { error: 'Forbidden' } });

    // A swallowed 403 here is indistinguishable from a firm with no leads.
    await expect(leadsService.listLeadsPaged(LAW_FIRM_ID)).rejects.toBeDefined();
  });
});

describe('creating a lead', () => {
  it('POSTs to the firm leads route', async () => {
    api.post('/leads', { leadId: 'lead-new', lead: { id: 'lead-new' } });

    await leadsService.createLead(LAW_FIRM_ID, { name: 'New Prospect' });

    const call = api.calls('POST')[0];
    expect(call.pathname).toMatch(new RegExp(`/lawfirms/${LAW_FIRM_ID}/leads$`));
    expect(bodyOf(call).name).toBe('New Prospect');
  });

  it('does NOT put the firm id in the body', async () => {
    api.post('/leads', { leadId: 'lead-new', lead: { id: 'lead-new' } });

    await leadsService.createLead(LAW_FIRM_ID, { name: 'New Prospect' });

    // The firm is in the path. A second copy in the body gives the server two
    // sources for one fact that can disagree.
    expect(bodyOf(api.calls('POST')[0]).lawFirmId).toBeUndefined();
  });

  it('falls back to the nested lead id when the envelope omits leadId', async () => {
    api.post('/leads', { lead: { id: 'lead-new' } });

    // The caller navigates to the new lead with this id. Undefined lands on
    // `/leads/undefined`.
    expect((await leadsService.createLead(LAW_FIRM_ID, { name: 'x' })).leadId).toBe('lead-new');
  });

  it('throws when the server refuses the create', async () => {
    api.post('/leads', { status: 400, body: { error: 'Name is required' } });

    await expect(leadsService.createLead(LAW_FIRM_ID, { name: '' }))
      .rejects.toThrow(/name is required/i);
  });

  it('CHARACTERISATION: builds /lawfirms/undefined/leads instead of refusing', async () => {
    api.post('/leads', { leadId: 'x', lead: { id: 'x' } });

    await leadsService.createLead(undefined as unknown as string, { name: 'Orphan' });

    // Unlike `matters.service`, this service has NO firm-id guard: a caller that
    // renders before the firm context resolves sends a real request to a url
    // containing the literal string "undefined", and the 404 reads to the user
    // as the feature being broken. Recorded rather than asserted as correct.
    expect(api.calls('POST')[0].pathname).toContain('/lawfirms/undefined/leads');
  });
});

describe('moving a lead through the pipeline', () => {
  it('PUTs the new stage to the lead url', async () => {
    api.put(`/leads/${LEAD_ID}`, { lead: { id: LEAD_ID, stageId: STAGE_ID } });

    await leadsService.updateLead(LAW_FIRM_ID, LEAD_ID, { stageId: STAGE_ID });

    const call = api.calls('PUT')[0];
    expect(call.pathname).toMatch(new RegExp(`/lawfirms/${LAW_FIRM_ID}/leads/${LEAD_ID}$`));
    // The destination stage IS the instruction. A move that sent the wrong id
    // silently files the lead in another stage and the lead shows there as if
    // the user had asked for that.
    expect(bodyOf(call).stageId).toBe(STAGE_ID);
  });

  it('sends ONLY the fields the caller changed', async () => {
    api.put(`/leads/${LEAD_ID}`, { lead: { id: LEAD_ID } });

    await leadsService.updateLead(LAW_FIRM_ID, LEAD_ID, { stageId: STAGE_ID });

    // A drag changes the stage and nothing else. Padding the body with the rest
    // of the form would overwrite edits another member saved in between.
    expect(Object.keys(bodyOf(api.calls('PUT')[0]))).toEqual(['stageId']);
  });

  it('sends an explicit NULL stage rather than dropping the key', async () => {
    api.put(`/leads/${LEAD_ID}`, { lead: { id: LEAD_ID } });

    await leadsService.updateLead(LAW_FIRM_ID, LEAD_ID, { stageId: null });

    // Null is how a lead is taken out of every column. Dropping the key is a
    // no-op update, so the card would spring back to where it was.
    const body = bodyOf(api.calls('PUT')[0]);
    expect('stageId' in body).toBe(true);
    expect(body.stageId).toBeNull();
  });

  it('carries the stage date alongside the stage', async () => {
    api.put(`/leads/${LEAD_ID}`, { lead: { id: LEAD_ID } });

    await leadsService.updateLead(LAW_FIRM_ID, LEAD_ID, {
      stageId: STAGE_ID, stageDate: '2026-04-01',
    });

    // The consultation date belongs to the move. Sent as a separate request it
    // can land against the previous stage if the first write fails.
    const body = bodyOf(api.calls('PUT')[0]);
    expect(body.stageId).toBe(STAGE_ID);
    expect(body.stageDate).toBe('2026-04-01');
  });

  it('a stage change and a delete are NOT the same request', async () => {
    api.put(`/leads/${LEAD_ID}`, { lead: { id: LEAD_ID } });
    api.delete(`/leads/${LEAD_ID}`, { message: 'Deleted' });

    await leadsService.updateLead(LAW_FIRM_ID, LEAD_ID, { stageId: STAGE_ID });
    await leadsService.deleteLead(LAW_FIRM_ID, LEAD_ID);

    // Same url, opposite outcomes. The verb is the only thing separating
    // "moved to Consultation" from "gone", and both report success.
    expect(api.calls('PUT')).toHaveLength(1);
    expect(api.calls('DELETE')).toHaveLength(1);
    expect(api.calls('DELETE')[0].pathname).toBe(api.calls('PUT')[0].pathname);
    expect(api.calls('DELETE')[0].body).toBeNull();
  });

  it('throws when the stage change is refused', async () => {
    api.put(`/leads/${LEAD_ID}`, { status: 403, body: { error: 'Forbidden' } });

    // A swallowed refusal leaves the card in its new column until the next
    // reload snaps it back.
    await expect(leadsService.updateLead(LAW_FIRM_ID, LEAD_ID, { stageId: STAGE_ID }))
      .rejects.toBeDefined();
  });

  it('throws when the delete is refused', async () => {
    api.delete(`/leads/${LEAD_ID}`, { status: 403, body: { error: 'Forbidden' } });

    await expect(leadsService.deleteLead(LAW_FIRM_ID, LEAD_ID)).rejects.toBeDefined();
  });
});

describe('converting a lead', () => {
  it('POSTs to the lead CONVERT route, not to the lead itself', async () => {
    api.post(`/leads/${LEAD_ID}/convert`, { matterId: 'm-1', clientId: 'c-1', lead: { id: LEAD_ID } });

    await leadsService.convertLead(LAW_FIRM_ID, LEAD_ID, { name: 'Smith v. Jones' });

    // Conversion creates a client and a matter. Sent to the plain lead url it
    // would be read as an edit and create nothing.
    expect(api.calls('POST')[0].pathname).toMatch(/\/leads\/lead-9\/convert$/);
  });

  it('passes the client type through', async () => {
    api.post(`/leads/${LEAD_ID}/convert`, { matterId: null, clientId: 'c-1', lead: { id: LEAD_ID } });

    await leadsService.convertLead(LAW_FIRM_ID, LEAD_ID, {
      clientType: 'company', createMatter: false,
    });

    // 'company' turns the lead's organization into an organization client. Lost
    // in transit the server defaults to a person and the roster is never built.
    const body = bodyOf(api.calls('POST')[0]);
    expect(body.clientType).toBe('company');
    expect(body.createMatter).toBe(false);
  });

  it('defaults a missing clientId to null but leaves matterId undefined', async () => {
    api.post(`/leads/${LEAD_ID}/convert`, { lead: { id: LEAD_ID } });

    const result = await leadsService.convertLead(LAW_FIRM_ID, LEAD_ID, {});

    // Recorded because the two are handled asymmetrically in the same object
    // literal: `clientId` gets a `?? null` and `matterId` does not.
    expect(result.clientId).toBeNull();
    expect(result.matterId).toBeUndefined();
  });

  it('throws when the conversion is refused', async () => {
    api.post(`/leads/${LEAD_ID}/convert`, {
      status: 400, body: { error: 'Organization is required for a company client' },
    });

    // The lead stays a lead. A swallowed error would show a success toast for a
    // client and matter that do not exist.
    await expect(leadsService.convertLead(LAW_FIRM_ID, LEAD_ID, { clientType: 'company' }))
      .rejects.toThrow(/organization is required/i);
  });
});

describe('sending an intake form to a lead', () => {
  it('POSTs the template id to the lead send-intake-form route', async () => {
    api.post(`/leads/${LEAD_ID}/send-intake-form`, { message: 'Sent' });

    await leadsService.sendIntakeForm(LAW_FIRM_ID, LEAD_ID, {
      intakeFormTemplateId: TEMPLATE_ID, email: 'pat@example.com',
    });

    const call = api.calls('POST')[0];
    expect(call.pathname).toMatch(/\/leads\/lead-9\/send-intake-form$/);
    // Which form is sent, and to which address. The address overrides the one on
    // the lead, so it must survive rather than be dropped in favour of it.
    expect(bodyOf(call).intakeFormTemplateId).toBe(TEMPLATE_ID);
    expect(bodyOf(call).email).toBe('pat@example.com');
  });

  it('throws when the send is refused', async () => {
    api.post(`/leads/${LEAD_ID}/send-intake-form`, {
      status: 400, body: { error: 'Lead has no email address' },
    });

    // Silence here tells the user an email went out that never did.
    await expect(leadsService.sendIntakeForm(LAW_FIRM_ID, LEAD_ID, {
      intakeFormTemplateId: TEMPLATE_ID,
    })).rejects.toThrow(/no email address/i);
  });
});

describe('lead stages', () => {
  it('reads stages from the lead-stages route, not from /leads', async () => {
    api.get('/lead-stages', { stages: [] });

    await leadsService.listStages(LAW_FIRM_ID);

    expect(api.calls('GET')[0].pathname).toMatch(new RegExp(`/lawfirms/${LAW_FIRM_ID}/lead-stages$`));
  });

  it('drops a stage with no id and keeps the rest', async () => {
    api.get('/lead-stages', { stages: [{ id: 's1', name: 'New' }, { name: 'Nameless' }] });

    // Columns are keyed by stage id and every card carries one. An id-less
    // column can never match a lead.
    expect(await leadsService.listStages(LAW_FIRM_ID)).toHaveLength(1);
  });

  it('defaults sortOrder to 0 and isClosed to false', async () => {
    api.get('/lead-stages', { stages: [{ id: 's1', name: 'New' }] });

    const [stage] = await leadsService.listStages(LAW_FIRM_ID);

    // sortOrder decides column position and isClosed decides whether a lead in
    // it counts as still open. `undefined` sorts a column to the end and makes
    // the closed test truthy-dependent.
    expect(stage.sortOrder).toBe(0);
    expect(stage.isClosed).toBe(false);
  });

  it('treats a non-boolean isClosed as NOT closed', async () => {
    api.get('/lead-stages', { stages: [{ id: 's1', isClosed: 'false' }] });

    // The string 'false' is truthy. Only a real `true` may close a stage, or a
    // firm's open pipeline silently empties.
    expect((await leadsService.listStages(LAW_FIRM_ID))[0].isClosed).toBe(false);
  });

  it('keeps a real closed stage closed', async () => {
    api.get('/lead-stages', { stages: [{ id: 's1', isClosed: true }] });

    expect((await leadsService.listStages(LAW_FIRM_ID))[0].isClosed).toBe(true);
  });

  it('creates a stage with POST and updates one with PUT on its own url', async () => {
    api.post('/lead-stages', { stage: { id: 's-new', name: 'Consultation' } });
    api.put(`/lead-stages/${STAGE_ID}`, { stage: { id: STAGE_ID, name: 'Renamed' } });

    await leadsService.createStage(LAW_FIRM_ID, { name: 'Consultation' });
    await leadsService.updateStage(LAW_FIRM_ID, STAGE_ID, { name: 'Renamed' });

    // A create posted to the collection, an update put to the member. Swapping
    // them either edits nothing or adds a duplicate column.
    expect(api.calls('POST')[0].pathname).toMatch(/\/lead-stages$/);
    expect(api.calls('PUT')[0].pathname).toMatch(/\/lead-stages\/stage-4$/);
  });

  it('deletes a stage through the same url the update uses, with DELETE', async () => {
    api.delete(`/lead-stages/${STAGE_ID}`, { message: 'Deleted' });

    await leadsService.deleteStage(LAW_FIRM_ID, STAGE_ID);

    expect(api.calls('DELETE')[0].pathname).toMatch(/\/lead-stages\/stage-4$/);
  });

  it('REORDERS with the exact ordered id list', async () => {
    api.post('/lead-stages/reorder', { stages: [] });

    await leadsService.reorderStages(LAW_FIRM_ID, ['s3', 's1', 's2']);

    // The array position IS the new sortOrder. A reversed or re-sorted list
    // rearranges every stage in the firm's pipeline, and the server reports
    // success either way.
    expect(bodyOf(api.calls('POST')[0]).stageIds).toEqual(['s3', 's1', 's2']);
  });

  it('sends a single-stage reorder as an ARRAY', async () => {
    api.post('/lead-stages/reorder', { stages: [] });

    await leadsService.reorderStages(LAW_FIRM_ID, ['s1']);

    // Unwrapping a one-element array into a bare string changes the request
    // shape for the smallest pipeline a firm can have.
    expect(bodyOf(api.calls('POST')[0]).stageIds).toEqual(['s1']);
  });

  it('routes the reorder to its OWN endpoint, not to the collection', async () => {
    api.post('/lead-stages/reorder', { stages: [] });

    await leadsService.reorderStages(LAW_FIRM_ID, ['s1', 's2']);

    // `POST /lead-stages` creates a stage. A reorder sent there would add a
    // column instead of moving any.
    expect(api.calls('POST')[0].pathname).toMatch(/\/lead-stages\/reorder$/);
  });

  it('throws when a stage delete is refused', async () => {
    api.delete(`/lead-stages/${STAGE_ID}`, {
      status: 409, body: { error: 'Stage still has leads in it' },
    });

    // The column has to stay on screen. Removing it optimistically strands its
    // leads with a stageId no column matches.
    await expect(leadsService.deleteStage(LAW_FIRM_ID, STAGE_ID))
      .rejects.toThrow(/still has leads/i);
  });
});

describe('intake form templates', () => {
  it('reads templates from the intake-forms route', async () => {
    api.get('/intake-forms', { templates: [] });

    await leadsService.listIntakeForms(LAW_FIRM_ID);

    expect(api.calls('GET')[0].pathname).toMatch(new RegExp(`/lawfirms/${LAW_FIRM_ID}/intake-forms$`));
  });

  it('treats a template with no isActive flag as ACTIVE', async () => {
    api.get('/intake-forms', { templates: [{ id: 't1', name: 'Intake' }] });

    // `isActive !== false`, so absence means active. Defaulting to inactive
    // would silently take every already-published form offline.
    expect((await leadsService.listIntakeForms(LAW_FIRM_ID))[0].isActive).toBe(true);
  });

  it('honours an explicit isActive false', async () => {
    api.get('/intake-forms', { templates: [{ id: 't1', isActive: false }] });

    expect((await leadsService.listIntakeForms(LAW_FIRM_ID))[0].isActive).toBe(false);
  });

  it('reports hasAccessCode only for a real true', async () => {
    api.get('/intake-forms', {
      templates: [{ id: 't1', hasAccessCode: true }, { id: 't2' }],
    });

    const templates = await leadsService.listIntakeForms(LAW_FIRM_ID);
    // This flag decides whether the public page asks for a code. Wrong either
    // way it either locks a form nobody can open or opens one meant to be gated.
    expect(templates[0].hasAccessCode).toBe(true);
    expect(templates[1].hasAccessCode).toBe(false);
  });

  it('keeps the field list IN ORDER', async () => {
    api.get('/intake-forms', {
      templates: [{
        id: 't1',
        fields: [
          { key: 'name', label: 'Full name', type: 'text' },
          { key: 'email', label: 'Email', type: 'email' },
          { key: 'detail', label: 'What happened', type: 'textarea' },
        ],
      }],
    });

    const [template] = await leadsService.listIntakeForms(LAW_FIRM_ID);

    // The array order is the order the questions are asked in. Re-ordering it
    // rebuilds the form the firm designed into a different one.
    expect(template.fields.map((f) => f.key)).toEqual(['name', 'email', 'detail']);
  });

  it('falls an unknown field type back to text', async () => {
    api.get('/intake-forms', {
      templates: [{ id: 't1', fields: [{ key: 'k', label: 'L', type: 'signature' }] }],
    });

    // The renderer switches on this. An unrecognised type must degrade to a text
    // box rather than render nothing and lose the answer.
    expect((await leadsService.listIntakeForms(LAW_FIRM_ID))[0].fields[0].type).toBe('text');
  });

  it('drops blank select options', async () => {
    api.get('/intake-forms', {
      templates: [{
        id: 't1',
        fields: [{ key: 'k', label: 'L', type: 'select', options: ['A', '', 'B'] }],
      }],
    });

    // An empty option renders as a selectable blank the submitter can choose,
    // which reaches the firm as an answered question with no answer.
    expect((await leadsService.listIntakeForms(LAW_FIRM_ID))[0].fields[0].options)
      .toEqual(['A', 'B']);
  });

  it('creates with POST and updates with PUT on the template url', async () => {
    api.post('/intake-forms', { template: { id: 't-new' } });
    api.put(`/intake-forms/${TEMPLATE_ID}`, { template: { id: TEMPLATE_ID } });

    await leadsService.createIntakeForm(LAW_FIRM_ID, { name: 'Intake' });
    await leadsService.updateIntakeForm(LAW_FIRM_ID, TEMPLATE_ID, { name: 'Renamed' });

    expect(api.calls('POST')[0].pathname).toMatch(/\/intake-forms$/);
    expect(api.calls('PUT')[0].pathname).toMatch(/\/intake-forms\/tpl-2$/);
  });

  it('sends the authored fields in order on a create', async () => {
    api.post('/intake-forms', { template: { id: 't-new' } });

    await leadsService.createIntakeForm(LAW_FIRM_ID, {
      name: 'Intake',
      fields: [
        { key: 'name', label: 'Full name', type: 'text' },
        { key: 'email', label: 'Email', type: 'email' },
      ],
    });

    const fields = bodyOf(api.calls('POST')[0]).fields as Array<{ key: string }>;
    // What leaves the browser is what the public form becomes.
    expect(fields.map((f) => f.key)).toEqual(['name', 'email']);
  });

  it('regenerates a token through its OWN endpoint, not through an update', async () => {
    api.post(`/intake-forms/${TEMPLATE_ID}/regenerate-token`, { template: { id: TEMPLATE_ID } });

    await leadsService.regenerateIntakeFormToken(LAW_FIRM_ID, TEMPLATE_ID);

    // Regenerating invalidates every link the firm has already handed out. It
    // must never be reachable by an ordinary save.
    const call = api.calls('POST')[0];
    expect(call.pathname).toMatch(/\/intake-forms\/tpl-2\/regenerate-token$/);
    expect(call.body).toBeNull();
  });

  it('deletes a template with DELETE on its own url', async () => {
    api.delete(`/intake-forms/${TEMPLATE_ID}`, { message: 'Deleted' });

    await leadsService.deleteIntakeForm(LAW_FIRM_ID, TEMPLATE_ID);

    expect(api.calls('DELETE')[0].pathname).toMatch(/\/intake-forms\/tpl-2$/);
  });

  it('throws when a template create is refused', async () => {
    api.post('/intake-forms', { status: 400, body: { error: 'Name is required' } });

    await expect(leadsService.createIntakeForm(LAW_FIRM_ID, { name: '' }))
      .rejects.toThrow(/name is required/i);
  });
});

describe('the public intake endpoints', () => {
  const TOKEN = 'pub tok/1';

  it('addresses the form by its token, ENCODED, with no firm in the path', async () => {
    api.get('/intake/pub%20tok%2F1', { template: { id: 't1' } });

    await leadsService.getPublicIntakeForm(TOKEN);

    // The token is the only thing identifying the form, and a stranger holds it.
    // Left unencoded, a token containing a slash becomes an extra path segment
    // and the request reaches a different route entirely.
    expect(api.calls('GET')[0].pathname).toMatch(/\/intake\/pub%20tok%2F1$/);
  });

  it('sends NO credential on the public read', async () => {
    api.get('/intake/pub%20tok%2F1', { template: { id: 't1' } });

    await leadsService.getPublicIntakeForm(TOKEN);

    // `publicFetch`, not `apiFetch`. A form filled in by a stranger must not
    // carry a signed-in firm member's bearer token to the server.
    expect(api.calls('GET')[0].headers.authorization).toBeUndefined();
  });

  it('THROWS on a wrong access code rather than returning a verdict', async () => {
    api.post('/intake/tok-1/verify-access-code', {
      status: 401, body: { error: 'Incorrect access code' },
    });

    // Recorded as the contrast with `signatures.verifyAccessCode`, which answers
    // `{ verified: false }` for the same situation. The two public code checks in
    // this app fail in opposite ways, so a caller cannot handle them alike.
    await expect(leadsService.verifyPublicIntakeAccessCode('tok-1', '0000'))
      .rejects.toThrow(/incorrect access code/i);
  });

  it('puts the access code in the BODY, never the query', async () => {
    api.post('/intake/tok-1/verify-access-code', { verified: true });

    await leadsService.verifyPublicIntakeAccessCode('tok-1', 's3cret');

    // A code in the query string lands in server logs, proxy logs and browser
    // history.
    const call = api.calls('POST')[0];
    expect(bodyOf(call).code).toBe('s3cret');
    expect(call.url).not.toContain('s3cret');
  });

  it('submits answers to the SUBMIT route with the access code alongside them', async () => {
    api.post('/intake/tok-1/submit', { id: 'sub-1' });

    await leadsService.submitPublicIntakeForm('tok-1', {
      fieldValues: { name: 'Pat Prospect', detail: 'Rear-ended on the M4' },
      accessCode: 's3cret',
    });

    const call = api.calls('POST')[0];
    // Submit and verify are different routes. A submission sent to the verifier
    // checks the code and stores nothing, so the prospect sees a thank-you page
    // for an enquiry the firm never receives.
    expect(call.pathname).toMatch(/\/intake\/tok-1\/submit$/);
    expect(bodyOf(call).fieldValues).toEqual({
      name: 'Pat Prospect', detail: 'Rear-ended on the M4',
    });
    expect(bodyOf(call).accessCode).toBe('s3cret');
  });

  it('throws when a submission is refused', async () => {
    api.post('/intake/tok-1/submit', { status: 410, body: { error: 'This form is closed' } });

    // The prospect must not be told their enquiry was received.
    await expect(leadsService.submitPublicIntakeForm('tok-1', { fieldValues: {} }))
      .rejects.toBeDefined();
  });
});
