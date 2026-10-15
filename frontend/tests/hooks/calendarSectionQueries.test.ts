import {
  clientEventsWindowKey,
  matterEventsWindowKey,
} from "@/hooks/calendarHooks/calendarSectionQueries";

const window = { from: "2026-08-30", to: "2026-10-03" };

describe("calendar section cache keys", () => {
  /**
   * The backend reads a window's days in the caller's zone, so a window read
   * in one zone is not the window in another. Goes red if the client events
   * key drops the zone again: after a zone change the calendar would keep
   * drawing client events read for the old one.
   */
  test("client events are cached per zone, like matter events", () => {
    expect(clientEventsWindowKey("firm-1", window, "America/Los_Angeles"))
      .not.toEqual(clientEventsWindowKey("firm-1", window, "Europe/London"));
    expect(clientEventsWindowKey("firm-1", window, "UTC")).toEqual(
      ["clientEvents", "firm-1", "window", "2026-08-30", "2026-10-03", "UTC"],
    );
    expect(matterEventsWindowKey("firm-1", window, "UTC")[0]).toBe("matterEvents");
  });
});
