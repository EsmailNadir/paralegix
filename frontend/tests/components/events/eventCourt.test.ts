/**
 * `eventCourtName`: which court, if any, an event shows beside its location.
 *
 * A court is a separate fact from where the event happens. It is never folded
 * into the location, so neither one can hide the other.
 */
import { eventCourtName } from '@/components/eventComp/eventCourt';

describe('a client event', () => {
  it('shows the court it was given, whatever its type', () => {
    expect(eventCourtName('client', { type: 'meeting', courtName: 'District Court', locationName: 'Room B' })).toBe('District Court');
  });

  it('does not repeat a court its location name already names', () => {
    expect(eventCourtName('client', { type: 'meeting', courtName: 'District Court', locationName: '  district court ' })).toBeNull();
  });

  it('shows no court when it has none', () => {
    expect(eventCourtName('client', { type: 'hearing', courtName: null, locationName: 'Room B' })).toBeNull();
    expect(eventCourtName('client', { type: 'hearing', courtName: '   ' })).toBeNull();
  });
});

describe('a matter event', () => {
  it.each(['court_date', 'hearing', 'trial', 'filing_deadline', 'appeal_deadline'])(
    'shows the matter court on a %s',
    (type) => {
      expect(eventCourtName('matter', { type, courtName: 'Superior Court', locationName: 'Dept. 12' })).toBe('Superior Court');
    },
  );

  it.each(['deposition', 'mediation', 'arbitration', 'meeting', 'discovery_cutoff', 'statute_of_limitations', 'other'])(
    'shows no matter court on a %s, which is not held at or filed with the court',
    (type) => {
      expect(eventCourtName('matter', { type, courtName: 'Superior Court', locationName: 'Dept. 12' })).toBeNull();
    },
  );

  it('does not repeat a court its location name already names, ignoring case and spacing', () => {
    expect(eventCourtName('matter', { type: 'hearing', courtName: 'Superior Court ', locationName: ' superior court' })).toBeNull();
  });

  it('trims the court it shows', () => {
    expect(eventCourtName('matter', { type: 'trial', courtName: '  Superior Court  ' })).toBe('Superior Court');
  });
});
