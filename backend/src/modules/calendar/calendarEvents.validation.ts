import { z } from 'zod';
const { dateWindow } = require('../../shared/validation/listQuery');

// External events feed for the calendar. `from`/`to` bound the read to the days
// being drawn; omitting them returns every external event for the firm.
export const listExternalEventsSchema = z.object({
  query: z.object({
    ...dateWindow(),
    tz: z.string().optional(),
  }).passthrough(),
});
