export function roundSplitValue(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export function balanceRoundedShares(total: number, rawShares: number[]) {
  if (rawShares.length === 0) return [];

  const roundedTotal = roundSplitValue(total);
  if (roundedTotal === 0) {
    return rawShares.map(() => 0);
  }

  const balanced = rawShares.map((share) => roundSplitValue(share));
  let anchorIndex = -1;
  for (let index = rawShares.length - 1; index >= 0; index -= 1) {
    if (Math.abs(rawShares[index]) > 0) {
      anchorIndex = index;
      break;
    }
  }
  const targetIndex = anchorIndex >= 0 ? anchorIndex : balanced.length - 1;
  const otherTotal = balanced.reduce((sum, share, index) => (
    index === targetIndex ? sum : sum + share
  ), 0);

  balanced[targetIndex] = roundSplitValue(roundedTotal - otherTotal);
  return balanced.map((share) => (Object.is(share, -0) ? 0 : share));
}

export function buildBalancedPercentagesFromAmounts(totalAmount: number, amounts: number[]) {
  if (totalAmount <= 0) return amounts.map(() => 0);

  return balanceRoundedShares(
    100,
    amounts.map((amount) => (roundSplitValue(Number(amount) || 0) / totalAmount) * 100),
  );
}

export function buildBalancedHoursFromAmounts(totalAmount: number, totalHours: number, amounts: number[]) {
  if (totalAmount <= 0 || totalHours <= 0) return amounts.map(() => 0);

  return balanceRoundedShares(
    totalHours,
    amounts.map((amount) => ((Number(amount) || 0) * totalHours) / totalAmount),
  );
}
