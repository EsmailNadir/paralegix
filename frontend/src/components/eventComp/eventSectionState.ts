/**
 * Which wait an events tab is in, given the state of its status sections.
 *
 * The two events tabs run one list per status (upcoming, completed, cancelled)
 * behind a single filter, so the choice between "replace everything with a
 * skeleton" and "keep the events and show the indicator" is theirs to make
 * rather than each list's. Both worked it out inline, and both had it wrong the
 * same way: any unloaded visible section blanked the whole tab, so switching to
 * All while Upcoming was on screen collapsed the list and re-expanded it.
 *
 * `ListView` states the rule for a single list: a skeleton stands in only when
 * there is nothing to stand in for. This is that rule across several lists.
 */
export interface EventSection {
  /** Whether the current status filter shows this section at all. */
  visible: boolean;
  /** First read, with nothing cached. */
  loading: boolean;
  /** Any read, including a refetch over rows already held. */
  fetching: boolean;
  /** Rows currently on screen for this section. */
  rowCount: number;
}

export interface EventSectionState {
  /** Replace the lists with a skeleton. */
  showSkeleton: boolean;
  /** Light the indicator beside the status filter. */
  busy: boolean;
}

export function eventSectionState(sections: EventSection[]): EventSectionState {
  const shown = sections.filter((section) => section.visible);

  // Nothing is on screen to keep, so the skeleton has something to do.
  const showSkeleton =
    shown.some((section) => section.loading) && shown.every((section) => section.rowCount === 0);

  return {
    showSkeleton,
    // While the skeleton is up it carries the wait itself, and two
    // acknowledgements for one action read as two separate waits.
    busy: !showSkeleton && shown.some((section) => section.fetching),
  };
}
