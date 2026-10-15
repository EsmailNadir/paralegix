import { eventSectionState, type EventSection } from '@/components/eventComp/eventSectionState';

/**
 * The bug this replaced: both events tabs blanked everything whenever ANY
 * visible section was still loading. Clicking All while Upcoming was on screen
 * therefore threw those events away for a skeleton, which is the collapse and
 * re-expand every other list here avoids.
 */
const section = (over: Partial<EventSection> = {}): EventSection => ({
  visible: true,
  loading: false,
  fetching: false,
  rowCount: 0,
  ...over,
});

describe('eventSectionState', () => {
  it('shows the skeleton on a first load, when there is nothing to keep', () => {
    const state = eventSectionState([
      section({ loading: true, fetching: true }),
      section({ loading: true, fetching: true }),
    ]);

    expect(state.showSkeleton).toBe(true);
  });

  /** The case that was wrong: a chip brings in a section, events already shown. */
  it('keeps the events when one section loads and another already has rows', () => {
    const state = eventSectionState([
      section({ rowCount: 5 }),
      section({ loading: true, fetching: true }),
    ]);

    expect(state.showSkeleton).toBe(false);
    expect(state.busy).toBe(true);
  });

  it('ignores a section the filter is hiding', () => {
    const state = eventSectionState([
      section({ rowCount: 5 }),
      section({ visible: false, loading: true, fetching: true }),
    ]);

    expect(state.showSkeleton).toBe(false);
    expect(state.busy).toBe(false);
  });

  it('lights the indicator for a refetch over rows already held', () => {
    const state = eventSectionState([section({ rowCount: 5, fetching: true })]);

    expect(state.showSkeleton).toBe(false);
    expect(state.busy).toBe(true);
  });

  /** Two acknowledgements for one action read as two separate waits. */
  it('keeps the indicator dark while the skeleton carries the wait', () => {
    const state = eventSectionState([section({ loading: true, fetching: true })]);

    expect(state.showSkeleton).toBe(true);
    expect(state.busy).toBe(false);
  });

  it('shows neither once everything has settled', () => {
    const state = eventSectionState([section({ rowCount: 5 }), section({ rowCount: 2 })]);

    expect(state.showSkeleton).toBe(false);
    expect(state.busy).toBe(false);
  });

  it('shows neither for a genuinely empty tab, so the empty state can render', () => {
    const state = eventSectionState([section(), section(), section()]);

    expect(state.showSkeleton).toBe(false);
    expect(state.busy).toBe(false);
  });
});
