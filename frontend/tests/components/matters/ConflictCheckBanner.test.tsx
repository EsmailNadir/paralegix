/**
 * ConflictCheckBanner, driven through the REAL matters service against a fake
 * transport.
 *
 * The banner is a safety control: it is the only place at intake that says "the
 * firm may already act against this party". A spec for it has to be able to fail
 * for the two ways it can actually go wrong - asking the server the wrong
 * question, and describing the answer wrongly - so `tests/setup.ts`'s service
 * Proxy (every method resolves to `{}`) is unmocked here and only `fetch` is
 * faked. That leaves the url, the request body, and the response parsing real.
 */
jest.unmock('@/services/matters.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';

import { installApiMock, type ApiMock } from '../../support/apiMock';
import ConflictCheckBanner from '@/components/matterComp/ConflictCheckBanner';

const LAW_FIRM_ID = 'firm-1';
const CONFLICT_URL = `/api/lawfirms/${LAW_FIRM_ID}/matters/conflict-check`;

/** The banner debounces every keystroke by this much before it asks the server. */
const DEBOUNCE_MS = 500;

let api: ApiMock;

beforeEach(() => {
  jest.useFakeTimers();
  api = installApiMock();
});

afterEach(() => {
  api.restore();
  jest.useRealTimers();
});

/** Let the debounce elapse and the resulting request settle. */
async function settleDebounce() {
  await act(async () => {
    jest.advanceTimersByTime(DEBOUNCE_MS);
  });
  await act(async () => {});
}

describe('ConflictCheckBanner', () => {
  it('asks nothing at all when there is no party to check', async () => {
    const { container } = render(
      <ConflictCheckBanner lawFirmId={LAW_FIRM_ID} clients={[]} />,
    );

    await settleDebounce();

    // Goes red if the guard on `hasInput` is dropped: an empty check would send
    // the firm's whole client list back as "matches".
    expect(api.calls()).toHaveLength(0);
    expect(container.firstChild).toBeNull();
  });

  it('sends an organization client legal name as an organization, not only as a name', async () => {
    api.postExact(CONFLICT_URL, { hasConflicts: false, conflicts: [] });

    render(
      <ConflictCheckBanner
        lawFirmId={LAW_FIRM_ID}
        clients={[
          { name: 'Wayne Enterprises', clientType: 'company' },
          { name: 'Selina Kyle', email: 'selina@wayne.test', organization: 'Wayne Enterprises', clientType: 'person' },
        ]}
        excludeClientIds={['client-9']}
      />,
    );

    await settleDebounce();

    const [call] = api.callsTo('/conflict-check');
    expect(call.method).toBe('POST');
    // An ORGANIZATION client keeps its legal name in `name` and leaves
    // `organization` empty. Reading `organization` alone never asked the
    // organization question about the party the matter is being opened for, so
    // this goes red the moment that mapping regresses.
    expect(call.body).toEqual({
      names: ['Wayne Enterprises', 'Selina Kyle'],
      emails: ['selina@wayne.test'],
      organizations: ['Wayne Enterprises', 'Wayne Enterprises'],
      excludeClientIds: ['client-9'],
    });
  });

  it('debounces a party still being typed into one request for the settled value', async () => {
    api.postExact(CONFLICT_URL, { hasConflicts: false, conflicts: [] });

    const { rerender } = render(
      <ConflictCheckBanner lawFirmId={LAW_FIRM_ID} clients={[{ name: 'Way' }]} />,
    );
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    rerender(<ConflictCheckBanner lawFirmId={LAW_FIRM_ID} clients={[{ name: 'Wayne' }]} />);

    await settleDebounce();

    // One request, for the final value. Losing the debounce sends a request per
    // keystroke at a route that scans every client and contact in the firm.
    expect(api.callsTo('/conflict-check')).toHaveLength(1);
    expect(api.callsTo('/conflict-check')[0].body).toMatchObject({ names: ['Wayne'] });
  });

  it('names the matching client and the matter the match sits on', async () => {
    api.postExact(CONFLICT_URL, {
      hasConflicts: true,
      conflicts: [
        {
          matchType: 'name',
          matchValue: 'Wayne Enterprises',
          partyType: 'client',
          partyName: 'Wayne Enterprises',
          matterName: 'Gotham Pier Dispute',
        },
      ],
    });

    render(
      <ConflictCheckBanner
        lawFirmId={LAW_FIRM_ID}
        clients={[{ name: 'Wayne Enterprises', clientType: 'company' }]}
      />,
    );

    await settleDebounce();

    expect(screen.getByText('Review possible conflict')).toBeInTheDocument();
    // The curly quotes are the literal characters the component emits.
    expect(
      screen.getByText('Name “Wayne Enterprises” matches client “Wayne Enterprises” on matter “Gotham Pier Dispute”.'),
    ).toBeInTheDocument();
  });

  it('calls an opposing party an opposing party rather than a client', async () => {
    api.postExact(CONFLICT_URL, {
      hasConflicts: true,
      conflicts: [
        {
          matchType: 'email',
          matchValue: 'lex@lexcorp.test',
          partyType: 'contact',
          contactCategory: 'opposing_party',
          partyName: 'Lex Luthor',
          matterName: 'Metropolis Zoning',
        },
      ],
    });

    render(
      <ConflictCheckBanner
        lawFirmId={LAW_FIRM_ID}
        clients={[{ name: 'Lex Luthor', email: 'lex@lexcorp.test' }]}
      />,
    );

    await settleDebounce();

    // A directory match is at least as serious as a client match, and telling a
    // lawyer the opposing party is a "client" is the wrong fact. Collapsing the
    // contact branch back to "client" turns this red.
    expect(
      screen.getByText('Email “lex@lexcorp.test” matches Opposing Party “Lex Luthor” on matter “Metropolis Zoning”.'),
    ).toBeInTheDocument();
  });

  it('stays silent when the check comes back clean', async () => {
    api.postExact(CONFLICT_URL, { hasConflicts: false, conflicts: [] });

    const { container } = render(
      <ConflictCheckBanner
        lawFirmId={LAW_FIRM_ID}
        clients={[{ name: 'Clean Client', email: 'clean@example.com' }]}
      />,
    );

    await settleDebounce();

    await waitFor(() => expect(api.callsTo('/conflict-check')).toHaveLength(1));
    // Proving the request ran first is the point: an empty banner asserted on
    // its own passes just as well when the check never happened.
    expect(container.firstChild).toBeNull();
  });

  it('keeps the newest edit\'s result, even when an earlier edit\'s slower check arrives after it', async () => {
    // `clearTimeout` on the debounce only cancels a pending, not-yet-fired
    // timer - once "Way"'s check is actually in flight, editing to "Wayne
    // Enterprises" can't stop it. Its slower response landing after the
    // clean "Wayne Enterprises" check used to silently show a conflict for a
    // name the user has since corrected.
    api.postExact(CONFLICT_URL, (call) => {
      const body = call.body as { names: string[] };
      if (body.names[0] === 'Way') {
        return new Promise((resolve) =>
          setTimeout(() => resolve({
            hasConflicts: true,
            conflicts: [{ matchType: 'name', matchValue: 'Way', partyType: 'client', partyName: 'Way Corp', matterName: 'Old Matter' }],
          }), 1000)
        );
      }
      return new Promise((resolve) => setTimeout(() => resolve({ hasConflicts: false, conflicts: [] }), 50));
    });

    const { rerender } = render(
      <ConflictCheckBanner lawFirmId={LAW_FIRM_ID} clients={[{ name: 'Way' }]} />,
    );
    // Let the "Way" debounce elapse, so its check is genuinely in flight
    // (not just a pending, cancellable timer) before the edit below.
    await act(async () => {
      jest.advanceTimersByTime(DEBOUNCE_MS);
    });

    rerender(<ConflictCheckBanner lawFirmId={LAW_FIRM_ID} clients={[{ name: 'Wayne Enterprises' }]} />);
    await act(async () => {
      jest.advanceTimersByTime(DEBOUNCE_MS);
    });

    // Let both responses land: "Wayne Enterprises" (50ms) first, "Way" (1000ms) after.
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    await act(async () => {});

    expect(api.callsTo('/conflict-check')).toHaveLength(2);
    expect(screen.queryByText('Review possible conflict')).not.toBeInTheDocument();
  });

  it('stays silent when the check itself fails', async () => {
    api.postExact(CONFLICT_URL, { status: 403, body: { error: 'Forbidden' } });

    const { container } = render(
      <ConflictCheckBanner
        lawFirmId={LAW_FIRM_ID}
        clients={[{ name: 'Wayne Enterprises', clientType: 'company' }]}
      />,
    );

    await settleDebounce();

    expect(api.callsTo('/conflict-check')).toHaveLength(1);
    // A failed check must not render as "no conflicts found" wording; the banner
    // is absent because there is nothing it can honestly say.
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText('Review possible conflict')).not.toBeInTheDocument();
  });
});
