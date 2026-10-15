import dayjs from "dayjs";
import {
  eventMinuteOfDay,
  allDayInputFor,
  timedInputFromAllDay,
  DEFAULT_TIMED_BLOCK_MS,
  endFormValueFor,
  endsAtPayloadFor,
  endFollowingStart,
  endFitsStart,
  defaultEndFor,
  eventListWhen,
  providerEndFromForm,
  taskEndSuffix,
  endAcrossAllDayToggle,
  taskDayKeys,
  scheduleEdits,
  eventEndSuffix,
  eventTimeLabel,
} from "@/components/calendarComp/calendarTiming";
import type { Event, Task } from "@/types";

describe("eventMinuteOfDay", () => {
  test("a timed event starts at its local minute of the day", () => {
    const start = dayjs().hour(14).minute(30).second(0).millisecond(0).toISOString();
    expect(eventMinuteOfDay({ id: "e", title: "Call", start } as Event)).toBe(14 * 60 + 30);
  });

  test("an all-day or undated event has no minute", () => {
    expect(eventMinuteOfDay({ id: "e", title: "Day", start: "2026-09-28", allDay: true } as Event)).toBeNull();
    expect(eventMinuteOfDay({ id: "e", title: "No date" } as Event)).toBeNull();
  });
});

describe("all-day form values", () => {
  test('a default end across the repeated hour retains its actual instant', () => {
    const start = '2026-11-01T01:30';
    const end = defaultEndFor(start);
    expect(dayjs(end).valueOf() - dayjs(start).valueOf()).toBe(DEFAULT_TIMED_BLOCK_MS);
    expect(endFitsStart(start, end, false)).toBe(true);
  });

  test('an imported end in the second repeated hour remains after its start', () => {
    const end = endFormValueFor({ allDay: false, endsAt: '2026-11-01T09:15:00Z', endsAtLocalInput: '2026-11-01T01:15' });
    expect(endFitsStart('2026-11-01T01:30', end, false)).toBe(true);
    expect(dayjs(endsAtPayloadFor(false, end)).toISOString()).toBe('2026-11-01T09:15:00.000Z');
  });
  test("a picked day is held at local midnight, and clearing the picker clears it", () => {
    expect(allDayInputFor("2026-09-28")).toBe("2026-09-28T00:00");
    expect(allDayInputFor("")).toBe("");
  });

  test("switching back to a time turns the midnight placeholder into noon and keeps a real time", () => {
    expect(timedInputFromAllDay("2026-09-28T00:00")).toBe("2026-09-28T12:00");
    expect(timedInputFromAllDay("2026-09-28T09:15")).toBe("2026-09-28T09:15");
  });
});

// An all-day end is stored as the exclusive day after the last day, the way
// Google and Outlook take it, while a person picks the last day itself. These
// are the two conversions between them, plus the rules the form applies to an
// end. Getting either conversion wrong moves a multi-day event by a day on
// every calendar it syncs to.
describe("event end form values", () => {
  test("an all-day end prefills as the last day, one before the stored exclusive end", () => {
    expect(endFormValueFor({ allDay: true, endsAt: "2026-05-13T12:00:00.000Z" })).toBe("2026-05-12");
  });

  test("a timed end prefills from the server's local form value", () => {
    expect(endFormValueFor({ allDay: false, endsAt: "2026-05-10T19:30:00.000Z", endsAtLocalInput: "2026-05-10T15:30" }))
      .toBe("2026-05-10T15:30");
  });

  test("an event without an end prefills empty", () => {
    expect(endFormValueFor({ allDay: true, endsAt: null })).toBe("");
    expect(endFormValueFor({ allDay: false })).toBe("");
  });

  test("an all-day last day is sent as the exclusive day after it, across a month end", () => {
    expect(endsAtPayloadFor(true, "2026-05-31")).toBe("2026-06-01");
  });

  test("a timed end is sent as typed, and an empty end as null", () => {
    expect(endsAtPayloadFor(false, "2026-05-10T15:30")).toBe("2026-05-10T15:30");
    expect(endsAtPayloadFor(false, "")).toBeNull();
    expect(endsAtPayloadFor(true, "")).toBeNull();
  });

  test("moving a timed start carries the end by the same amount", () => {
    expect(endFollowingStart("2026-05-10T13:00", "2026-05-12T09:00", "2026-05-10T15:30", false))
      .toBe("2026-05-12T11:30");
  });

  test("moving an all-day first day carries the last day by the same number of days", () => {
    expect(endFollowingStart("2026-05-10T00:00", "2026-05-20T00:00", "2026-05-12", true)).toBe("2026-05-22");
  });

  test("with no end, or no start to measure from, the end is left as it is", () => {
    expect(endFollowingStart("2026-05-10T13:00", "2026-05-12T13:00", "", false)).toBe("");
    expect(endFollowingStart("", "2026-05-12T13:00", "2026-05-10T15:30", false)).toBe("2026-05-10T15:30");
  });

  test("clearing the start clears the end, which needs a start to come after", () => {
    expect(endFollowingStart("2026-05-10T13:00", "", "2026-05-10T15:30", false)).toBe("");
    expect(endFollowingStart("2026-05-10T00:00", "", "2026-05-12", true)).toBe("");
  });

  test("a timed end must come strictly after its start", () => {
    expect(endFitsStart("2026-05-10T13:00", "2026-05-10T13:30", false)).toBe(true);
    expect(endFitsStart("2026-05-10T13:00", "2026-05-10T13:00", false)).toBe(false);
    expect(endFitsStart("2026-05-10T13:00", "2026-05-10T12:00", false)).toBe(false);
  });

  test("an all-day last day may be the first day itself but not before it", () => {
    expect(endFitsStart("2026-05-10T00:00", "2026-05-10", true)).toBe(true);
    expect(endFitsStart("2026-05-10T00:00", "2026-05-09", true)).toBe(false);
  });

  test("a new timed end defaults to an hour after the start, the block sync would otherwise assume", () => {
    expect(defaultEndFor("2026-05-10T23:30")).toBe("2026-05-11T00:30");
    expect(defaultEndFor("")).toBe("");
  });

  test("an end picked for a Google or Outlook event is a calendar date when all-day and an instant when timed", () => {
    // Providers take an all-day end as the exclusive next day, the same as the API.
    expect(providerEndFromForm(true, "2026-05-12")).toBe("2026-05-13");
    expect(providerEndFromForm(false, "2026-05-10T15:30")).toBe(dayjs("2026-05-10T15:30").toISOString());
  });

  test("no end always fits", () => {
    expect(endFitsStart("2026-05-10T13:00", "", false)).toBe(true);
  });
});

describe("eventListWhen", () => {
  test("an event without an end keeps the server's start display", () => {
    expect(eventListWhen({ id: "e", title: "Call", date: "2026-05-10T17:00:00.000Z", dateLocalDisplay: "May 10, 2026, 1:00 PM" }))
      .toBe("May 10, 2026, 1:00 PM");
  });

  test("a timed event with an end shows both server displays", () => {
    expect(eventListWhen({
      id: "e", title: "Hearing", date: "2026-05-10T17:00:00.000Z", endsAt: "2026-05-10T19:30:00.000Z",
      dateLocalDisplay: "May 10, 2026, 1:00 PM", endsAtLocalDisplay: "May 10, 2026, 3:30 PM",
    })).toBe("May 10, 2026, 1:00 PM – May 10, 2026, 3:30 PM");
  });

  test("a multi-day all-day event shows its first and last day, not the exclusive end", () => {
    expect(eventListWhen({
      id: "e", title: "Trial", allDay: true, date: "2026-05-10T12:00:00.000Z", endsAt: "2026-05-13T12:00:00.000Z",
      dateLocalDisplay: "May 10, 2026", endsAtLocalDisplay: "May 13, 2026",
    })).toBe("Sun, May 10, 2026 – Tue, May 12, 2026 · All day");
  });

  test("an undated event says so", () => {
    expect(eventListWhen({ id: "e", title: "Someday", date: null })).toBe("No date");
  });
});

describe("taskEndSuffix", () => {
  // Appended to whatever start text a view already shows for a task.
  test("a task without an end adds nothing", () => {
    expect(taskEndSuffix({ dueDate: "2026-05-10T17:00:00.000Z" })).toBe("");
  });

  test("a timed task ending the same day adds only the end time", () => {
    const due = dayjs("2026-05-10T13:00").toISOString();
    const end = dayjs("2026-05-10T15:30").toISOString();
    expect(taskEndSuffix({ dueDate: due, endsAt: end })).toBe(" – 3:30 PM");
  });

  test("a timed task ending on a later day dates its end", () => {
    const due = dayjs("2026-05-10T22:00").toISOString();
    const end = dayjs("2026-05-11T01:00").toISOString();
    expect(taskEndSuffix({ dueDate: due, endsAt: end })).toBe(" – May 11, 2026, 1:00 AM");
  });

  test("reads the end in the same zone as the start: the server's wall clock, not the browser's", () => {
    // A New York task viewed from a browser elsewhere: 1:00 to 3:30 PM there.
    // Formatting the instant in the browser's zone would put the end in a
    // different zone from the server-formatted start beside it.
    expect(taskEndSuffix({
      dueDate: "2026-05-10T17:00:00.000Z", endsAt: "2026-05-10T19:30:00.000Z",
      dueDateLocalInput: "2026-05-10T13:00", endsAtLocalInput: "2026-05-10T15:30",
    })).toBe(" – 3:30 PM");
    expect(taskEndSuffix({
      dueDate: "2026-05-11T02:00:00.000Z", endsAt: "2026-05-11T05:00:00.000Z",
      dueDateLocalInput: "2026-05-10T22:00", endsAtLocalInput: "2026-05-11T01:00",
    })).toBe(" – May 11, 2026, 1:00 AM");
  });

  test("an all-day task shows its last day, one before the stored exclusive end", () => {
    expect(taskEndSuffix({ allDay: true, dueDate: "2026-05-10T12:00:00.000Z", endsAt: "2026-05-13T12:00:00.000Z" }))
      .toBe(" – May 12, 2026");
  });

  test("a one-day all-day task adds nothing", () => {
    expect(taskEndSuffix({ allDay: true, dueDate: "2026-05-10T12:00:00.000Z", endsAt: "2026-05-11T12:00:00.000Z" })).toBe("");
  });
});

describe("endAcrossAllDayToggle", () => {
  // Flipping All day keeps the day the user gave the end.
  test("a timed end turns into its own day as the last day, keeping its time for a switch back", () => {
    expect(endAcrossAllDayToggle("2026-05-12T15:30", true, "2026-05-10T00:00")).toBe("2026-05-12T15:30");
  });

  test("timed to all-day and back again keeps the end's time", () => {
    const allDay = endAcrossAllDayToggle("2026-05-10T16:00", true, "2026-05-10T14:00");
    expect(endAcrossAllDayToggle(allDay, false, "2026-05-10T14:00")).toBe("2026-05-10T16:00");
  });

  test("a kept time that would no longer come after the start falls back to the hour after it", () => {
    expect(endAcrossAllDayToggle("2026-05-10T13:00", false, "2026-05-10T14:00")).toBe("2026-05-10T15:00");
  });

  test("a last day turns into a timed end on that day, an hour past the start's time", () => {
    expect(endAcrossAllDayToggle("2026-05-12", false, "2026-05-10T12:00")).toBe("2026-05-12T13:00");
  });

  test("a single-day all-day end turns into a timed end after the start on that day", () => {
    expect(endAcrossAllDayToggle("2026-05-10", false, "2026-05-10T12:00")).toBe("2026-05-10T13:00");
  });

  test("no end stays no end", () => {
    expect(endAcrossAllDayToggle("", true, "2026-05-10T00:00")).toBe("");
    expect(endAcrossAllDayToggle("", false, "2026-05-10T12:00")).toBe("");
  });
});

// An edit sends only the schedule fields the user changed. A field left as it
// opened is left out, so the server keeps what it stores, which can be newer
// than the cached copy the form opened from.
describe("scheduleEdits", () => {
  const opened = { date: "2026-09-05T14:00", endsAt: "2026-09-05T16:00", allDay: false };

  test("nothing when the schedule is as it opened", () => {
    expect(scheduleEdits(opened, { ...opened })).toEqual({});
  });

  test("only the fields that changed", () => {
    expect(scheduleEdits(opened, { ...opened, endsAt: "" })).toEqual({ endsAt: "" });
    expect(scheduleEdits(opened, { ...opened, date: "2026-09-06T14:00", endsAt: "2026-09-06T17:00" }))
      .toEqual({ date: "2026-09-06T14:00", endsAt: "2026-09-06T17:00" });
    expect(scheduleEdits(opened, { date: "2026-09-05T14:00", endsAt: "2026-09-05T16:00", allDay: true })).toEqual({ allDay: true });
  });

  // Every update route carries its stored end along with a moved start, so an
  // end that only followed the start is left for the server to move. The
  // stored one keeps a length the form's cached copy may not know about.
  test("leaves out an end that only followed the start", () => {
    expect(scheduleEdits(opened, { ...opened, date: "2026-09-06T09:00", endsAt: "2026-09-06T11:00" }))
      .toEqual({ date: "2026-09-06T09:00" });
    const span = { date: "2026-09-05T00:00", endsAt: "2026-09-07", allDay: true };
    expect(scheduleEdits(span, { ...span, date: "2026-09-10T00:00", endsAt: "2026-09-12" })).toEqual({ date: "2026-09-10T00:00" });
  });

  test("still sends a followed end when the all-day flag changed too", () => {
    expect(scheduleEdits(opened, { date: "2026-09-06T14:00", endsAt: "2026-09-06T16:00", allDay: true }))
      .toEqual({ date: "2026-09-06T14:00", endsAt: "2026-09-06T16:00", allDay: true });
  });
});

// The text after an event's start on the day agenda, in the format a task's
// end uses there.
describe("eventEndSuffix", () => {
  test("a timed end on the same day is its time", () => {
    expect(eventEndSuffix({ id: "e", title: "Call", start: dayjs("2026-09-05T14:00").toISOString(), end: dayjs("2026-09-05T15:30").toISOString() } as Event))
      .toBe(" – 3:30 PM");
  });

  test("a multi-day all-day end is its last day, and a single day adds nothing", () => {
    expect(eventEndSuffix({ id: "e", title: "Trial", allDay: true, start: "2026-09-05", end: "2026-09-08" } as Event)).toBe(" – Sep 7, 2026");
    expect(eventEndSuffix({ id: "e", title: "Filing", allDay: true, start: "2026-09-05", end: "2026-09-06" } as Event)).toBe("");
  });

  test("nothing for an event with no end", () => {
    expect(eventEndSuffix({ id: "e", title: "Call", start: dayjs("2026-09-05T14:00").toISOString() } as Event)).toBe("");
  });
});

describe("eventTimeLabel", () => {
  const overnight = { id: "e", title: "Late call", start: dayjs("2026-09-05T23:30").toISOString(), end: dayjs("2026-09-06T01:00").toISOString() } as Event;

  test("the start day shows the start, and the end too when asked", () => {
    expect(eventTimeLabel(overnight, "2026-09-05")).toBe("11:30 PM");
    expect(eventTimeLabel(overnight, "2026-09-05", true)).toBe("11:30 PM – Sep 6, 2026, 1:00 AM");
  });

  test("a day the event runs into shows when it ends, not when it started", () => {
    expect(eventTimeLabel(overnight, "2026-09-06")).toBe("until 1:00 AM");
    expect(eventTimeLabel(overnight, "2026-09-06", true)).toBe("until 1:00 AM");
  });

  test("a day the event runs through dates its end", () => {
    const long = { ...overnight, end: dayjs("2026-09-07T09:00").toISOString() };
    expect(eventTimeLabel(long, "2026-09-06")).toBe("until Sep 7, 2026, 9:00 AM");
  });

  test("an all-day event is All day, with its last day when asked", () => {
    const trial = { id: "e", title: "Trial", allDay: true, start: "2026-09-05", end: "2026-09-08" } as Event;
    expect(eventTimeLabel(trial, "2026-09-06")).toBe("All day");
    expect(eventTimeLabel(trial, "2026-09-06", true)).toBe("All day – Sep 7, 2026");
  });
});

describe("taskDayKeys", () => {
  const bounds = { from: "2026-05-01", to: "2026-05-31" };

  test("a multi-day all-day task is on every day it covers, not past its last day", () => {
    expect(taskDayKeys({ allDay: true, dueDate: "2026-05-10T12:00:00.000Z", dueDateLocalInput: "2026-05-10", endsAt: "2026-05-13T12:00:00.000Z" } as Task, bounds))
      .toEqual(["2026-05-10", "2026-05-11", "2026-05-12"]);
  });

  test("a task without an end, or a timed one, stays on its due day", () => {
    expect(taskDayKeys({ allDay: true, dueDate: "2026-05-10T12:00:00.000Z", dueDateLocalInput: "2026-05-10" } as Task, bounds)).toEqual(["2026-05-10"]);
    expect(taskDayKeys({
      allDay: false, dueDate: "2026-05-11T02:00:00.000Z", dueDateLocalInput: "2026-05-10T22:00", endsAt: "2026-05-11T05:00:00.000Z",
    } as Task, bounds)).toEqual(["2026-05-10"]);
  });

  test("a task with no due date is on no day", () => {
    expect(taskDayKeys({} as Task, bounds)).toEqual([]);
  });
});

test("the default block matches the backend's one hour", () => {
  expect(DEFAULT_TIMED_BLOCK_MS).toBe(60 * 60 * 1000);
});

describe('spanning event days', () => {
  test('includes timed continuation days and excludes an exclusive midnight end', () => {
    const { eventDayKeys } = jest.requireActual('@/components/calendarComp/calendarTiming');
    const event = { id: 'span', title: 'Trial', start: '2026-10-05T22:00:00', end: '2026-10-08T00:00:00' };
    expect(eventDayKeys(event, { from: '2026-10-06', to: '2026-10-10' })).toEqual(['2026-10-06', '2026-10-07']);
    expect(eventMinuteOfDay(event, '2026-10-06')).toBe(0);
    expect(eventMinuteOfDay(event, '2026-10-05')).toBe(22 * 60);
  });
  test('keeps New Zealand all-day labels without shifting the day', () => {
    const { eventDayKeys } = jest.requireActual('@/components/calendarComp/calendarTiming');
    expect(eventDayKeys({ id: 'nz', title: 'All day', allDay: true, start: '2026-10-05T12:00:00Z', end: '2026-10-07T12:00:00Z' }, { from: '2026-10-01', to: '2026-10-31' })).toEqual(['2026-10-05', '2026-10-06']);
  });
});

// An event set in another zone keeps its time in the viewer's zone, marked with
// the viewer's zone abbreviation, and adds the time it is where it was set.
describe('eventZoneSuffix', () => {
  const { eventZoneSuffix } = jest.requireActual('@/components/calendarComp/calendarTiming');
  const LA = 'America/Los_Angeles';

  test('gives the event zone time and city, and the viewer zone abbreviation', () => {
    expect(eventZoneSuffix({ start: '2026-03-15T15:00:00.000Z', timeZone: 'America/New_York' }, LA))
      .toEqual({ viewerZoneName: 'PDT', eventTime: '11:00 AM', city: 'New York' });
  });

  test('names the weekday when the event zone is already on another day', () => {
    expect(eventZoneSuffix({ start: '2026-03-15T21:00:00.000Z', timeZone: 'Pacific/Auckland' }, LA))
      .toEqual({ viewerZoneName: 'PDT', eventTime: 'Mon 10:00 AM', city: 'Auckland' });
  });

  test('gives a range with the app range separator, and the abbreviation in force on the day', () => {
    expect(eventZoneSuffix({ start: '2026-11-10T18:00:00.000Z', end: '2026-11-10T19:30:00.000Z', timeZone: 'Pacific/Auckland' }, LA))
      .toEqual({ viewerZoneName: 'PST', eventTime: 'Wed 7:00 AM – 8:30 AM', city: 'Auckland' });
  });

  test('names the end weekday when the range crosses midnight in the event zone', () => {
    expect(eventZoneSuffix({ start: '2026-09-05T10:30:00.000Z', end: '2026-09-05T12:30:00.000Z', timeZone: 'Pacific/Auckland' }, LA))
      .toEqual({ viewerZoneName: 'PDT', eventTime: '10:30 PM – Sun 12:30 AM', city: 'Auckland' });
  });

  test('ignores an end that does not come after the start', () => {
    expect(eventZoneSuffix({ start: '2026-03-15T15:00:00.000Z', end: '2026-03-15T15:00:00.000Z', timeZone: 'America/New_York' }, LA))
      .toEqual({ viewerZoneName: 'PDT', eventTime: '11:00 AM', city: 'New York' });
  });

  test('says nothing when the event is in the viewer zone, under either of its names', () => {
    expect(eventZoneSuffix({ start: '2026-03-15T15:00:00.000Z', timeZone: LA }, LA)).toBeNull();
    expect(eventZoneSuffix({ start: '2026-03-15T15:00:00.000Z', timeZone: 'US/Pacific' }, LA)).toBeNull();
  });

  test('says nothing for an all-day event, one with no zone, or one with no start', () => {
    expect(eventZoneSuffix({ start: '2026-03-15T12:00:00.000Z', timeZone: 'Pacific/Auckland', allDay: true }, LA)).toBeNull();
    expect(eventZoneSuffix({ start: '2026-03-15T15:00:00.000Z', timeZone: null }, LA)).toBeNull();
    expect(eventZoneSuffix({ start: '2026-03-15T15:00:00.000Z' }, LA)).toBeNull();
    expect(eventZoneSuffix({ start: null, timeZone: 'Pacific/Auckland' }, LA)).toBeNull();
    expect(eventZoneSuffix({ start: 'not a date', timeZone: 'Pacific/Auckland' }, LA)).toBeNull();
  });

  test('says nothing, rather than throwing, for a zone name the browser does not know', () => {
    expect(eventZoneSuffix({ start: '2026-03-15T15:00:00.000Z', timeZone: 'Mars/Olympus_Mons' }, LA)).toBeNull();
  });

  test('compares against the browser zone by default', () => {
    // jest.config.js pins every worker to Los Angeles before it starts.
    expect(eventZoneSuffix({ start: '2026-03-15T15:00:00.000Z', timeZone: LA })).toBeNull();
    expect(eventZoneSuffix({ start: '2026-03-15T15:00:00.000Z', timeZone: 'America/New_York' }))
      .toEqual({ viewerZoneName: 'PDT', eventTime: '11:00 AM', city: 'New York' });
  });
});
