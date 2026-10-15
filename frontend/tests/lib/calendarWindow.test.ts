import dayjs from "dayjs";
import { getCalendarWindow, neighbourWindows } from "@/lib/utils/calendarWindow";

describe("getCalendarWindow", () => {
  test("keys the window on the anchor's month", () => {
    expect(getCalendarWindow(dayjs("2026-03-17")).key).toBe("2026-03");
  });

  test("every day of a month yields the same window", () => {
    const first = getCalendarWindow(dayjs("2026-03-01"));
    const last = getCalendarWindow(dayjs("2026-03-31"));
    expect(last).toEqual(first);
  });

  test("pads a month either side and snaps to week boundaries", () => {
    const window = getCalendarWindow(dayjs("2026-03-17"));
    // February 2026 starts on a Sunday, so the padded start snaps to Feb 1.
    expect(window.from).toBe("2026-02-01");
    // April 2026 ends on a Thursday, so the padded end snaps forward to May 2.
    expect(window.to).toBe("2026-05-02");
  });

  test("the window contains the whole anchor month", () => {
    const window = getCalendarWindow(dayjs("2026-03-17"));
    expect(window.from <= "2026-03-01").toBe(true);
    expect(window.to >= "2026-03-31").toBe(true);
  });

  test("the window contains the week around the anchor even across a month edge", () => {
    // 2026-03-01 is a Sunday; the week containing 2026-02-28 spans Feb 22 to Feb 28.
    const window = getCalendarWindow(dayjs("2026-02-28"));
    expect(window.from <= "2026-02-22").toBe(true);
    expect(window.to >= "2026-02-28").toBe(true);
  });

  test("consecutive months produce overlapping windows", () => {
    const march = getCalendarWindow(dayjs("2026-03-17"));
    const april = getCalendarWindow(dayjs("2026-04-17"));
    expect(april.from < march.to).toBe(true);
  });

  test("bounds are day-only strings", () => {
    const window = getCalendarWindow(dayjs("2026-03-17"));
    expect(window.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(window.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("neighbourWindows", () => {
  test("returns the previous and next month's windows", () => {
    const [prev, next] = neighbourWindows(dayjs("2026-03-17"));
    expect(prev.key).toBe("2026-02");
    expect(next.key).toBe("2026-04");
  });

  test("rolls across a year boundary", () => {
    const [prev, next] = neighbourWindows(dayjs("2026-12-15"));
    expect(prev.key).toBe("2026-11");
    expect(next.key).toBe("2027-01");
  });
});
