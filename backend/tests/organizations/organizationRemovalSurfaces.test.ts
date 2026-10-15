/**
 * O09 (the plan's association-and-rights matrix): "Person removed from
 * organization. Matters/tasks/invoices/trust/documents/messages/notifications/
 * signatures each reflect current association rules. Distinguish explicit
 * signer grants that may intentionally survive an organization unlink."
 *
 * Three things this file establishes rather than assumes:
 *
 * 1. Matters, tasks, invoices, trust and documents are NOT five independent
 *    code paths. Every `asOrg`-scoped portal route resolves through the same
 *    `getActiveClientAccessContext` -> `selectActiveClientAssociation` gate
 *    (`portal.service.ts`), so once the organization association disappears
 *    from `resolveClientAssociations`, EVERY one of them refuses uniformly.
 *    `journeys.test.ts` J2 walks matters, billing, trust, documents and the
 *    dashboard through the real removal endpoint.
 * 2. `signatures/signingAccess.test.ts` ALREADY closes the signer-grant half
 *    of O09 explicitly ("keeps an assigned signing session after organization
 *    removal"), with the exact reasoning O09 asks for: a signing session is
 *    assigned to the person's own client identity, not the organization
 *    relationship, so it survives a roster removal by design. Not duplicated
 *    here.
 * 3. Notifications are the one surface that does NOT go through the
 *    association gate at all. `portal.service.ts`'s own comment calls this
 *    out: the bell is a "UID-owned feed... [that] remain[s] user-scoped," so
 *    it only proves SOME association with the firm still exists, never which
 *    one, and never whether the notification's own target is still reachable.
 *    That is a real, previously unexercised gap this file closes.
 */
import { drainEvents } from '../support/setupInProcess';
import { buildOrgWorld, removeFromRoster, type OrgWorld } from './world';

const { createNotifications } = require('../../src/modules/notifications/notifications.service');
const { eligibleCompanyPortalUserIds } = require('../../src/modules/clients/companyPortalRecipients');

let world: OrgWorld;

const F = () => `/api/client-portal/lawfirm/${world.firm.id}`;
const asOrg = (suffix: string) =>
  `${F()}${suffix}${suffix.includes('?') ? '&' : '?'}clientRecordId=${world.org.id}`;

beforeEach(async () => {
  world = await buildOrgWorld();
});

describe('O09: a notification issued while on the roster outlives the removal, unlike every association-gated surface', () => {
  it('CHARACTERISATION: the bell keeps showing it, and its unread count, after the org link is gone', async () => {
    // Mirrors the real shape `invoiceReminders.service.ts` sends on
    // `invoiceIssued` (`title`, `body`, `entityType: 'invoice'`, an
    // `actionUrl` into the organization's billing page) rather than a bare
    // shape a real notification would never have. `world.billing` is the
    // roster member `eligibleCompanyPortalUserIds` would actually pick:
    // `canViewBilling: true`.
    await createNotifications(world.firm.id, [world.billing.uid], {
      category: 'invoiceIssued',
      type: 'invoice_issued',
      title: 'New invoice issued',
      body: `Invoice ${world.orgInvoice.id} is ready to view`,
      entityType: 'invoice',
      entityId: world.orgInvoice.id,
      actionUrl: `/client/lawfirm/${world.firm.id}/billing?clientRecordId=${world.org.id}`,
      createdBy: null,
    });
    await drainEvents();

    const before = await world.billing.api.get(`${F()}/notifications`);
    expect(before.status).toBe(200);
    expect(before.body.notifications.map((n: any) => n.body)).toContain(`Invoice ${world.orgInvoice.id} is ready to view`);
    expect(before.body.unreadCount).toBeGreaterThan(0);

    await removeFromRoster(world.firm.id, world.billing.clientId);

    // The route it points at now correctly refuses: this is not a case of the
    // gate having a hole, it is the notification feed sitting outside the
    // gate entirely.
    const billingRead = await world.billing.api.get(asOrg('/billing'));
    expect(billingRead.status).toBeGreaterThanOrEqual(400);

    const after = await world.billing.api.get(`${F()}/notifications`);
    expect(after.status).toBe(200);
    // WHAT SHOULD HAPPEN, if the plan's "reflect current association rules"
    // is read literally: a notification whose target is no longer reachable
    // stops counting as an actionable, unread item.
    // WHAT ACTUALLY HAPPENS: `listClientNotifications` proves only that SOME
    // association with the firm survives, then reads every notification ever
    // issued to this uid, with no re-check against which associations are
    // still current. The entry, and its contribution to unreadCount, persist
    // unchanged.
    expect(after.body.notifications.map((n: any) => n.body)).toContain(`Invoice ${world.orgInvoice.id} is ready to view`);
    expect(after.body.unreadCount).toBe(before.body.unreadCount);

    // Pinned rather than fixed: whether a notification should be suppressed,
    // marked stale, or left as a historical log entry once its target is
    // unreachable is a product decision, not one to make inside a test file.
  });

  it('the real audience filter the invoice-issued path uses would pick billing and skip noBilling, so the case above is not a contrived audience', async () => {
    // The characterisation above hand-picks `world.billing.uid` as the
    // recipient rather than routing a real invoice through
    // `invoiceReminders.service.ts`. This calls the SAME production filter
    // that service calls (`eligibleCompanyPortalUserIds(..., 'invoiceIssued',
    // { requireBillingAccess: true })`) to prove that filter would have
    // produced exactly that audience: `noBilling` is on the same roster but
    // `can_view_billing: false`, so a real send would exclude them.
    const recipients = await eligibleCompanyPortalUserIds(
      world.firm.id, world.org.id, 'invoiceIssued', { requireBillingAccess: true },
    );

    expect(recipients).toContain(world.billing.uid);
    expect(recipients).not.toContain(world.noBilling.uid);
  });
});
