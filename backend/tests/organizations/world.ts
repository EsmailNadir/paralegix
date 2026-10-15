/**
 * The cast every organization spec needs, in one call.
 *
 * Organizations are a variant retrofitted onto an entity that already existed
 * everywhere, so the bugs cluster wherever an old invariant was assumed. Four
 * invariants matter, and this world is shaped to make each one testable:
 *
 *   I1  One client row is one portal user (`clients.user_id`).
 *       False: an organization can NEVER carry `user_id`. Its people are
 *       separate client rows reached through `client_company_links`.
 *   I2  A client's items belong to that client alone.
 *       False: a person on a roster must also reach the organization's items.
 *   I3  A client's money is their own.
 *       False: `can_view_billing` gates it per link.
 *   I4  `clients.organization` is a text field naming the org.
 *       False: an organization client leaves it null; its name is `clients.name`.
 *
 * `outsider` and `otherFirm` are not padding. A widening bug and a tenancy leak
 * look identical from inside one firm with one portal user, and only these two
 * tell them apart: if a test asserts "billing CAN see it" without also asserting
 * "outsider CANNOT", it passes just as happily against code that shows the
 * organization's data to everybody.
 *
 * A portal caller chooses WHICH client record it is acting as through
 * `?clientRecordId=`, read by `readClientRecordId` in portal.routes.ts. That is
 * the vector for I2 and I3: a roster person asking for the organization's
 * record.
 */
import {
  testPool,
  resetCaches,
  createFirm,
  createOrgClient,
  createPersonClient,
  createPortalUser,
  linkPersonToOrg,
  createInvoice,
  createTrustDeposit,
  as,
  tokenFor,
  ownerOf,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';

export interface PortalActor extends Actor {
  /** The `clients` row this portal user owns. */
  clientId: string;
}

export interface OrgWorld {
  firm: Firm;
  owner: Actor;

  /** client_type = 'company'. Never carries user_id. */
  org: ClientRecord;
  orgName: string;

  /** On the roster, can_view_billing = true, is_primary = true. */
  billing: PortalActor;
  /** On the roster, can_view_billing = false. */
  noBilling: PortalActor;
  /** A portal user in the SAME firm who is on no roster. */
  outsider: PortalActor;

  /**
   * An issued invoice against the organization, and its total in cents.
   *
   * Money in the world is not decoration. Against an empty world a leak and a
   * correct refusal both answer zero, so an I3 case run without this is a false
   * green on every money surface. The total is distinctive so its presence in a
   * response body means something.
   */
  orgInvoice: { id: string; totalCents: number };

  /**
   * A completed trust deposit for the organization, with a distinct amount.
   *
   * Trust surfaces report trust money rather than invoice money, so they need
   * their own figure or their `can_view_billing` cases pass against an empty
   * ledger regardless of what the code does.
   */
  orgTrust: { accountId: string; transactionId: string; amountCents: number };

  /**
   * A second firm, for the tenancy half of every assertion.
   *
   * It carries a PORTAL user as well as an owner, because the two halves of the
   * API refuse different callers: portal routes mount
   * `requireUserType(['client'])`, so a firm member is turned away before any
   * organization logic runs and a tenancy assertion using one would pass for the
   * wrong reason.
   */
  otherFirm: { firm: Firm; owner: Actor; portal: PortalActor };
}

async function makePortalActor(lawFirmId: string, name: string): Promise<PortalActor> {
  const { uid } = await createPortalUser();
  const client = await createPersonClient(lawFirmId, {
    name,
    userId: uid,
    email: `${uid}@example.test`,
  });
  return { uid, clientId: client.id, api: as(tokenFor({ uid })) };
}

export async function buildOrgWorld(): Promise<OrgWorld> {
  const firm = await createFirm({ name: 'Org World Firm' });
  const owner = await ownerOf(firm.id);

  const orgName = 'Acme Corporation';
  const org = await createOrgClient(firm.id, { name: orgName });

  const billing = await makePortalActor(firm.id, 'Bea Billing');
  const noBilling = await makePortalActor(firm.id, 'Ned NoBilling');
  const outsider = await makePortalActor(firm.id, 'Otto Outsider');

  await linkPersonToOrg(firm.id, billing.clientId, org.id, {
    canViewBilling: true,
    isPrimary: true,
    isEmailRecipient: true,
  });
  await linkPersonToOrg(firm.id, noBilling.clientId, org.id, {
    canViewBilling: false,
  });
  // `outsider` is deliberately NOT linked.

  const orgInvoice = await createInvoice(firm.id, org.id, { totalCents: 731_900 });
  const orgTrust = await createTrustDeposit(firm.id, org.id, { amountCents: 412_600 });

  const otherFirmRecord = await createFirm({ name: 'Unrelated Firm' });
  const otherOwner = await ownerOf(otherFirmRecord.id);
  const otherPortal = await makePortalActor(otherFirmRecord.id, 'Xena Elsewhere');

  return {
    firm,
    owner,
    org,
    orgName,
    billing,
    noBilling,
    outsider,
    orgInvoice,
    orgTrust,
    otherFirm: { firm: otherFirmRecord, owner: otherOwner, portal: otherPortal },
  };
}

/** The `client_company_links` row joining a person to an organization, if any. */
export async function linkIdFor(
  lawFirmId: string, personClientId: string, companyClientId: string,
): Promise<string | undefined> {
  const { rows } = await testPool.query(
    `select id from client_company_links
      where law_firm_id = $1 and person_client_id = $2 and company_client_id = $3`,
    [lawFirmId, personClientId, companyClientId],
  );
  return rows[0]?.id;
}

/**
 * Takes a person off a roster with raw SQL, then clears the portal caches so
 * the next request resolves afresh. Names one organization, or every one the
 * person is on when `companyClientId` is omitted.
 *
 * This bypasses the removal endpoint and its own cache invalidation. A spec
 * about THAT endpoint must call it instead (see `journeys.test.ts` J2).
 */
export async function removeFromRoster(
  lawFirmId: string, personClientId: string, companyClientId?: string,
): Promise<void> {
  await testPool.query(
    `delete from client_company_links
      where law_firm_id = $1 and person_client_id = $2
        and ($3::uuid is null or company_client_id = $3)`,
    [lawFirmId, personClientId, companyClientId ?? null],
  );
  resetCaches();
}
