import { z } from 'zod';
import { updateClientSchema as clientsUpdateSchema } from '../../clients/clients.validation';

// Mirrors clients.validation.ts's preferredContactMethodEnum: matter-scoped
// clients are the same underlying client record, so they accept the same values.
const preferredContactMethodEnum = z.enum(['email', 'phone', 'sms', 'portal']);
// Mirrors clients.validation.ts's clientTypeEnum. Only meaningful when the
// request creates a brand-new client (no clientId/userId match); an inline
// pick of an existing client keeps that client's own immutable type.
const clientTypeEnum = z.enum(['person', 'company']);

/**
 * How many matters one batched client read may name.
 *
 * Sized from the caller, not from the database. The invoice-run page asks for
 * every unbilled matter on the run, and the largest firm behaviour recorded so
 * far is sixty; a hundred leaves room above that while keeping the request line
 * short. A hundred comma-joined uuids is about 3.7 KB of URL, so the whole
 * request line stays well under the 16 KB Node allows for it and the
 * Authorization bearer token, which draws on the same budget. A caller holding
 * more matters than this pages the read; it is never silently truncated, because
 * a lost id reads downstream as "this matter has no split" rather than as an
 * error.
 */
export const MAX_BATCH_MATTER_IDS = 100;

/**
 * GET /matters/clients?matterIds=a,b,c
 *
 * Comma-separated rather than repeated, so the URL stays short, and split here
 * rather than in the route so the cap is enforced by the validation middleware
 * before the handler (and therefore before any query) runs.
 */
export const listClientsForMattersSchema = z.object({
  query: z.object({
    matterIds: z.string()
      .transform((value) => value.split(',').map((id) => id.trim()).filter(Boolean))
      .pipe(
        z.array(z.string().uuid('matterIds must be matter ids'))
          .min(1, 'matterIds is required')
          .max(
            MAX_BATCH_MATTER_IDS,
            `Too many matterIds: maximum is ${MAX_BATCH_MATTER_IDS} per request. Page the request into smaller batches.`,
          ),
      ),
  }),
});

export const addClientSchema = z.object({
  body: z.object({
    client: z.object({
      clientId: z.string().uuid().optional().nullable(),
      userId: z.string().optional().nullable(),
      clientType: clientTypeEnum.optional(),
      name: z.string().min(1, 'Client name is required'),
      email: z.string().nullable().optional().transform(v => v ?? ''),
      phone: z.string().nullable().optional().transform(v => v ?? ''),
      organization: z.string().nullable().optional().transform(v => v ?? ''),
      address: z.string().nullable().optional().transform(v => v ?? ''),
      // null is the form's "None"; leaving the field out takes the 'email' default.
      preferredContactMethod: preferredContactMethodEnum.nullable().optional(),
    }),
  }),
});

// Editing a client from a matter writes the shared client record, so it takes
// exactly the fields and rules of the client update endpoint: one schema, not a
// second copy that drifts (the matter-local one did not trim the name or check
// the email). A field left out is left untouched; null clears an optional one.
export const updateClientSchema = z.object({
  body: z.object({
    client: clientsUpdateSchema.shape.body,
  }),
});

/**
 * The billing split for a matter, as clientId -> basis points (10000 = 100%).
 *
 * An empty map is valid and means "no split": the matter goes back to being
 * invoiced to one client at a time. A non-empty map must cover exactly the
 * matter's clients and total 10000, which the service checks, since neither
 * rule can be expressed against the payload alone.
 */
export const setBillingPortionsSchema = z.object({
  body: z.object({
    portions: z.record(
      z.string().uuid(),
      z.number().int().min(0).max(10000),
    ),
  }),
});
