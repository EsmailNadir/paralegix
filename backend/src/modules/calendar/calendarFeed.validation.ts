import { z } from 'zod';

import { dayOnly } from '../../shared/validation/listQuery';

/**
 * The combined calendar feed's window.
 *
 * The standalone range reads treat `from`/`to` as optional and answer a missing
 * or inverted pair with the firm's WHOLE history. The feed runs five of those
 * reads at once, so it refuses that shape instead: both bounds are required and
 * must be in order. Each bound is validated exactly as the standalone reads
 * validate theirs (`dayOnly`), so a malformed day is a 400 on both.
 */
export const calendarFeedSchema = z.object({
  query: z.object({
    from: dayOnly,
    to: dayOnly,
    tz: z.string().optional(),
  }).passthrough().refine((query) => query.from <= query.to, {
    message: '`from` must be on or before `to`',
    path: ['to'],
  }),
});
