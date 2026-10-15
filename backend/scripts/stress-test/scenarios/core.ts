import { requireOk } from '../client';
import { think, type Vu } from '../vu';

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

/** One pass through the screens a firm member uses all day. */
export async function coreSession(vu: Vu): Promise<void> {
  const { api } = vu;
  const firm = `/api/lawfirms/${vu.lawFirmId}`;

  await Promise.all([
    api.call('core.profile', 'GET', '/api/users/profile'),
    api.call('core.myLawfirms', 'GET', '/api/users/my-lawfirms'),
    api.call('core.membersMe', 'GET', `${firm}/members/me`),
    api.call('core.dashboard', 'GET', `${firm}/dashboard-summary`),
  ]);
  await think();

  await api.call('core.matters.list', 'GET', `${firm}/matters?page=1&limit=25`);
  if (!vu.state.matterId) {
    const created = requireOk(
      await api.call('core.matters.create', 'POST', `${firm}/matters`, { name: `Stress matter ${vu.index}` }),
      'core.matters.create',
    );
    vu.state.matterId = created.matterId;
  }
  await think();

  await api.call('core.matters.detail', 'GET', `${firm}/matters/${vu.state.matterId}`);
  await think();

  await Promise.all([
    api.call('core.tasks.list', 'GET', `${firm}/tasks?page=1&limit=25`),
    api.call('core.tasks.statusCounts', 'GET', `${firm}/tasks/status-counts`),
  ]);
  await api.call('core.tasks.create', 'POST', `${firm}/tasks`, { title: `Stress task ${Date.now()}`, skipCalendarEvent: true });
  await think();

  await api.call('core.timeEntries.list', 'GET', `${firm}/billing/time-entries/firm`);
  await api.call('core.timeEntries.create', 'POST', `${firm}/billing/time-entries`, {
    matterId: vu.state.matterId,
    userId: vu.uid,
    hours: 0.25,
    date: today(),
    description: 'Stress test entry',
  });
  await think();

  await api.call('core.invoices.list', 'GET', `${firm}/billing/invoices/firm`);
  await think();

  await api.call('core.clients.list', 'GET', `${firm}/clients?page=1&limit=25`);
  await think();

  await Promise.all([
    api.call('core.messaging.conversations', 'GET', `${firm}/messaging/conversations`),
    api.call('core.messaging.unread', 'GET', `${firm}/messaging/unread-count`),
  ]);
}
