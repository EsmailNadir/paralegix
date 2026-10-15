import dayjs from "dayjs";
import { formatRelativeDay } from "@/lib/utils/dateUtils";

describe("formatRelativeDay", () => {
  afterEach(() => jest.useRealTimers());

  /**
   * Counts calendar days, not 24-hour blocks. Goes red on the elapsed-hours
   * reading: 11pm yesterday is 11 hours before 10am today, which read "Today".
   */
  test("calls 11pm yesterday Yesterday at 10am today", () => {
    jest.useFakeTimers({ now: dayjs().hour(10).minute(0).second(0).toDate() });
    const lateYesterday = dayjs().subtract(1, "day").hour(23).minute(0).toISOString();
    expect(formatRelativeDay(lateYesterday)).toBe("Yesterday");
  });

  test("today, a few days ago, and older", () => {
    expect(formatRelativeDay(dayjs().toISOString())).toBe("Today");
    expect(formatRelativeDay(dayjs().subtract(3, "day").toISOString())).toBe("3d ago");
    const old = dayjs().subtract(20, "day");
    expect(formatRelativeDay(old.toISOString())).toBe(old.toDate().toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    expect(formatRelativeDay(null)).toBe("");
  });
});
