/**
 * Structured logging for Node process warnings.
 *
 * Node's default handler prints a warning to stderr as a single line with no
 * stack. During a staging load test the API logged repeated
 * "MaxListenersExceededWarning: ... 11 close listeners added to [PassThrough]"
 * and nothing said which code added them. This records the stack, so the next
 * occurrence names its source. Node's default stderr print still happens.
 */
interface WarningLog {
  warn(fields: Record<string, unknown>, message: string): void;
}

interface WarningSource {
  on(event: 'warning', listener: (warning: any) => void): unknown;
}

export function installWarningLogger(proc: WarningSource, log: WarningLog): void {
  proc.on('warning', (warning: any) => {
    const fields: Record<string, unknown> = {
      event: 'process.warning',
      warningName: warning?.name,
      stack: warning?.stack,
    };
    // A MaxListenersExceededWarning carries the emitter it fired on, which is
    // how the leaking stream's type and event are told apart.
    if (warning?.emitter) {
      fields.emitter = warning.emitter.constructor?.name;
      fields.eventName = typeof warning.type === 'symbol' ? warning.type.toString() : warning.type;
      fields.listenerCount = warning.count;
    }
    log.warn(fields, String(warning?.message || warning));
  });
}
