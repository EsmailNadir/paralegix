/**
 * LIVE smoke test of the frontend service classes against a running backend.
 *
 * Each case calls one real read endpoint with a real Firebase token and checks
 * the response has the shape the service promises. What it catches is a route,
 * envelope or auth contract that drifted between the two halves of the app,
 * which the offline suites cannot see because they fake the transport.
 *
 * Excluded from `npm test`; run with `npm run test:integration`. See
 * `tests/services/README.md` for the backend, token and env it needs.
 */
jest.mock('@/lib/utils/auth', () =>
  jest.requireActual('../support/liveAuth').liveAuthUtilsModule());
jest.mock('@/lib/firebase/config', () =>
  jest.requireActual('../support/liveAuth').liveFirebaseConfigModule());

import authService from '@/services/auth.service';
import billingService from '@/services/billing.service';
import { chargeCodesService } from '@/services/chargeCodes.service';
import clientsService from '@/services/clients.service';
import courtsService from '@/services/courts.service';
import filesService from '@/services/files.service';
import lawFirmService from '@/services/lawfirm.service';
import matterEventsService from '@/services/matterEvents.service';
import MattersService from '@/services/matters.service';
import messagesService from '@/services/messages.service';
import practiceAreaService from '@/services/practiceArea.service';
import rolesService from '@/services/roles.service';
import settingsService from '@/services/settings.service';
import signaturesService from '@/services/signatures.service';
import tasksService from '@/services/tasks.service';
import { templatesService } from '@/services/templates.service';
import trustService from '@/services/trust.service';
import userService from '@/services/users.service';
import { getAnyMatterId, getLawFirmId } from './testUtils';

let lawFirmId: string;
let matterId: string | null = null;
let disposableMatterId: string | null = null;

beforeAll(async () => {
  lawFirmId = await getLawFirmId();
  matterId = await getAnyMatterId(lawFirmId);
  if (!matterId && lawFirmId) {
    try {
      const created = await MattersService.createMatter({ lawFirmId, name: 'Live Read Fixture' } as never);
      if (created?.matterId) {
        matterId = created.matterId;
        disposableMatterId = created.matterId;
      }
    } catch {
      // live creation fallback
    }
  }
});

afterAll(async () => {
  if (disposableMatterId && lawFirmId) {
    try {
      await MattersService.deleteMatter(lawFirmId, disposableMatterId);
    } catch {
      // cleanup best effort
    }
  }
});

const isList = (value: unknown) => expect(Array.isArray(value)).toBe(true);

type Check = (result: any) => void;

/** One live read, and what its response must look like. */
const READS: Array<[label: string, call: (firmId: string) => Promise<unknown>, check: Check]> = [
  ['tasks: firm tasks', (id) => tasksService.listLawFirmTasks(id), isList],
  ['roles: roles', (id) => rolesService.listRoles(id), isList],
  ['practiceArea: practice areas', (id) => practiceAreaService.listPracticeAreas(id), (r) => isList(r.practiceAreas)],
  ['courts: courts', (id) => courtsService.listCourts(id), (r) => isList(r.courts)],
  ['chargeCodes: charge codes', (id) => chargeCodesService.getChargeCodes(id), (r) => isList(r.chargeCodes)],
  ['signatures: signing sessions', (id) => signaturesService.listSigningSessions(id), (r) => isList(r.sessions)],
  ['trust: accounts', (id) => trustService.listAccounts(id), isList],
  ['trust: transactions', (id) => trustService.listTransactions(id), isList],
  ['templates: templates', (id) => templatesService.list(id), isList],
  ['templates: folders', (id) => templatesService.listFolders(id), isList],
  ['messages: firm conversations', (id) => messagesService.getFirmConversations(id), isList],
  ['messages: unread count', (id) => messagesService.getUnreadCount(id), (r) => expect(typeof r).toBe('number')],
  ['lawfirm: firm details', (id) => lawFirmService.getLawFirmById(id), (r) => expect(r).toEqual(expect.any(Object))],
  ['lawfirm: members', (id) => lawFirmService.getLawFirmMembers(id), isList],
  ['billing: workbench', (id) => billingService.getBillingWorkbench(id), (r) => expect(r).toEqual(expect.any(Object))],
  ['billing: plans', (id) => billingService.listPlans(id), isList],
  ['settings: firm settings', (id) => settingsService.getFirmSettings(id), (r) => expect(r).toEqual(expect.any(Object))],
  ['settings: user settings', (id) => settingsService.getUserSettings(id), (r) => expect(r).toHaveProperty('preferences')],
  ['files: firm files', (id) => filesService.listLawFirmFiles(id), (r) => isList(r.files)],
  ['matterEvents: all events', (id) => matterEventsService.listAllEvents(id), (r) => isList(r.events)],
  ['clients: clients', (id) => clientsService.listClients(id), isList],
  ['users: profile', () => userService.getProfile(), (r) => expect(r).toEqual(expect.any(Object))],
  [
    'users: my law firms',
    () => userService.getMyLawFirms(),
    (r) => expect(Array.isArray(r.lawFirmIds) || Array.isArray(r.lawFirms)).toBe(true),
  ],
  ['auth: calendar access', () => authService.checkCalendarAccess(), (r) => expect(typeof r).toBe('boolean')],
  ['auth: microsoft connection', () => authService.checkMicrosoftConnection(), (r) => expect(typeof r).toBe('boolean')],
];

describe('live service reads', () => {
  it.each(READS)('%s', async (_label, call, check) => {
    check(await call(lawFirmId));
  });
});

/** Reads scoped to one matter. When the test firm has no matter these make no request and pass. */
const MATTER_READS: Array<[label: string, call: (firmId: string, matterId: string) => Promise<unknown>, check: Check]> = [
  ['files: matter files', (id, m) => filesService.listMatterFiles(id, m), (r) => isList(r.files)],
  ['matterEvents: matter events', (id, m) => matterEventsService.listEvents(id, m), (r) => isList(r.events)],
];

describe('live matter-scoped reads', () => {
  it.each(MATTER_READS)('%s', async (_label, call, check) => {
    if (!matterId) {
      console.warn('Skipping matter-scoped live read: no matter fixture available');
      return;
    }
    check(await call(lawFirmId, matterId));
  });
});

describe('live matter lifecycle', () => {
  let createdMatterId: string | null = null;

  afterAll(async () => {
    if (createdMatterId) {
      await MattersService.deleteMatter(lawFirmId, createdMatterId);
    }
  });

  it('runs create/list/update/delete against live backend', async () => {
    const created = await MattersService.createMatter({ lawFirmId, name: `__TEST__ FE ${Date.now()}` });
    createdMatterId = created.matterId;
    expect(typeof created.matterId).toBe('string');

    const list = await MattersService.getMatters(lawFirmId);
    expect(list.some((c) => c.id === createdMatterId)).toBe(true);

    const updated = await MattersService.updateMatter({ lawFirmId, matterId: createdMatterId, name: '__TEST__ FE Updated' });
    expect(updated).toHaveProperty('message');

    const deleted = await MattersService.deleteMatter(lawFirmId, createdMatterId);
    expect(deleted).toHaveProperty('message');
    createdMatterId = null;
  });
});
