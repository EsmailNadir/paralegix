/** Stats shape returned when reminder sending is switched off entirely. */
export interface DisabledReminderStats {
  sent: number;
  skipped: number;
  errors: number;
  disabled: true;
}

/** Read an env-var-style flag: real booleans pass through, strings are parsed. */
function isTruthy(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function remindersGloballyDisabled(): boolean {
  return isTruthy(process.env.DISABLE_ALL_REMINDER_EMAILS);
}

export function disabledReminderStats(): DisabledReminderStats {
  return { sent: 0, skipped: 0, errors: 0, disabled: true };
}
