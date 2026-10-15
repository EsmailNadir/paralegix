import { z } from 'zod';

export const updateNameSchema = z.object({
  body: z.object({
    // `.trim()` BEFORE `.min(1)`: the service trims the value it stores, so a
    // whitespace-only name passed a bare `min(1)` and then landed as the empty
    // string. `users.name` is read by every roster, note byline and message
    // sender label across every firm the person belongs to, so that renders as
    // a nameless person everywhere at once with nothing on screen to explain it.
    name: z.string().trim().min(1, 'Name is required').max(100, 'Name must be less than 100 characters'),
  }),
});
