/**
 * Where a notification click lands.
 *
 * A notification carries an `actionUrl` when its producer built one. Rows
 * written without one (older rows and seeded demo rows) used to do nothing on
 * click except flip to read, so the destination falls back to the entity the
 * row points at.
 */
import { notificationHref } from '@/components/notificationComp/notificationHref';

const FIRM = 'firm-1';

describe('notificationHref: actionUrl', () => {
  it('keeps only the path, query and hash of an absolute actionUrl', () => {
    expect(notificationHref(
      { actionUrl: 'https://staging.paralegix.com/client/lawfirm/firm-1/documents?clientRecordId=r1#top' },
      'portal', FIRM,
    )).toBe('/client/lawfirm/firm-1/documents?clientRecordId=r1#top');
  });

  it('does not follow an actionUrl to another origin', () => {
    expect(notificationHref({ actionUrl: 'https://evil.example/lawfirm/firm-1/tasks' }, 'firm', FIRM))
      .toBe('/lawfirm/firm-1/tasks');
  });

  it('accepts a relative actionUrl as-is', () => {
    expect(notificationHref({ actionUrl: '/lawfirm/firm-1/billing' }, 'firm', FIRM)).toBe('/lawfirm/firm-1/billing');
  });

  it('prefers actionUrl over the entity fallback', () => {
    expect(notificationHref(
      { actionUrl: '/lawfirm/firm-1/signatures/history', entityType: 'task', entityId: 't1' },
      'firm', FIRM,
    )).toBe('/lawfirm/firm-1/signatures/history');
  });
});

describe('notificationHref: firm fallback without actionUrl', () => {
  const href = (n: Parameters<typeof notificationHref>[0]) => notificationHref(n, 'firm', FIRM);

  it.each([
    [{ entityType: 'task', entityId: 't1' }, '/lawfirm/firm-1/tasks/t1'],
    [{ entityType: 'task' }, '/lawfirm/firm-1/tasks'],
    [{ entityType: 'matter', entityId: 'm1' }, '/lawfirm/firm-1/matters/m1'],
    [{ entityType: 'matter', matterId: 'm2' }, '/lawfirm/firm-1/matters/m2'],
    [{ entityType: 'invoice', entityId: 'i1', matterId: 'm1' }, '/lawfirm/firm-1/billing'],
    [{ entityType: 'message', entityId: 'x1', matterId: 'm1' }, '/lawfirm/firm-1/messages'],
    [{ entityType: 'note', entityId: 'n1', matterId: 'm1' }, '/lawfirm/firm-1/matters/m1?tab=notes'],
    [{ entityType: 'note', entityId: 'n1' }, '/lawfirm/firm-1/notes'],
    [{ entityType: 'file', matterId: 'm1' }, '/lawfirm/firm-1/matters/m1?tab=files'],
    [{ entityType: 'file' }, '/lawfirm/firm-1/files'],
    [{ entityType: null, matterId: 'm1' }, '/lawfirm/firm-1/matters/m1'],
  ])('%j opens %s', (n, expected) => {
    expect(href(n)).toBe(expected);
  });

  it('returns null when the row names nothing to open', () => {
    expect(href({ entityType: null, entityId: null, matterId: null, actionUrl: null })).toBeNull();
  });
});

describe('notificationHref: portal fallback without actionUrl', () => {
  const href = (n: Parameters<typeof notificationHref>[0]) => notificationHref(n, 'portal', FIRM);

  it.each([
    [{ type: 'document_request', entityType: 'matter', matterId: 'm1' }, '/client/lawfirm/firm-1/documents'],
    [{ type: 'document_requested', entityType: 'matter', matterId: 'm1' }, '/client/lawfirm/firm-1/documents'],
    [{ type: 'invoice_paid', entityType: 'invoice', matterId: 'm1' }, '/client/lawfirm/firm-1/billing'],
    [{ type: 'message_received', entityType: 'message', matterId: 'm1' }, '/client/lawfirm/firm-1/messages'],
    [{ type: 'file_shared', entityType: 'file' }, '/client/lawfirm/firm-1/documents'],
    [{ type: 'matter_update', entityType: 'matter', matterId: 'm1' }, '/client/lawfirm/firm-1/matters/m1'],
    [{ type: 'matter_update', entityType: 'matter' }, '/client/lawfirm/firm-1/matters'],
    [{ type: 'task_due', entityType: 'task', matterId: 'm1' }, '/client/lawfirm/firm-1/matters/m1'],
  ])('%j opens %s', (n, expected) => {
    expect(href(n)).toBe(expected);
  });

  it('never sends a portal reader to a firm route', () => {
    expect(href({ entityType: 'task', entityId: 't1' })).toBeNull();
  });

  it('returns null without a firm id', () => {
    expect(notificationHref({ entityType: 'invoice' }, 'portal', undefined)).toBeNull();
  });
});
