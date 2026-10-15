/**
 * Calendar temporal fixtures and date boundary verification.
 *
 * B07.3 requirement:
 * "Use fixed named instants and timezone-aware expectations: UTC; America/Los_Angeles
 *  at spring-forward and fall-back; a positive half-hour/quarter-hour-offset zone;
 *  leap day; month/year boundary; all-day date-only event; event crossing midnight;
 *  missing end; invalid timezone; canceled event; due date absent.
 *  Test conversion helpers thoroughly and add a small number of full-route/provider controls.
 *  Assert that day-only dates stay the same calendar date and instant timestamps preserve the instant."
 */

import '../support/setupInProcess';

import {
  _buildAllDayEventRange as buildGoogleAllDay,
  _buildTimedEventRange as buildGoogleTimed,
  _formatDateForTz as formatGoogleTz,
} from '../../src/modules/calendar/google/google.service';

import {
  _buildOutlookAllDayRange as buildOutlookAllDay,
  _buildOutlookTimedRange as buildOutlookTimed,
} from '../../src/modules/calendar/outlook/outlook.service';

// Outlook's own zone-offset copy was replaced by the shared one.
import { getTimeZoneOffsetMs as getOutlookZoneOffset } from '../../src/shared/utils/time';
// Both services export the same `zonedWallClock` as `_formatDateForTz`, so the
// wall-clock cases below read it through the Google export only.

describe('B07.3: calendar temporal fixtures and timezone-aware date formatting', () => {
  describe('fixed named instants across timezone offsets', () => {
    const FIXED_INSTANT = new Date('2026-06-15T14:30:45.000Z');

    it('formats exact UTC instant in UTC without drift', () => {
      expect(formatGoogleTz(FIXED_INSTANT, 'UTC')).toBe('2026-06-15T14:30:45');
    });

    it('formats in America/Los_Angeles (daylight time, UTC-7)', () => {
      expect(formatGoogleTz(FIXED_INSTANT, 'America/Los_Angeles')).toBe('2026-06-15T07:30:45');
    });

    it('formats in positive half-hour offset zone (Asia/Kolkata, UTC+5:30)', () => {
      // 14:30 UTC + 5:30 = 20:00
      expect(formatGoogleTz(FIXED_INSTANT, 'Asia/Kolkata')).toBe('2026-06-15T20:00:45');
    });

    it('formats in positive quarter-hour offset zone (Asia/Kathmandu, UTC+5:45)', () => {
      // 14:30 UTC + 5:45 = 20:15
      expect(formatGoogleTz(FIXED_INSTANT, 'Asia/Kathmandu')).toBe('2026-06-15T20:15:45');
    });

    it('formats in positive quarter-hour offset crossing date boundary (Pacific/Chatham, UTC+12:45 in June)', () => {
      // 14:30 UTC on June 15 + 12:45 = 03:15 on June 16
      expect(formatGoogleTz(FIXED_INSTANT, 'Pacific/Chatham')).toBe('2026-06-16T03:15:45');
    });
  });

  describe('DST transitions: spring-forward gap and fall-back fold in America/Los_Angeles', () => {
    it('spring-forward (2026-03-08): clocks skip from 01:59:59 PST to 03:00:00 PDT', () => {
      // 09:59:00 UTC = 01:59:00 PST (UTC-8)
      const beforeGap = new Date('2026-03-08T09:59:00.000Z');
      expect(formatGoogleTz(beforeGap, 'America/Los_Angeles')).toBe('2026-03-08T01:59:00');

      // 10:01:00 UTC = 03:01:00 PDT (UTC-7) - 2:00am hour is skipped
      const afterGap = new Date('2026-03-08T10:01:00.000Z');
      expect(formatGoogleTz(afterGap, 'America/Los_Angeles')).toBe('2026-03-08T03:01:00');
    });

    it('fall-back fold (2026-11-01): 01:00-02:00 repeats, transitioning from PDT (UTC-7) to PST (UTC-8)', () => {
      // 08:30:00 UTC = 01:30:00 PDT (UTC-7)
      const firstPass = new Date('2026-11-01T08:30:00.000Z');
      expect(formatGoogleTz(firstPass, 'America/Los_Angeles')).toBe('2026-11-01T01:30:00');

      // 09:30:00 UTC = 01:30:00 PST (UTC-8)
      const secondPass = new Date('2026-11-01T09:30:00.000Z');
      expect(formatGoogleTz(secondPass, 'America/Los_Angeles')).toBe('2026-11-01T01:30:00');
    });

    // The bare wall clock above is the same for both passes, which is why the
    // Google body carries the offset. Goes red if the builder drops it.
    it('fall-back fold: the Google body tells the two 01:30s apart by offset', () => {
      const first = buildGoogleTimed(new Date('2026-11-01T08:30:00.000Z'), 'America/Los_Angeles');
      const second = buildGoogleTimed(new Date('2026-11-01T09:30:00.000Z'), 'America/Los_Angeles');
      expect(first.start).toEqual({ dateTime: '2026-11-01T01:30:00-07:00', timeZone: 'America/Los_Angeles' });
      expect(second.start).toEqual({ dateTime: '2026-11-01T01:30:00-08:00', timeZone: 'America/Los_Angeles' });
      // The hour-long block from the first 01:30 ends at the second 01:30.
      expect(first.end.dateTime).toBe('2026-11-01T01:30:00-08:00');
      expect(new Date(second.start.dateTime).toISOString()).toBe('2026-11-01T09:30:00.000Z');
    });

    it('carries half-hour and quarter-hour offsets, and a millisecond part does not skew them', () => {
      const instant = new Date('2026-06-15T14:30:45.678Z');
      expect(buildGoogleTimed(instant, 'Asia/Kolkata').start.dateTime).toBe('2026-06-15T20:00:45+05:30');
      expect(buildGoogleTimed(instant, 'Pacific/Chatham').start.dateTime).toBe('2026-06-16T03:15:45+12:45');
      expect(buildGoogleTimed(instant, 'America/St_Johns').start.dateTime).toBe('2026-06-15T12:00:45-02:30');
    });
  });

  describe('leap day and month/year calendar boundaries', () => {
    it('leap day (2028-02-29): preserves February 29 without slipping into March 1', () => {
      const leapDay = new Date('2028-02-29T12:00:00.000Z');
      expect(formatGoogleTz(leapDay, 'UTC')).toBe('2028-02-29T12:00:00');

      const allDayGoogle = buildGoogleAllDay(leapDay, null);
      expect(allDayGoogle).toEqual({
        start: { date: '2028-02-29' },
        end: { date: '2028-03-01' },
      });

      const allDayOutlook = buildOutlookAllDay(leapDay, null, 'UTC');
      expect(allDayOutlook).toEqual({
        start: { dateTime: '2028-02-29T00:00:00', timeZone: 'UTC' },
        end: { dateTime: '2028-03-01T00:00:00', timeZone: 'UTC' },
        isAllDay: true,
      });
    });

    it('year boundary rollover: 2026-12-31 to 2027-01-01', () => {
      const nyeUtc = new Date('2026-12-31T23:30:00.000Z');

      // In Europe/Paris (UTC+1), it is already New Year's Day 2027
      expect(formatGoogleTz(nyeUtc, 'Europe/Paris')).toBe('2027-01-01T00:30:00');

      // In America/New_York (UTC-5), it is still afternoon of Dec 31
      expect(formatGoogleTz(nyeUtc, 'America/New_York')).toBe('2026-12-31T18:30:00');

      // Year-end all-day event
      const allDayGoogle = buildGoogleAllDay(new Date('2026-12-31T00:00:00.000Z'), null);
      expect(allDayGoogle).toEqual({
        start: { date: '2026-12-31' },
        end: { date: '2027-01-01' },
      });
    });
  });

  describe('all-day date-only event boundary contracts', () => {
    it('single-day all-day event produces start date and exclusive start + 1 day end', () => {
      const start = new Date('2026-07-20T00:00:00.000Z');
      const googleRange = buildGoogleAllDay(start, null);
      expect(googleRange).toEqual({
        start: { date: '2026-07-20' },
        end: { date: '2026-07-21' },
      });

      const outlookRange = buildOutlookAllDay(start, null, 'America/Chicago');
      expect(outlookRange).toEqual({
        start: { dateTime: '2026-07-20T00:00:00', timeZone: 'America/Chicago' },
        end: { dateTime: '2026-07-21T00:00:00', timeZone: 'America/Chicago' },
        isAllDay: true,
      });
    });

    it('multi-day all-day event honors explicit future end date', () => {
      const start = new Date('2026-07-20T00:00:00.000Z');
      const end = new Date('2026-07-25T00:00:00.000Z');

      const googleRange = buildGoogleAllDay(start, end);
      expect(googleRange).toEqual({
        start: { date: '2026-07-20' },
        end: { date: '2026-07-25' },
      });

      const outlookRange = buildOutlookAllDay(start, end, 'UTC');
      expect(outlookRange).toEqual({
        start: { dateTime: '2026-07-20T00:00:00', timeZone: 'UTC' },
        end: { dateTime: '2026-07-25T00:00:00', timeZone: 'UTC' },
        isAllDay: true,
      });
    });

    it('falls back safely to start + 1 day when stored end is earlier than or equal to start', () => {
      const start = new Date('2026-07-20T00:00:00.000Z');
      const invalidEnd = new Date('2026-07-19T00:00:00.000Z');

      const googleRange = buildGoogleAllDay(start, invalidEnd);
      expect(googleRange.end.date).toBe('2026-07-21');

      const outlookRange = buildOutlookAllDay(start, invalidEnd, 'UTC');
      expect(outlookRange.end.dateTime).toBe('2026-07-21T00:00:00');
    });
  });

  describe('timed events: explicit end, missing end, and crossing midnight', () => {
    it('event crossing midnight preserves duration and updates date on end', () => {
      const start = new Date('2026-08-10T23:30:00.000Z');
      const end = new Date('2026-08-11T02:00:00.000Z');

      const googleTimed = buildGoogleTimed(start, 'UTC', end);
      expect(googleTimed).toEqual({
        start: { dateTime: '2026-08-10T23:30:00+00:00', timeZone: 'UTC' },
        end: { dateTime: '2026-08-11T02:00:00+00:00', timeZone: 'UTC' },
      });

      const outlookTimed = buildOutlookTimed(start, end, 'UTC', 'UTC');
      expect(outlookTimed).toEqual({
        start: { dateTime: '2026-08-10T23:30:00', timeZone: 'UTC' },
        end: { dateTime: '2026-08-11T02:00:00', timeZone: 'UTC' },
        isAllDay: false,
      });
    });

    it('missing end falls back strictly to a 1-hour block', () => {
      const start = new Date('2026-08-10T14:00:00.000Z');

      const googleTimed = buildGoogleTimed(start, 'America/New_York');
      expect(googleTimed).toEqual({
        start: { dateTime: '2026-08-10T10:00:00-04:00', timeZone: 'America/New_York' },
        end: { dateTime: '2026-08-10T11:00:00-04:00', timeZone: 'America/New_York' },
      });

      const outlookTimed = buildOutlookTimed(start, undefined, 'America/New_York', 'Eastern Standard Time');
      expect(outlookTimed).toEqual({
        start: { dateTime: '2026-08-10T10:00:00', timeZone: 'Eastern Standard Time' },
        end: { dateTime: '2026-08-10T11:00:00', timeZone: 'Eastern Standard Time' },
        isAllDay: false,
      });
    });

    it('invalid end (end <= start) falls back to a 1-hour block', () => {
      const start = new Date('2026-08-10T14:00:00.000Z');
      const invalidEnd = new Date('2026-08-10T13:00:00.000Z'); // 1 hour earlier

      const googleTimed = buildGoogleTimed(start, 'UTC', invalidEnd);
      expect(googleTimed.end.dateTime).toBe('2026-08-10T15:00:00+00:00');

      const outlookTimed = buildOutlookTimed(start, invalidEnd, 'UTC', 'UTC');
      expect(outlookTimed.end.dateTime).toBe('2026-08-10T15:00:00');

      // An unparseable end is no end at all, not an instant to compare against.
      expect(buildGoogleTimed(start, 'UTC', new Date('invalid')).end.dateTime).toBe('2026-08-10T15:00:00+00:00');
    });
  });

  describe('zone offset helper verification', () => {
    it('returns exact millisecond offsets for half-hour and standard zones', () => {
      const instant = new Date('2026-06-15T12:00:00.000Z').getTime();

      // UTC has 0 offset
      expect(getOutlookZoneOffset(instant, 'UTC')).toBe(0);

      // Asia/Kolkata is +05:30 = 5.5 * 3600 * 1000 = 19,800,000 ms
      expect(getOutlookZoneOffset(instant, 'Asia/Kolkata')).toBe(19800000);

      // Asia/Kathmandu is +05:45 = 5.75 * 3600 * 1000 = 20,700,000 ms
      expect(getOutlookZoneOffset(instant, 'Asia/Kathmandu')).toBe(20700000);

      // America/New_York in June (EDT, UTC-4) = -4 * 3600 * 1000 = -14,400,000 ms
      expect(getOutlookZoneOffset(instant, 'America/New_York')).toBe(-14400000);
    });
  });

  describe('adapter-level date and absent-due-date controls', () => {
    const { getAdapter } = require('../../src/modules/calendar/shared/calendarAdapters');

    it('task adapter: returns empty items when dueDate is absent and preserves timezone when present', async () => {
      const taskAdapter = getAdapter('task');

      // Due date absent -> empty array
      const absentItems = await taskAdapter.toCalendarItems({ title: 'No due date task' });
      expect(absentItems).toEqual([]);

      // Due date present with explicit timezone
      const presentItems = await taskAdapter.toCalendarItems({
        title: 'Task with due date',
        dueDate: '2026-09-15T15:00:00.000Z',
        dueDateTimeZone: 'America/Chicago',
        allDay: false,
      });
      expect(presentItems).toHaveLength(1);
      expect(presentItems[0].key).toBe('dueDate');
      expect(presentItems[0].dateTime).toEqual(new Date('2026-09-15T15:00:00.000Z'));
      expect(presentItems[0].timeZone).toBe('America/Chicago');
      expect(presentItems[0].allDay).toBe(false);
    });

    it('task adapter: passes the task end so the provider shows its real length', async () => {
      // Without it the engine falls back to a one-hour block for every task.
      const [item] = await getAdapter('task').toCalendarItems({
        title: 'Prep session',
        dueDate: '2026-09-15T15:00:00.000Z',
        endsAt: '2026-09-15T17:30:00.000Z',
        allDay: false,
      });
      expect(item.end).toBe('2026-09-15T17:30:00.000Z');
    });

    it('matterEvent adapter: returns empty items when date is absent and preserves allDay flag', async () => {
      const matterEventAdapter = getAdapter('matterEvent');

      // Date absent -> empty array
      const absentItems = await matterEventAdapter.toCalendarItems({ title: 'Dateless event' });
      expect(absentItems).toEqual([]);

      // All-day matter event
      const allDayItems = await matterEventAdapter.toCalendarItems({
        title: 'Court Holiday',
        date: '2026-11-26',
        allDay: true,
      });
      expect(allDayItems).toHaveLength(1);
      expect(allDayItems[0].dateTime).toBe('2026-11-26');
      expect(allDayItems[0].allDay).toBe(true);
    });

    it('externalEvent adapter: preserves start, end, and startTimeZone', async () => {
      const externalAdapter = getAdapter('externalEvent');

      // Start absent -> empty array
      const absentItems = await externalAdapter.toCalendarItems({ title: 'No start' });
      expect(absentItems).toEqual([]);

      const items = await externalAdapter.toCalendarItems({
        title: 'Deposition with opposing counsel',
        start: '2026-10-05T13:00:00.000Z',
        end: '2026-10-05T16:00:00.000Z',
        startTimeZone: 'America/Denver',
        allDay: false,
      });
      expect(items).toHaveLength(1);
      expect(items[0].dateTime).toBe('2026-10-05T13:00:00.000Z');
      expect(items[0].end).toBe('2026-10-05T16:00:00.000Z');
      expect(items[0].timeZone).toBe('America/Denver');
      expect(items[0].allDay).toBe(false);
    });
  });
});

