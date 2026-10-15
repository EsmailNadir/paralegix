/**
 * A concurrency gate whose queue deadline becomes a 503 the client can retry.
 *
 * `createLimiter` rejects a caller that waited past `queueTimeoutMs` with a
 * `ConcurrencyQueueTimeoutError`, which carries no status, so left alone it
 * reaches the error handler as an unexplained 500. A full queue is not a crash:
 * the same request will work once the backlog clears. This turns exactly that
 * case into `503 <code>` with a `Retry-After`, and nothing else.
 *
 * Only a timeout waiting for THIS gate is translated. An error the work itself
 * throws passes through untouched, including a queue timeout from another gate
 * further in, so each gate reports only its own congestion.
 */
import { AppError } from '../errors/AppError';

const { createLimiter } = require('./runWithConcurrency');

/** How long a busy refusal tells the client to wait before trying again. */
const BUSY_RETRY_AFTER_SECONDS = 5;

interface BusyGateOptions {
  /** How long a caller may wait for a place before it is refused. */
  queueTimeoutMs: number;
  /** User-facing copy for the refusal. */
  message: string;
  /** The response `code` for the refusal. */
  code: string;
}

export function createBusyGate(limit: number, { queueTimeoutMs, message, code }: BusyGateOptions) {
  const limiter = createLimiter(limit, { queueTimeoutMs });
  return async function withGate<T>(work: () => Promise<T>): Promise<T> {
    let started = false;
    try {
      return await limiter(() => {
        started = true;
        return work();
      });
    } catch (err: any) {
      if (!started && err?.code === 'CONCURRENCY_QUEUE_TIMEOUT') {
        throw new AppError(message, 503, code, { retryAfterSeconds: BUSY_RETRY_AFTER_SECONDS });
      }
      throw err;
    }
  };
}
