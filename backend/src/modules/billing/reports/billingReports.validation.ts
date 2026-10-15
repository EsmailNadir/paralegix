import { z } from 'zod';
const { paging } = require('../../../shared/validation/listQuery');

const MATTER_STATUSES = ['active', 'pending', 'on_hold', 'in_progress', 'completed', 'blocked', 'closed', 'archived'];

/**
 * The by-matter report query. Filters are applied to the aggregate rows in
 * Postgres, so a page always cuts the same filtered set the header's counts
 * describe.
 */
export const byMatterReportSchema = z.object({
  query: z.object({
    ...paging({ max: 100 }),
    search: z.string().max(500).optional(),
    status: z.enum(MATTER_STATUSES).optional(),
    // Matched by NAME, mirroring the dropdown, whose options are practice-area
    // names rather than ids.
    practiceArea: z.string().max(200).optional(),
  }).passthrough(),
});

/** The by-client report query. Search matches the client or any of their matters. */
export const byClientReportSchema = z.object({
  query: z.object({
    ...paging({ max: 100 }),
    search: z.string().max(500).optional(),
  }).passthrough(),
});

/**
 * The per-client matter breakdown.
 *
 * `clientId` reaches the repository as a `$2::uuid` cast, so a malformed value
 * is a Postgres cast error, which surfaces as a 500 INTERNAL_ERROR rather than a
 * refusal. A value that is not a uuid can never name a client, so it is rejected
 * here instead of being asked about.
 */
export const clientMatterBreakdownSchema = z.object({
  params: z.object({
    clientId: z.string().uuid('Expected a client id'),
  }).passthrough(),
});
