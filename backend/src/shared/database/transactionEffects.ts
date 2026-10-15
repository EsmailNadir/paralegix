import { withDrizzleTransaction, type DrizzleExecutor } from './queryContext';

export interface TransactionEffects {
  executor: DrizzleExecutor;
  defer(effect: () => void | Promise<void>): void;
}

/** Compose database transitions while publishing their effects only after the outer commit. */
export async function withTransactionEffects<TResult>(
  work: (context: TransactionEffects) => Promise<TResult>,
  context?: TransactionEffects,
): Promise<TResult> {
  if (context) return work(context);
  const effects: Array<() => void | Promise<void>> = [];
  const result = await withDrizzleTransaction((executor) => work({
    executor,
    defer: (effect) => { effects.push(effect); },
  }));
  for (const effect of effects) {
    try {
      await effect();
    } catch (error) {
      // The write is committed. Report delivery failures and let other effects still run.
      console.error('[transactionEffects] After-commit effect failed:', error);
    }
  }
  return result;
}
