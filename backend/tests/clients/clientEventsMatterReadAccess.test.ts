/**
 * The client Events tab merges direct client events with events from every
 * matter linked to that client. Client roster visibility is firm-wide, but
 * matter events remain behind the matter's ethical-wall membership boundary.
 */
import {
  createFirm,
  createPersonClient,
  memberWith,
  ownerOf,
  type Actor,
  type ClientRecord,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let outsider: Actor;
let client: ClientRecord;
let matterId: string;

const clientEventsPath = () => `/api/lawfirms/${firm.id}/clients/${client.id}/events`;
const matterEventsPath = () => `/api/lawfirms/${firm.id}/matters/${matterId}/events`;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  // Deliberately no matter-membership row. The default clients.view grant is
  // enough to open the client record, but must not disclose its confidential
  // matter calendar.
  outsider = await memberWith(firm.id, []);
  client = await createPersonClient(firm.id, { name: 'Event-linked client' });

  const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
    name: 'Ethically walled matter',
    clients: [{ clientId: client.id, name: 'Event-linked client' }],
  });
  expect(matter.status).toBe(201);
  matterId = matter.body.matterId;

  const event = await owner.api.post(matterEventsPath()).send({
    type: 'hearing',
    title: 'Confidential settlement hearing',
    notes: 'Do not disclose this calendar item',
    date: '2026-10-22',
    allDay: true,
  });
  expect(event.status).toBe(201);

  const standalone = await owner.api.post(clientEventsPath()).send({
    type: 'meeting',
    title: 'Visible client-only follow-up',
    date: '2026-10-23',
    allDay: true,
  });
  expect(standalone.status).toBe(201);
});

describe('client-event aggregate matter visibility', () => {
  it('returns the linked matter event to an authorized viewer but withholds it from a non-member', async () => {
    const ownerView = await owner.api.get(clientEventsPath());
    expect(ownerView.status).toBe(200);
    expect(ownerView.body.events.map((event: any) => event.title))
      .toContain('Confidential settlement hearing');
    expect(ownerView.body.events.map((event: any) => event.title))
      .toContain('Visible client-only follow-up');

    const outsiderView = await outsider.api.get(clientEventsPath());
    expect(outsiderView.status).toBe(200);
    expect(outsiderView.body.events.map((event: any) => event.title))
      .toEqual(['Visible client-only follow-up']);
    expect(outsiderView.body.totalEvents).toBe(1);
    expect(JSON.stringify(outsiderView.body)).not.toContain('Confidential settlement hearing');
    expect(JSON.stringify(outsiderView.body)).not.toContain('Do not disclose this calendar item');
  });
});

export {};
