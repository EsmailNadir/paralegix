import dayjs from "dayjs";
import { isPastDueBeyond } from "@/lib/utils/dateUtils";

const dayOffset = (n: number) => dayjs().add(n, "day").format("YYYY-MM-DD");

describe("isPastDueBeyond", () => {
  /**
   * The late-fee rule the backend applies: eligible once today is strictly
   * past the due day plus the grace days. Goes red if grace is ignored (the
   * button showed during the grace period and the backend then refused it).
   */
  test("is false within the grace period and true the day after it", () => {
    expect(isPastDueBeyond(dayOffset(-3), 5)).toBe(false);
    expect(isPastDueBeyond(dayOffset(-5), 5)).toBe(false);
    expect(isPastDueBeyond(dayOffset(-6), 5)).toBe(true);
  });

  test("with no grace, is plain past due", () => {
    expect(isPastDueBeyond(dayOffset(0), 0)).toBe(false);
    expect(isPastDueBeyond(dayOffset(-1), 0)).toBe(true);
  });

  test("reads an anchored instant by its day", () => {
    expect(isPastDueBeyond(`${dayOffset(-1)}T12:00:00.000Z`, 0)).toBe(true);
    expect(isPastDueBeyond(null, 0)).toBe(false);
  });
});
