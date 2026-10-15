import {
  balanceRoundedShares,
  buildBalancedHoursFromAmounts,
  buildBalancedPercentagesFromAmounts,
  roundSplitValue,
} from "@/components/billingComp/splitAllocation";

describe("splitAllocation helpers", () => {
  it("balances a three-way split percentage to exactly 100", () => {
    const percentages = buildBalancedPercentagesFromAmounts(291.5, [97.17, 97.17, 97.16]);

    expect(percentages).toEqual([33.33, 33.33, 33.34]);
    expect(percentages.reduce((sum, value) => sum + value, 0)).toBe(100);
  });

  it("keeps awkward percentage distributions balanced across several cases", () => {
    const cases = [
      { total: 0.11, amounts: Array(11).fill(0.01) },
      { total: 0.03, amounts: [0.01, 0.01, 0.01] },
      { total: 159.5, amounts: [12.34, 56.78, 90.12, 0.26] },
      { total: 250, amounts: [0, 62.5, 0, 187.5] },
      { total: 1000, amounts: [333.33, 333.33, 333.34] },
    ];

    for (const { total, amounts } of cases) {
      const percentages = buildBalancedPercentagesFromAmounts(total, amounts);
      const sum = roundSplitValue(
        percentages.reduce((runningTotal, value) => runningTotal + value, 0),
      );

      expect(sum).toBe(100);
      expect(percentages.every((value) => Number.isFinite(value))).toBe(true);
    }
  });

  it("balances split hours to the original source total", () => {
    const hours = buildBalancedHoursFromAmounts(291.5, 1, [97.17, 97.17, 97.16]);

    expect(hours).toEqual([0.33, 0.33, 0.34]);
    expect(hours.reduce((sum, value) => sum + value, 0)).toBe(1);
  });

  it("keeps zero-amount clients at zero percent while balancing the remainder", () => {
    const percentages = buildBalancedPercentagesFromAmounts(250, [0, 62.5, 0, 187.5]);

    expect(percentages).toEqual([0, 25, 0, 75]);
  });

  it("keeps zero totals at zero", () => {
    expect(balanceRoundedShares(0, [0, 0, 0])).toEqual([0, 0, 0]);
  });
});
