import { createFirm, createPersonClient, ownerOf } from '../support/setupInProcess';

test.each(['matter', 'client'])('%s event keeps its source zone when another zone submits an unchanged schedule', async (source) => {
  const firm = await createFirm();
  const owner = await ownerOf(firm.id);
  const client = await createPersonClient(firm.id, { name: 'Zone client' });
  const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
    name: 'Zone preservation', clients: [{ clientId: client.id, name: 'Zone client' }],
  });
  expect(matter.status).toBe(201);
  const path = source === 'matter'
    ? `/api/lawfirms/${firm.id}/matters/${matter.body.matterId}/events`
    : `/api/lawfirms/${firm.id}/clients/${client.id}/events`;
  const created = await owner.api.post(path).set('x-timezone', 'Pacific/Auckland').send({
    type: 'hearing', title: 'Auckland hearing', date: '2030-11-11T10:00', allDay: false,
  });
  expect(created.status).toBe(201);
  expect(created.body.event.timeZone).toBe('Pacific/Auckland');

  const updated = await owner.api.put(`${path}/${created.body.eventId}`).set('x-timezone', 'America/Los_Angeles').send({
    ...(source === 'client' ? { source } : {}), title: 'Renamed hearing', date: created.body.event.date, allDay: false,
  });
  expect(updated.status).toBe(200);
  expect(updated.body.event.title).toBe('Renamed hearing');
  expect(updated.body.event.date).toBe(created.body.event.date);
  expect(updated.body.event.timeZone).toBe('Pacific/Auckland');

  const moved = await owner.api.put(`${path}/${created.body.eventId}`).set('x-timezone', 'America/Los_Angeles').send({ ...(source === 'client' ? { source } : {}), date: '2030-11-12T14:00' });
  expect(moved.status).toBe(200);
  expect(moved.body.event.date).toBe('2030-11-12T22:00:00.000Z');
  expect(moved.body.event.timeZone).toBe('America/Los_Angeles');
});

test('postponing a matter event records the zone in which its new date was entered', async () => {
  const firm = await createFirm();
  const owner = await ownerOf(firm.id);
  const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({ name: 'Postponed hearing' });
  expect(matter.status).toBe(201);
  const path = `/api/lawfirms/${firm.id}/matters/${matter.body.matterId}/events`;
  const created = await owner.api.post(path).set('x-timezone', 'Pacific/Auckland').send({
    type: 'hearing', title: 'Hearing', date: '2030-11-11T10:00', allDay: false,
  });
  expect(created.status).toBe(201);
  const postponed = await owner.api.post(`${path}/${created.body.eventId}/postpone`).set('x-timezone', 'America/Los_Angeles').send({
    newDate: '2030-11-12T14:00', reason: 'Rescheduled',
  });
  expect(postponed.status).toBe(200);
  expect(postponed.body.event.date).toBe('2030-11-12T22:00:00.000Z');
  expect(postponed.body.event.timeZone).toBe('America/Los_Angeles');
});
