import type { ReactNode } from 'react';
import type { EventZoneSuffix } from './calendarTiming';

/**
 * An event's time as the viewer reads it. For an event set in another zone it
 * is followed by the viewer's zone abbreviation and the event's own local
 * time: "2:00 PM PDT (Mon 10:00 AM in Auckland)". Every surface that shows an
 * event's time renders the zone through this, so they all read the same.
 */
export default function ZonedEventTime({ when, zone, inheritTone = false }: {
  when: ReactNode;
  zone: EventZoneSuffix | null;
  /** On a line that is already muted (a list row's meta), the event's own time
   *  keeps that tone instead of standing out against it. */
  inheritTone?: boolean;
}) {
  if (!zone) return <>{when}</>;
  return (
    <>
      {when} {zone.viewerZoneName}{' '}
      <span className={inheritTone ? undefined : 'text-on-surface-secondary'}>({zone.eventTime} in {zone.city})</span>
    </>
  );
}
