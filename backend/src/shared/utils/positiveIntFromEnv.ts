/**
 * A positive integer from the environment, or `fallback`.
 *
 * For deploy knobs whose default is the value a budget was sized for: a
 * concurrency, a queue deadline. A zero would stall every caller, and a
 * fraction or a negative is a typo. `Number(x) || fallback` keeps a negative,
 * because it is truthy, and a negative queue deadline silently disables the
 * deadline. So anything that is not a positive integer keeps the default.
 */
export function positiveIntFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
