/** Durable webhook work is recorded before acknowledgment and replayed from the
 * last committed cursor or the specific Outlook event. */

const calendarSyncRepo = require('./calendarSync.repository');

async function retryOne(failure: any) {
  // Lazy-require the services to avoid a require cycle (services -> engine -> here).
  if (failure.provider === 'google') {
    const googleService = require('../google/google.service');
    if (failure.changeType === 'deleted' && failure.eventId) {
      await googleService.reprocessInboundDelete({
        userId: failure.userId,
        lawFirmId: failure.lawFirmId,
        eventId: failure.eventId,
      });
    }
    await googleService.processWatchNotification({
      userId: failure.userId,
      lawFirmId: failure.lawFirmId,
      ...(failure.changeType === 'catch_up' ? { forceFull: true } : {}),
    });
    return;
  }
  if (failure.provider === 'outlook') {
    const outlookService = require('../outlook/outlook.service');
    if (failure.changeType === 'catch_up') {
      await outlookService.syncFromOutlook({ userId: failure.userId, lawFirmId: failure.lawFirmId });
      return;
    }
    await outlookService.processSubscriptionNotification({
      userId: failure.userId,
      lawFirmId: failure.lawFirmId,
      changeType: failure.changeType || 'updated',
      resource: failure.resource || undefined,
      resourceData: failure.eventId ? { id: failure.eventId } : undefined,
    });
    return;
  }
  throw new Error(`unknown provider: ${failure.provider}`);
}

/**
 * Process every due webhook-failure work item once. Returns a small summary the
 * cron can log. Each item that succeeds is removed; each that fails again is
 * rescheduled with backoff (and dead-letters once it exhausts its attempts).
 *
 * `limit` bounds the pass by row count, `deadline` (epoch ms, shared across the
 * cron request) by wall clock: a retry talks to a provider
 * that may be slow or unresponsive, so 50 of them have no bounded duration.
 * Items not reached stay due and are picked up by the next run, so stopping
 * early defers work rather than dropping it.
 */
export async function retryFailedWebhooks({ limit = 50, deadline = null }: any = {}) {
  let due;
  try {
    due = await calendarSyncRepo.listDueWebhookFailures(limit);
  } catch (err: any) {
    console.error('calendarWebhookRetry: failed to list due failures:', err);
    return { attempted: 0, succeeded: 0, failed: 0, truncated: false };
  }

  let succeeded = 0;
  let failed = 0;
  let attempted = 0;
  for (const failure of due) {
    if (deadline && Date.now() >= deadline) break;
    attempted++;
    try {
      await retryOne(failure);
      await calendarSyncRepo.resolveWebhookFailure(failure.dedupeKey, failure.leaseToken);
      succeeded++;
    } catch (err: any) {
      console.error(
        `calendarWebhookRetry: retry failed (provider=${failure.provider} user=${failure.userId} attempts=${failure.attempts}):`,
        err.message || err
      );
      await calendarSyncRepo.rescheduleWebhookFailure(failure.dedupeKey, err, failure.leaseToken);
      failed++;
    }
  }

  // Surface dead-lettered rows so they aren't silently stranded. These are rows
  // that exhausted WEBHOOK_RETRY_MAX_ATTEMPTS and are no longer selected by the
  // sweep; recordWebhookFailure resets one on a genuinely-new failure, but a
  // long-stuck row still needs a human signal. Log a count (+ a small sample) as
  // a poor-man's metric/alert on every sweep.
  let deadLettered = 0;
  try {
    deadLettered = await calendarSyncRepo.countDeadLetteredWebhookFailures();
    if (deadLettered > 0) {
      const sample = await calendarSyncRepo.listDeadLetteredWebhookFailures(5);
      console.warn(
        `calendarWebhookRetry: ${deadLettered} dead-lettered webhook-failure row(s) ` +
        `(>= ${calendarSyncRepo.WEBHOOK_RETRY_MAX_ATTEMPTS} attempts). Sample:`,
        sample.map((f: any) => ({ provider: f.provider, userId: f.userId, changeType: f.changeType, lastError: (f.lastError || '').slice(0, 120) }))
      );
    }
  } catch (err: any) {
    console.error('calendarWebhookRetry: failed to inspect dead-letter rows:', err.message || err);
  }

  const truncated = attempted < due.length;
  if (truncated) {
    console.warn(
      `calendarWebhookRetry: budget exhausted after ${attempted}/${due.length} due item(s); ` +
      'the rest stay due for the next sweep'
    );
  }

  return { attempted, succeeded, failed, deadLettered, truncated };
}
