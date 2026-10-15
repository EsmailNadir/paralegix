/**
 * Dividing billable work between the payers on a split-billed matter.
 *
 * The hard part is not the arithmetic, it is the remainder. A $100 line split
 * three ways is $33.33 three times, which is $99.99: a cent has to land
 * somewhere, and it has to land somewhere *deterministically*, or the invoice
 * totals will not reconcile against the line items the create path re-sums and
 * asserts.
 *
 * `allocateWorkToPayers` keeps every line summing exactly and assigns each
 * line's odd cents by error diffusion: a running exact share is tracked per
 * payer and the next odd cent goes to the payer furthest behind it, so over a
 * whole bill each payer lands within a cent of their exact portion no matter how
 * many lines carry a remainder. Ties go to the later payer in the list, which
 * is what `balanceRoundedShares` does for a single line.
 */

/** Currency and percentage values are carried to two decimal places. */
export function roundSplitValue(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/**
 * Round each share to two decimals and make them add up to `total` exactly.
 *
 * The correction goes to the last share that is not zero, so a payer with no
 * allocation never picks up a stray cent.
 */
export function balanceRoundedShares(total: number, rawShares: number[]): number[] {
  if (rawShares.length === 0) return [];

  const roundedTotal = roundSplitValue(total);
  if (roundedTotal === 0) return rawShares.map(() => 0);

  const balanced = rawShares.map((share) => roundSplitValue(share));

  let anchorIndex = -1;
  for (let index = rawShares.length - 1; index >= 0; index -= 1) {
    if (Math.abs(rawShares[index]) > 0) {
      anchorIndex = index;
      break;
    }
  }
  const targetIndex = anchorIndex >= 0 ? anchorIndex : balanced.length - 1;
  const otherTotal = balanced.reduce(
    (sum, share, index) => (index === targetIndex ? sum : sum + share),
    0,
  );

  balanced[targetIndex] = roundSplitValue(roundedTotal - otherTotal);
  // -0 is a valid double but reads as "-0.00" once formatted onto an invoice.
  return balanced.map((share) => (Object.is(share, -0) ? 0 : share));
}

/**
 * Splits whole units (cents, or hundredths of an hour) across payers line after
 * line. `deficit[i]` is payer i's exact cumulative share minus what they have
 * been given, in 1/10000 of a unit, carried from one `split` call to the next.
 */
function createDiffusingSplitter(portionsBp: number[]) {
  const deficit = portionsBp.map(() => 0);
  const eligible = portionsBp.map((bp) => bp > 0);
  const anyEligible = eligible.some(Boolean);

  return function split(units: number): number[] {
    if (portionsBp.length === 0) return [];
    if (units === 0) return portionsBp.map(() => 0);

    const given = portionsBp.map((bp) => Math.floor((units * bp) / FULL_PORTION_BP));
    // Per payer: what they are owed so far, counting this line, less what they hold.
    const owed = portionsBp.map(
      (bp, i) => deficit[i] + units * bp - given[i] * FULL_PORTION_BP,
    );

    let remainder = units - given.reduce((sum, g) => sum + g, 0);
    const candidates = portionsBp.map((_, i) => i).filter((i) => (anyEligible ? eligible[i] : true));
    while (remainder !== 0) {
      const step = remainder > 0 ? 1 : -1;
      let pick = -1;
      for (const i of candidates) {
        if (step < 0 && given[i] === 0) continue;
        // Later payers win ties, so the last payer takes an unclaimed cent.
        if (pick === -1 || (step > 0 ? owed[i] >= owed[pick] : owed[i] <= owed[pick])) pick = i;
      }
      if (pick === -1) pick = candidates[candidates.length - 1];
      given[pick] += step;
      owed[pick] -= step * FULL_PORTION_BP;
      remainder -= step;
    }
    owed.forEach((value, i) => { deficit[i] = value; });
    return given;
  };
}

/** Basis points representing a whole invoice. */
export const FULL_PORTION_BP = 10000;

export interface PayerPortion {
  clientId: string;
  portionBp: number;
}

export interface AllocatedLine {
  /** The source line, unchanged. */
  source: any;
  allocationPercent: number;
  allocationAmount: number;
  allocationHours: number;
}

export interface PayerAllocation {
  clientId: string;
  portionBp: number;
  timeEntries: AllocatedLine[];
  flatFees: AllocatedLine[];
  totalAmount: number;
  totalHours: number;
  flatFeesAmount: number;
  /** This payer's share of the whole bill, as a percentage. */
  allocationPercent: number;
}

/**
 * Split every line of a matter's unbilled work across its payers.
 *
 * Each line is divided independently rather than by handing whole lines to
 * whoever is owed the most: a payer on a 40% share expects to see 40% of every
 * item on their copy of the bill, which is what makes a split invoice auditable
 * against the matter's other copies.
 *
 * `timeEntries` and `flatFees` are the same shapes `createInvoice` takes, with
 * `amount` in dollars.
 */
export function allocateWorkToPayers({
  payers,
  timeEntries,
  flatFees,
}: {
  payers: PayerPortion[];
  timeEntries: any[];
  flatFees: any[];
}): PayerAllocation[] {
  const portions = payers.map((payer) => payer.portionBp);
  const amountSplitter = createDiffusingSplitter(portions);
  const hoursSplitter = createDiffusingSplitter(portions);

  // One splitter per quantity, fed line by line in order, so the diffusion
  // state carries across lines. Results are dollars/hours to two decimals.
  const splitLine = (splitter: (units: number) => number[], value: number) =>
    splitter(Math.round(roundSplitValue(value) * 100)).map((units) => units / 100);

  // Per line, per payer: [lineIndex][payerIndex].
  const timeAmountShares = timeEntries.map((entry) => splitLine(amountSplitter, entry.amount));
  const timeHourShares = timeEntries.map((entry) => splitLine(hoursSplitter, entry.hours));
  const feeAmountShares = flatFees.map((fee) => splitLine(amountSplitter, fee.amount));

  const grandTotal = roundSplitValue(
    timeEntries.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0) +
      flatFees.reduce((sum, fee) => sum + (Number(fee.amount) || 0), 0),
  );

  return payers.map((payer, payerIndex) => {
    const allocatedTime: AllocatedLine[] = timeEntries.map((entry, lineIndex) => ({
      source: entry,
      allocationPercent: roundSplitValue((payer.portionBp / FULL_PORTION_BP) * 100),
      allocationAmount: timeAmountShares[lineIndex][payerIndex],
      allocationHours: timeHourShares[lineIndex][payerIndex],
    }));

    const allocatedFees: AllocatedLine[] = flatFees.map((fee, lineIndex) => ({
      source: fee,
      allocationPercent: roundSplitValue((payer.portionBp / FULL_PORTION_BP) * 100),
      allocationAmount: feeAmountShares[lineIndex][payerIndex],
      allocationHours: 0,
    }));

    const timeAmount = roundSplitValue(
      allocatedTime.reduce((sum, line) => sum + line.allocationAmount, 0),
    );
    const flatFeesAmount = roundSplitValue(
      allocatedFees.reduce((sum, line) => sum + line.allocationAmount, 0),
    );
    const totalHours = roundSplitValue(
      allocatedTime.reduce((sum, line) => sum + line.allocationHours, 0),
    );

    return {
      clientId: payer.clientId,
      portionBp: payer.portionBp,
      timeEntries: allocatedTime,
      flatFees: allocatedFees,
      totalAmount: roundSplitValue(timeAmount + flatFeesAmount),
      totalHours,
      flatFeesAmount,
      allocationPercent:
        grandTotal > 0
          ? roundSplitValue(((timeAmount + flatFeesAmount) / grandTotal) * 100)
          : roundSplitValue((payer.portionBp / FULL_PORTION_BP) * 100),
    };
  });
}
