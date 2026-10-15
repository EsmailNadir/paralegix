const pino = require('pino');

// Map pino's numeric levels to the severity strings Google Cloud Logging
// understands. Cloud Logging buckets entries by the "severity" field; without
// this mapping every line would be classified as DEFAULT.
const PINO_LEVEL_TO_GCP_SEVERITY = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
};

// Single shared logger. JSON output with a top-level "message" field and a
// "severity" field so Cloud Logging parses each line as a structured entry.
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // Drop pino's default pid + hostname from every line. On Cloud Run the pid is
  // always 1 and the hostname is a throwaway container id, so they only add
  // bytes to every entry without aiding debugging (requestId correlates lines).
  base: undefined,
  // Cloud Logging keys the displayed log text off "message", not pino's default
  // "msg". Renaming the key here keeps the rest of the pino API unchanged.
  messageKey: 'message',
  formatters: {
    // Emit "severity" (Cloud Logging) instead of pino's numeric "level".
    level(label: string) {
      const map = PINO_LEVEL_TO_GCP_SEVERITY as Record<string, string | undefined>;
      return { severity: map[label] || 'DEFAULT' };
    },
  },
  // Never let credentials or session material reach the logs. Redacted paths are
  // replaced with [Redacted] wherever they appear on a logged object.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-cron-secret"]',
      'headers["x-cron-secret"]',
      'res.headers["set-cookie"]',
      'headers.authorization',
      'headers.cookie',
      'authorization',
      'token',
      'password',
      'set-cookie',
      '*.authorization',
      '*.token',
      '*.password',
    ],
    censor: '[Redacted]',
  },
});
