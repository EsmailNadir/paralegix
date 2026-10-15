import { assertClientInFirm } from '../../shared/utils/clientScope';

const membership = require('../../shared/utils/membership');
const { ValidationError } = require('../../shared/errors/AppError');

export const CONTEXT_TYPES = {
  matter: 'matter',
  client: 'client',
  // Future: task: 'task',
};

/** Which gate a caller wants; see `authorizeContext`. */
export const MODE_READ = 'read';
export const MODE_WRITE = 'write';

/**
 * Entity-level authorization per context type.
 * Route-level permission checks (e.g. requirePermission('billing.manageTimeEntries'))
 * are handled separately in middleware.
 *
 * On a matter context the gate depends on `mode`: a read follows the matter's
 * read rule, so a firm owner or admin may list the billing records of any matter
 * in the firm, while a write still requires real matter membership. Mirrors
 * `resolveFileScope` in files.scope.ts. `mode` defaults to write, so a caller
 * that says nothing gets the stricter gate.
 */
export async function authorizeContext(context: any, userId: string, mode = MODE_WRITE) {
  switch (context.type) {
    case CONTEXT_TYPES.matter:
      return mode === MODE_READ
        ? membership.assertMatterReadAccess(context.lawFirmId, context.entityId, userId)
        : membership.assertMatterMembership(context.lawFirmId, context.entityId, userId);
    case CONTEXT_TYPES.client:
      // BOTH halves. Firm membership proves the CALLER belongs here; the client
      // check proves the SUBJECT does. Without the second, a member of firm B
      // could post billing records naming a client of firm A: the row is written
      // with firm B's `law_firm_id` and firm A's `client_id`, so no list endpoint
      // in either firm ever shows it. The work is unbillable and invisible, and
      // `clients.id` cascades on delete, so firm A removing that client silently
      // deletes firm B's rows.
      //
      // The matter arm has always checked its entity this way. This arm did not.
      await membership.assertLawFirmMembership(context.lawFirmId, userId);
      return assertClientInFirm(context.lawFirmId, context.entityId);
    // case CONTEXT_TYPES.task:
    //   return membership.assertTaskAccess(context.lawFirmId, context.entityId, userId);
    default:
      throw new Error(`Unknown billing context for auth: ${context.type}`);
  }
}

/**
 * Resolve and validate a billing context from route/body inputs.
 * Supports either:
 * - context object: { type, lawFirmId, entityId }
 * - matterId / clientId shorthand
 */
export function resolveContext({ lawFirmId, context, matterId, clientId }: any) {
  if (context && typeof context === 'object') {
    if (!context.type || !context.entityId) {
      throw new ValidationError({
        context: ['context.type and context.entityId are required'],
      });
    }
    if (context.lawFirmId && context.lawFirmId !== lawFirmId) {
      throw new ValidationError({
        context: ['context.lawFirmId must match route lawFirmId'],
      });
    }
    return {
      type: context.type,
      lawFirmId,
      entityId: context.entityId,
    };
  }

  const hasMatterId = typeof matterId === 'string' && matterId.trim().length > 0;
  const hasClientId = typeof clientId === 'string' && clientId.trim().length > 0;

  if (hasMatterId && hasClientId) {
    throw new ValidationError({
      context: ['Provide either matterId or clientId, not both'],
    });
  }

  if (hasMatterId) {
    return {
      type: CONTEXT_TYPES.matter,
      lawFirmId,
      entityId: matterId.trim(),
    };
  }

  if (hasClientId) {
    return {
      type: CONTEXT_TYPES.client,
      lawFirmId,
      entityId: clientId.trim(),
    };
  }

  throw new ValidationError({
    context: ['Either matterId or clientId is required'],
  });
}
