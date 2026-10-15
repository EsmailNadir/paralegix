import dayjs from "dayjs";
import { formatAgendaWhen } from "@/lib/utils/dateUtils";

describe("formatAgendaWhen", () => {
  /**
   * An all-day item is stored at its day's noon-UTC anchor. Goes red if that
   * anchor is shown as a time ("Today · 5:00 AM" in Pacific) or its day is read
   * in the viewer's zone rather than off the date itself.
   */
  test("shows an all-day item as its day alone", () => {
    const today = dayjs().format("YYYY-MM-DD");
    expect(formatAgendaWhen(`${today}T12:00:00.000Z`, true)).toBe("Today");
    const tomorrow = dayjs().add(1, "day").format("YYYY-MM-DD");
    expect(formatAgendaWhen(`${tomorrow}T12:00:00.000Z`, true)).toBe("Tomorrow");
    expect(formatAgendaWhen("2031-03-14T12:00:00.000Z", true)).toBe("Fri, Mar 14");
  });

  test("shows a timed item with its local time", () => {
    const start = dayjs().hour(15).minute(0).second(0).millisecond(0);
    expect(formatAgendaWhen(start.toISOString())).toBe("Today · 3:00 PM");
  });

  test("is empty for no date", () => {
    expect(formatAgendaWhen(null)).toBe("");
  });
});
