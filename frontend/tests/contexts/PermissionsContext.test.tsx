/**
 * The frontend RBAC core, tested for the first time.
 *
 * Every gated control in the app asks this context whether the viewer may do
 * something. `tests/setup.ts` replaces the whole module with a stub that answers
 * `true`, which is why no spec has ever exercised the real one: the thing that
 * decides access has been mocked out of every test that depends on it.
 *
 * So this file unmocks BOTH the context and the service it reads, and drives the
 * real provider against a fake transport.
 *
 * The context reads ONE endpoint: `GET /api/lawfirms/:id/members/me`, which
 * answers for the caller alone. It used to read the whole firm roster and find
 * itself in the list, so a page mount cost an identity lookup and a signed
 * avatar for every member of the firm. `api.get` matches a pathname SUFFIX, so a
 * route registered at `/members/me` cannot answer a roster read: a context that
 * went back to `/members` would issue an unmatched request, which `restore()`
 * fails.
 */
jest.unmock('@/contexts/PermissionsContext');
jest.unmock('@/services/lawfirm.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { act, screen, waitFor } from '@testing-library/react';

import { setupApiMock, sequence } from '../support/apiMock';
import { holdResponse } from '../support/deferred';
import { renderWithProviders } from '../support/renderWithProviders';
import { PermissionsProvider, usePermissions } from '@/contexts/PermissionsContext';

const LAW_FIRM_ID = 'firm-1';
const USER_ID = 'user-1';

const api = setupApiMock();

/**
 * Renders the context's answers as text, so a case asserts on what a component
 * WOULD be told rather than on internal state.
 */
function Probe({ ask = 'clients.manage', any = [] as string[], all = [] as string[] }) {
  const p = usePermissions();
  if (p.loading) return <div>loading</div>;
  return (
    <div>
      <span data-testid="loadError">{String(p.loadError)}</span>
      <span data-testid="isOwner">{String(p.isOwner)}</span>
      <span data-testid="has">{String(p.hasPermission(ask))}</span>
      <span data-testid="any">{String(p.hasAnyPermission(any))}</span>
      <span data-testid="all">{String(p.hasAllPermissions(all))}</span>
      <span data-testid="count">{p.permissions.length}</span>
      <span data-testid="list">{p.permissions.join(',')}</span>
    </div>
  );
}

function renderProvider(
  probe: React.ReactElement = <Probe />,
  opts: { lawFirmId?: string; userId?: string } = {},
) {
  const lawFirmId = opts.lawFirmId ?? LAW_FIRM_ID;
  // Deliberately NOT a default parameter. `{ userId: undefined }` would trigger a
  // default and silently pass the real user, so the "no user" case below would
  // fetch and prove nothing.
  const userId = 'userId' in opts ? opts.userId : USER_ID;
  return renderWithProviders(
    <PermissionsProvider lawFirmId={lawFirmId} userId={userId}>{probe}</PermissionsProvider>,
  );
}

function providerFor(lawFirmId: string, probe: React.ReactElement = <Probe />) {
  return <PermissionsProvider lawFirmId={lawFirmId} userId={USER_ID}>{probe}</PermissionsProvider>;
}

const text = (id: string) => screen.getByTestId(id).textContent;

describe('resolving the current member', () => {
  it('grants a permission the member explicitly holds', async () => {
    api.get('/members/me', { member: { userId: USER_ID, permissions: ['clients.manage'] } });

    renderProvider();

    await waitFor(() => expect(text('has')).toBe('true'));
  });

  it('refuses a permission the member does not hold', async () => {
    api.get('/members/me', { member: { userId: USER_ID, permissions: ['clients.view'] } });

    renderProvider();

    // The negative half. Without it, a context that returned `true` for
    // everything would satisfy the case above.
    await waitFor(() => expect(text('has')).toBe('false'));
  });

  it('asks only for the caller\'s own membership, once, and never for the roster', async () => {
    api.getExact('/api/lawfirms/firm-1/members/me', {
      member: { userId: USER_ID, permissions: ['clients.manage'] },
    });

    renderProvider();

    await waitFor(() => expect(text('has')).toBe('true'));
    // The whole reason the endpoint exists: one request, for one row. A roster
    // read would be an unmatched request and `restore()` would fail the spec,
    // but the count is asserted too, so a SECOND request cannot hide behind it
    // either.
    expect(api.calls()).toHaveLength(1);
    expect(api.calls()[0].pathname).toBe('/api/lawfirms/firm-1/members/me');
  });

  it('accepts a bare member object as well as an envelope', async () => {
    api.get('/members/me', { userId: USER_ID, permissions: ['clients.manage'] });

    renderProvider();

    await waitFor(() => expect(text('has')).toBe('true'));
  });

  it('gives nothing to a user who is not a member of the firm', async () => {
    api.get('/members/me', { status: 403, body: { error: 'Not a member of this firm' } });

    renderProvider();

    // A non-member is REFUSED by this endpoint rather than merely being absent
    // from a list, and the refusal has to keep meaning "you hold nothing here".
    // Reading it as a transport failure would show a person who simply does not
    // belong to the firm a retry prompt on every gated page, forever.
    await waitFor(() => expect(text('has')).toBe('false'));
    expect(text('count')).toBe('0');
    // And this is NOT a load failure, so a gated page shows its read-only state
    // rather than a retry prompt.
    expect(text('loadError')).toBe('false');
  });

  it('waits for an arriving identity before loading that member\'s firm permissions', async () => {
    api.getExact('/api/lawfirms/firm-a/members/me', {
      member: { userId: USER_ID, permissions: ['test.identity.arrived'] },
    });

    const { rerender } = renderWithProviders(
      <PermissionsProvider lawFirmId="firm-a" userId={undefined}>
        <Probe ask="test.identity.arrived" />
      </PermissionsProvider>,
    );

    await waitFor(() => expect(text('has')).toBe('false'));
    expect(api.calls()).toHaveLength(0);

    rerender(providerFor('firm-a', <Probe ask="test.identity.arrived" />));

    await waitFor(() => expect(text('has')).toBe('true'));
    expect(api.calls()).toHaveLength(1);
    expect(api.calls()[0].pathname).toBe('/api/lawfirms/firm-a/members/me');
  });

  it('does not let a late response for the previous firm overwrite the current firm', async () => {
    const heldFirmA = holdResponse();
    api.getExact('/api/lawfirms/firm-a/members/me', heldFirmA.handler);
    api.getExact('/api/lawfirms/firm-b/members/me', {
      member: { userId: USER_ID, permissions: ['test.transition.b'] },
    });

    const { rerender } = renderWithProviders(providerFor('firm-a', <Probe ask="test.transition.b" />));
    await waitFor(() => expect(api.callsTo('/firm-a/members/me')).toHaveLength(1));

    rerender(providerFor('firm-b', <Probe ask="test.transition.b" />));

    await waitFor(() => expect(text('has')).toBe('true'));
    expect(api.callsTo('/firm-b/members/me')).toHaveLength(1);
    expect(text('list')).toContain('test.transition.b');

    // Firm A lacks Firm B's explicit permission. Releasing it after B is already
    // visible models an older network response arriving during a firm switch.
    await act(async () => {
      heldFirmA.release({ member: { userId: USER_ID, permissions: ['clients.manage'] } });
    });
    expect(text('has')).toBe('true');
    expect(text('list')).toContain('test.transition.b');
    expect(text('list')).not.toContain('clients.manage');
    expect(text('loadError')).toBe('false');
  });

  it('does not let a late failure for the previous firm put the current firm into an error state', async () => {
    let rejectFirmA: ((reason?: unknown) => void) | undefined;
    api.getExact('/api/lawfirms/firm-a/members/me', () => new Promise((_resolve, reject) => {
      rejectFirmA = reject;
    }));
    api.getExact('/api/lawfirms/firm-b/members/me', {
      member: { userId: USER_ID, permissions: ['test.transition.b'] },
    });

    const { rerender } = renderWithProviders(providerFor('firm-a', <Probe ask="test.transition.b" />));
    await waitFor(() => expect(api.callsTo('/firm-a/members/me')).toHaveLength(1));

    rerender(providerFor('firm-b', <Probe ask="test.transition.b" />));
    await waitFor(() => expect(text('has')).toBe('true'));

    await act(async () => {
      rejectFirmA?.(new Error('Firm A connection failed'));
    });

    expect(text('has')).toBe('true');
    expect(text('list')).toContain('test.transition.b');
    expect(text('loadError')).toBe('false');
  });
});

describe('an owner', () => {
  it('holds every permission without any being listed', async () => {
    api.get('/members/me', { member: { userId: USER_ID, isOwner: true, permissions: [] } });

    renderProvider(<Probe ask="anything.at.all" />);

    // Owners short-circuit. A firm owner locked out of their own firm because a
    // permission string was never written down is the failure this prevents.
    await waitFor(() => expect(text('isOwner')).toBe('true'));
    expect(text('has')).toBe('true');
  });
});

describe('a failed load is not the same as no permission', () => {
  it('flags loadError when the request fails', async () => {
    api.get('/members/me', { status: 500, body: { error: 'Server error' } });

    renderProvider();

    // The distinction the context documents. Without the flag a transient
    // network failure renders as "access denied", and the user believes their
    // role changed.
    await waitFor(() => expect(text('loadError')).toBe('true'));
    expect(text('has')).toBe('false');
  });

  it('flags loadError when the caller is not signed in', async () => {
    api.get('/members/me', { status: 401, body: { error: 'Authentication required' } });

    renderProvider();

    // Only a 403 means "not a member of this firm". Every other refusal has to
    // stay a load failure, so a widened check (anything but 200, say) that
    // recorded an expired session as "this person holds nothing here" turns this
    // red. It is the negative half of the 403 case above.
    await waitFor(() => expect(text('loadError')).toBe('true'));
    expect(text('has')).toBe('false');
  });

  it('does NOT flag loadError when the user simply has no permissions', async () => {
    api.get('/members/me', { member: { userId: USER_ID, permissions: [] } });

    renderProvider();

    await waitFor(() => expect(text('loadError')).toBe('false'));
    expect(text('has')).toBe('false');
  });

  it('finishes loading rather than hanging when there is no user', async () => {
    renderProvider(<Probe />, { userId: undefined });

    // No request is made at all, so an implementation that only cleared
    // `loading` in the fetch path would leave every gated page spinning forever.
    await waitFor(() => expect(text('loadError')).toBe('false'));
    expect(api.calls()).toHaveLength(0);
    expect(text('has')).toBe('false');
  });
});

describe('the any/all helpers', () => {
  beforeEach(() => {
    api.get('/members/me', {
      member: { userId: USER_ID, permissions: ['clients.view', 'matters.view'] },
    });
  });

  it('hasAnyPermission is true when one of several is held', async () => {
    renderProvider(<Probe any={['billing.manage', 'matters.view']} />);

    await waitFor(() => expect(text('any')).toBe('true'));
  });

  it('hasAnyPermission is false when none is held', async () => {
    renderProvider(<Probe any={['billing.manage', 'trust.manage']} />);

    await waitFor(() => expect(text('any')).toBe('false'));
  });

  it('hasAllPermissions is true only when every one is held', async () => {
    renderProvider(<Probe all={['clients.view', 'matters.view']} />);

    await waitFor(() => expect(text('all')).toBe('true'));
  });

  it('hasAllPermissions is false when one is missing', async () => {
    renderProvider(<Probe all={['clients.view', 'billing.manage']} />);

    await waitFor(() => expect(text('all')).toBe('false'));
  });

  it('CHARACTERISATION: an EMPTY requirement list is refused, not vacuously granted', async () => {
    renderProvider(<Probe any={[]} all={[]} />);

    // `hasAllPermissions([])` is `false` here. Logically "all of nothing" is
    // true, and `Array.every` alone would return true, so the early return is
    // deliberate.
    //
    // It is the safe direction: a caller that passes an empty list has usually
    // built it from a config that failed to load, and answering `true` would
    // open the control. Recorded so the choice survives a refactor that
    // "simplifies" the early return away.
    await waitFor(() => expect(text('all')).toBe('false'));
    expect(text('any')).toBe('false');
  });
});

describe('the permission list itself', () => {
  it('de-duplicates a permission listed twice', async () => {
    api.get('/members/me', {
      member: {
        userId: USER_ID,
        permissions: ['clients.view'],
        resolvedPermissions: ['clients.view'],
      },
    });

    renderProvider(<Probe ask="clients.view" />);

    // The two fields overlap in practice. A duplicated list is not wrong for
    // `hasPermission`, but it is rendered in the roles UI as the member's
    // permissions and shows the same row twice.
    await waitFor(() => expect(text('has')).toBe('true'));
    const listed = (text('list') ?? '').split(',').filter((c) => c === 'clients.view');
    expect(listed).toHaveLength(1);
  });

  it('merges resolvedPermissions with permissions', async () => {
    api.get('/members/me', {
      member: {
        userId: USER_ID,
        permissions: ['clients.view'],
        resolvedPermissions: ['billing.manage'],
      },
    });

    renderProvider(<Probe all={['clients.view', 'billing.manage']} />);

    // Role-derived and directly-assigned permissions both count. Reading only
    // one field takes half a member's access away.
    await waitFor(() => expect(text('all')).toBe('true'));
  });

  it('ignores non-string junk in the permission arrays', async () => {
    api.get('/members/me', {
      member: { userId: USER_ID, permissions: ['clients.view', null, 42, ''] },
    });

    renderProvider(<Probe ask="clients.view" />);

    // A malformed row must not break the whole context and lock the member out
    // of everything.
    await waitFor(() => expect(text('has')).toBe('true'));
    // Nothing that is not a usable permission code survives into the list, so
    // the roles screen never renders a blank row or the literal "42".
    const codes = (text('list') ?? '').split(',');
    expect(codes.every((c) => c.length > 0)).toBe(true);
    expect(codes).not.toContain('42');
  });

  it('grants the always-on baseline on top of the explicit codes', async () => {
    api.get('/members/me', { member: { userId: USER_ID, permissions: ['clients.view'] } });

    renderProvider(<Probe ask="dashboard.view" />);

    // A member given ONE explicit code still holds the baseline `.view` set. It
    // is why `permissions.length` is 23 and not 1 above, and it is the mechanism
    // behind the read-only-degradation rule: a narrow role can still see the app.
    await waitFor(() => expect(text('has')).toBe('true'));
    expect(Number(text('count'))).toBeGreaterThan(1);
  });
});

describe('the member the context exposes', () => {
  it('is the row the endpoint returned, so consumers read the same shape as before', async () => {
    api.get('/members/me', {
      member: {
        userId: USER_ID,
        id: USER_ID,
        isOwner: false,
        roleId: 'role-7',
        name: 'Dana Reyes',
        email: 'dana@example.test',
        resolvedPermissions: ['clients.manage'],
      },
    });

    function MemberProbe() {
      const p = usePermissions();
      if (p.loading) return <div>loading</div>;
      return <span data-testid="member">{JSON.stringify({
        userId: p.member?.userId, roleId: p.member?.roleId, name: p.member?.name,
      })}</span>;
    }

    renderProvider(<MemberProbe />);

    // The roles screen reads `member.roleId` to label the viewer's own role, so
    // the context value has to keep carrying the whole row and not just the
    // permission list.
    await waitFor(() => expect(text('member')).toBe(
      JSON.stringify({ userId: USER_ID, roleId: 'role-7', name: 'Dana Reyes' }),
    ));
  });

  it('refetches on refresh and reflects a role change', async () => {
    api.get('/members/me', sequence(
      { member: { userId: USER_ID, permissions: ['clients.view'] } },
      { member: { userId: USER_ID, permissions: ['clients.view', 'clients.manage'] } },
    ));

    function RefreshProbe() {
      const p = usePermissions();
      if (p.loading) return <div>loading</div>;
      return (
        <div>
          <span data-testid="has">{String(p.hasPermission('clients.manage'))}</span>
          <button type="button" onClick={() => { void p.refresh(); }}>refresh</button>
        </div>
      );
    }

    renderProvider(<RefreshProbe />);
    await waitFor(() => expect(text('has')).toBe('false'));

    await act(async () => {
      screen.getByText('refresh').click();
    });

    // `refresh` is what the members screen calls after changing a role. A
    // context that cached the first answer would leave the viewer's own UI
    // showing the permissions they used to have.
    await waitFor(() => expect(text('has')).toBe('true'));
    expect(api.callsTo('/members/me')).toHaveLength(2);
  });
});
