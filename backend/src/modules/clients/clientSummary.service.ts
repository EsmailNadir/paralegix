import { NotFoundError } from '../../shared/errors/AppError';
import { assertLawFirmMembership, isFirmOwnerOrAdmin } from '../../shared/utils/membership';
import { isUuid } from '../../shared/utils/isUuid';
import { hasPermission } from '../lawfirms/roles/permissions';
import { clientExists, countClientMatters, sumClientInvoices } from './clientSummary.repository';

interface ClientSummaryInput {
  lawFirmId: string;
  clientId: string;
  userId: string;
  /** The resolved member `requirePermission` attached to the request. */
  member: unknown;
}

/**
 * The client detail header figures: how many matters the client is on, and the
 * invoice count with billed / paid / outstanding totals in integer cents.
 *
 * Each block is gated on the permission of the list it replaces, so a caller who
 * could not read that list gets `null` rather than figures derived from it:
 * `matters` on `matters.view`, `billing` on `billing.viewInvoices`. Within a
 * block the matter wall applies exactly as it does on those lists.
 */
export async function getClientSummary({ lawFirmId, clientId, userId, member }: ClientSummaryInput) {
  await assertLawFirmMembership(lawFirmId, userId);
  if (!isUuid(clientId) || !(await clientExists(lawFirmId, clientId))) {
    throw new NotFoundError('Client');
  }

  const canMatters = hasPermission(member, 'matters.view');
  const canInvoices = hasPermission(member, 'billing.viewInvoices');
  const seeAll = canMatters || canInvoices ? await isFirmOwnerOrAdmin(lawFirmId, userId) : false;
  const scope = { lawFirmId, userId, clientId, seeAll };

  const [matterCount, billing] = await Promise.all([
    canMatters ? countClientMatters(scope) : null,
    canInvoices ? sumClientInvoices(scope) : null,
  ]);

  return {
    clientId,
    matters: matterCount === null ? null : { count: matterCount },
    billing,
  };
}
