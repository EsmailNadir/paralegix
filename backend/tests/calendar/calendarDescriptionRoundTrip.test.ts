/**
 * A description Paralegix pushes to Google or Outlook comes back on every
 * inbound change, and what comes back is written into the entity's notes. So
 * whatever the builder adds (the client section, the type label, the location
 * line, the link back to Paralegix and the source marker) has to come off
 * again exactly, or it is added a second time on the next push and the notes
 * grow by one header per round trip.
 *
 * The strip also has to know what it did NOT write: a description from a
 * colleague's invitation that happens to open with "Client:" or "Location:"
 * is someone's real text, and is kept.
 */
jest.mock('../../src/shared/database/queryContext', () => ({
  privilegedParameterizedQuery: jest.fn(),
}));

import { privilegedParameterizedQuery } from '../../src/shared/database/queryContext';
import {
  buildClientEventCalendarDescription,
  buildExternalEventCalendarDescription,
  buildMatterEventCalendarDescription,
  buildTaskCalendarDescription,
  buildBillingCalendarDescription,
} from '../../src/modules/calendar/shared/calendarDescriptionBuilder';
import {
  cleanHtmlContent,
  isParalegixOriginated,
  stripCalendarHeader,
  stripSourceMarker,
} from '../../src/modules/calendar/shared/calendarHelpers';
import { ADAPTERS } from '../../src/modules/calendar/shared/calendarAdapters';

const queryMock = privilegedParameterizedQuery as jest.Mock;
const FIRM = '11111111-1111-4111-8111-111111111111';
const MATTER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const TASK = '44444444-4444-4444-8444-444444444444';
const EVENT = '55555555-5555-4555-8555-555555555555';
const INVOICE = '66666666-6666-4666-8666-666666666666';
const APP = 'https://app.paralegix.test';
// The marker separator older pushes wrote, built rather than typed.
const OLD_DASH = String.fromCharCode(0x2014);

const originalFrontendUrl = process.env.FRONTEND_URL;

beforeEach(() => {
  process.env.FRONTEND_URL = `${APP}/`;
  queryMock.mockReset();
  // Every client lookup answers with two clients, so the multi-client section
  // (the hardest header to strip) is always present.
  queryMock.mockImplementation(async (_why: string, text: string) => {
    if (/from invoices/.test(text)) return { rows: [{ law_firm_id: FIRM }] };
    return { rows: [
      { id: CLIENT, name: 'Acme Holdings', phone: '555-0100' },
      { id: '77777777-7777-4777-8777-777777777777', name: 'Bea Ward', phone: null },
    ] };
  });
});

afterAll(() => {
  if (originalFrontendUrl === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = originalFrontendUrl;
});

/** Build the description an adapter would push for one entity kind. */
const KINDS = {
  task: (notes: string) => buildTaskCalendarDescription(
    { id: TASK, lawFirmId: FIRM, matterId: MATTER, title: 'Draft reply', description: notes },
    '(Task from Paralegix)',
  ),
  matterEvent: (notes: string) => buildMatterEventCalendarDescription(
    { id: EVENT, lawFirmId: FIRM, matterId: MATTER, type: 'hearing', title: 'Status hearing', locationName: 'Courtroom 4', notes },
    '(Matter event from Paralegix)',
  ),
  clientEvent: (notes: string) => buildClientEventCalendarDescription(
    { id: EVENT, lawFirmId: FIRM, clientId: CLIENT, type: 'meeting', title: 'Intake call', notes },
    '(Client event from Paralegix)',
  ),
  externalEvent: (notes: string) => buildExternalEventCalendarDescription(
    { id: EVENT, lawFirmId: FIRM, title: 'Lunch with co-counsel', notes },
    '(External event from Paralegix)',
  ),
} as const;

/** What Exchange hands back for a body Paralegix pushed as plain text. */
const asExchangeHtml = (text: string) => `<html><head><style>p{margin:0}</style></head><body><div class="PlainText">${
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>\r\n')
}</div></body></html>`;

describe('the source marker', () => {
  it('comes off in the parenthesized form the adapters write', () => {
    expect(stripSourceMarker('Review the brief\n\n(Task from Paralegix)')).toBe('Review the brief');
    expect(stripSourceMarker('(Matter event from Paralegix)')).toBe('');
  });

  it('comes off in each older form too', () => {
    expect(stripSourceMarker(`Review the brief\n\n${OLD_DASH} Task from Paralegix`)).toBe('Review the brief');
    expect(stripSourceMarker('Review the brief\nClient event from Paralegix')).toBe('Review the brief');
  });

  it('stripping twice changes nothing', () => {
    const once = stripSourceMarker('Bring exhibits (A, B)\n\n(Task from Paralegix)');
    expect(once).toBe('Bring exhibits (A, B)');
    expect(stripSourceMarker(once)).toBe(once);
  });

  it('every adapter writes a marker the originated check recognizes', async () => {
    for (const adapter of Object.values(ADAPTERS)) {
      expect(isParalegixOriginated(`Notes\n\n(${adapter.sourceMarker})`)).toBe(true);
    }
  });
});

describe('the link back to Paralegix', () => {
  it('points each pushed entity at its own page in the app', async () => {
    expect(await KINDS.task('x')).toContain(`Open in Paralegix: ${APP}/lawfirm/${FIRM}/tasks/${TASK}`);
    expect(await KINDS.matterEvent('x')).toContain(`Open in Paralegix: ${APP}/lawfirm/${FIRM}/matters/${MATTER}?tab=events`);
    expect(await KINDS.clientEvent('x')).toContain(`Open in Paralegix: ${APP}/lawfirm/${FIRM}/clients/${CLIENT}?tab=events`);
  });

  it('points a standalone task at its task page, not a matter', async () => {
    const description = await buildTaskCalendarDescription(
      { id: TASK, lawFirmId: FIRM, title: 'Call clerk' }, '(Task from Paralegix)',
    );
    expect(description).toContain(`Open in Paralegix: ${APP}/lawfirm/${FIRM}/tasks/${TASK}`);
  });

  it('points a billing date at the invoice under its matter or its client', async () => {
    const item = { billingItemType: 'invoice_due_date', scheduledAmount: 100, scheduledDate: '2026-11-01' };
    expect(await buildBillingCalendarDescription(
      { id: INVOICE, matterId: MATTER, invoiceNumber: 'INV-9' }, item, '(Billing item from Paralegix)',
    )).toContain(`Open in Paralegix: ${APP}/lawfirm/${FIRM}/matters/${MATTER}/invoices/${INVOICE}`);
    expect(await buildBillingCalendarDescription(
      { id: INVOICE, clientContextId: CLIENT, invoiceNumber: 'INV-9' }, item, '(Billing item from Paralegix)',
    )).toContain(`Open in Paralegix: ${APP}/lawfirm/${FIRM}/clients/${CLIENT}/invoices/${INVOICE}`);
  });

  it('sits directly above the marker, at the end', async () => {
    const description = await KINDS.matterEvent('Bring exhibits');
    expect(description.endsWith(`Open in Paralegix: ${APP}/lawfirm/${FIRM}/matters/${MATTER}?tab=events\n(Matter event from Paralegix)`)).toBe(true);
  });

  it('follows the environment the server runs in', async () => {
    process.env.FRONTEND_URL = 'https://staging.paralegix.com';
    expect(await KINDS.task('x')).toContain(`Open in Paralegix: https://staging.paralegix.com/lawfirm/${FIRM}/tasks/${TASK}`);
  });

  it('is left out for an entity with no page to open', async () => {
    const description = await KINDS.externalEvent('x');
    expect(description).not.toContain('Open in Paralegix');
  });
});

describe('stripping what Paralegix wrote', () => {
  it('removes the external event header, so it does not stack up on each round trip', async () => {
    const pushed = await KINDS.externalEvent('Bring the term sheet');
    expect(stripCalendarHeader(pushed)).toBe('Bring the term sheet');
  });

  it('leaves a third-party description that opens with lines shaped like a header', () => {
    const invite = 'Client: Smith & Co\nLocation: Zoom\nMeeting: kickoff\nAgenda below';
    expect(stripCalendarHeader(invite)).toBe(invite);
  });

  it('leaves a third-party clients list and the body under it', () => {
    const invite = 'Clients:\nJohn Doe - 555-1234\nReview discovery materials.';
    expect(stripCalendarHeader(invite)).toBe(invite);
  });

  it('keeps notes that start with a header-shaped line of their own', async () => {
    const notes = 'Location: the parking garage entrance on 5th\n\nClient: ask about the lease';
    expect(stripCalendarHeader(await KINDS.matterEvent(notes))).toBe(notes);
    expect(stripCalendarHeader(await KINDS.task(notes))).toBe(notes);
  });

  it('removes the link line even when a provider moved text below the marker', async () => {
    const pushed = await KINDS.task('Call opposing counsel');
    const withTeams = `${pushed}\n\nMicrosoft Teams meeting\nJoin the meeting now (https://teams.microsoft.com/l/x)`;
    expect(stripCalendarHeader(withTeams)).toBe(
      'Call opposing counsel\n\nMicrosoft Teams meeting\nJoin the meeting now (https://teams.microsoft.com/l/x)',
    );
  });
});

// ── round trip: build -> strip -> build is stable ───────────────────────────

/** A small seeded generator, so a failure names a reproducible case. */
function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const FRAGMENTS = [
  'Bring the signed affidavit.',
  'Location: rear entrance',
  'Client: wants a call first',
  'Clients:',
  'Hearing: continued from May',
  'External event: not ours',
  'Fees < $500 & costs',
  '- exhibit A',
  '1. file the motion',
  'See https://drive.example.test/doc?id=1&x=2',
  '(bring two copies)',
  'Meeting ID: 271 384 990',
  'Paralegix is mentioned here',
];

function randomNotes(next: () => number) {
  const paragraphs: string[] = [];
  const count = 1 + Math.floor(next() * 4);
  for (let p = 0; p < count; p += 1) {
    const lines: string[] = [];
    const lineCount = 1 + Math.floor(next() * 3);
    for (let l = 0; l < lineCount; l += 1) {
      lines.push(FRAGMENTS[Math.floor(next() * FRAGMENTS.length)]);
    }
    paragraphs.push(lines.join('\n'));
  }
  return paragraphs.join('\n\n');
}

describe.each(Object.keys(KINDS) as (keyof typeof KINDS)[])('round trip of a %s description', (kind) => {
  const build = KINDS[kind];

  it('strips back to exactly the notes that were pushed, for 200 generated notes', async () => {
    const next = prng(kind.length * 7919);
    for (let i = 0; i < 200; i += 1) {
      const notes = randomNotes(next);
      const pushed = await build(notes);
      expect({ notes, back: stripCalendarHeader(pushed) }).toEqual({ notes, back: notes });
    }
  });

  it('build -> strip -> build is stable, through Google plain text and Outlook HTML alike', async () => {
    const next = prng(kind.length * 104729);
    for (let i = 0; i < 100; i += 1) {
      const notes = randomNotes(next);
      const pushed = await build(notes);
      const viaGoogle = await build(stripCalendarHeader(cleanHtmlContent(pushed)));
      const viaOutlook = await build(stripCalendarHeader(cleanHtmlContent(asExchangeHtml(pushed))));
      expect({ notes, viaGoogle }).toEqual({ notes, viaGoogle: pushed });
      expect({ notes, viaOutlook }).toEqual({ notes, viaOutlook: pushed });
    }
  });

  it('an empty description round-trips to empty', async () => {
    expect(stripCalendarHeader(await build(''))).toBe('');
  });
});


describe.each(Object.keys(KINDS) as (keyof typeof KINDS)[])('provider-wrapped %s markers', (kind) => {
  it('removes parentheses when the provider wraps the marker onto separate lines', async () => {
    const pushed = await KINDS[kind]('');
    const wrapped = pushed.replace(/\(([^()]+ from Paralegix)\)/, '(\n$1\n)');
    expect(stripCalendarHeader(cleanHtmlContent(wrapped))).toBe('');
    expect(stripCalendarHeader(cleanHtmlContent(asExchangeHtml(wrapped)))).toBe('');
  });

  it('keeps real notes and their parentheses beside a wrapped marker', async () => {
    const notes = 'Bring exhibits (A, B).';
    const pushed = await KINDS[kind](notes);
    const wrapped = pushed.replace(/\(([^()]+ from Paralegix)\)/, '(\n$1\n)');
    expect(stripCalendarHeader(cleanHtmlContent(wrapped))).toBe(notes);
    expect(stripCalendarHeader(cleanHtmlContent(asExchangeHtml(wrapped)))).toBe(notes);
  });
});


describe('source labels within real notes', () => {
  it.each([
    'Discuss the Task from Paralegix with counsel.',
    'Client: ask about the Matter event from Paralegix tomorrow.',
    'Keep (Task from Paralegix) as an example in this sentence.',
  ])('preserves %j and does not classify it as a generated event', (notes) => {
    expect(stripSourceMarker(notes)).toBe(notes);
    expect(stripCalendarHeader(notes)).toBe(notes);
    expect(isParalegixOriginated(notes)).toBe(false);
  });

  it('recognizes a real footer after Outlook converts it to HTML', async () => {
    expect(isParalegixOriginated(asExchangeHtml(await KINDS.task('Bring exhibits')))).toBe(true);
  });
});
