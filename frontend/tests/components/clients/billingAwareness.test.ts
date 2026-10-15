import {
  buildMatterBillingDraftHref,
  buildClientScopedInvoices,
  getMatterItemDraftActionLabel,
  getMatterItemRecipientStatusLabel,
  getBillingRelationLabel,
  resolveMatterItemDraftRecipientTarget,
} from "@/components/clientComp/billingAwareness";
import type { Matter, Client, Invoice } from "@/types";

describe("billingAwareness", () => {
  const currentClient: Client = {
    id: "client-a",
    userId: "user-a",
    name: "Client A",
    email: "a@example.com",
  };

  const sharedMatter: Matter = {
    id: "matter-1",
    name: "Shared Matter",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    clients: [
      {
        id: "matter-client-a",
        userId: "client-a",
        name: "Client A",
        lawFirmId: "firm-1",
        matterId: "matter-1",
      },
      {
        id: "matter-client-b",
        userId: "client-b",
        name: "Client B",
        lawFirmId: "firm-1",
        matterId: "matter-1",
      },
    ],
  };

  it("marks matter invoices billed to another client as other_client", () => {
    const invoices = buildClientScopedInvoices({
      matterInvoices: [
        {
          id: "invoice-b",
          invoiceName: "Invoice B",
          matterId: "matter-1",
          clientId: "client-b",
          clientName: "Client B",
          timeEntries: [{ id: "time-1", amount: 250 }],
        } satisfies Invoice,
      ],
      directInvoices: [],
      clientMatters: [sharedMatter],
      currentClient,
    });

    expect(invoices).toHaveLength(1);
    expect(invoices[0].billingRelation).toBe("other_client");
    expect(invoices[0].billingRecipientName).toBe("Client B");
    expect(getBillingRelationLabel(invoices[0].billingRelation, invoices[0].billingRecipientName)).toBe("Billed to Client B");
  });

  it("marks direct client invoices as owned", () => {
    const invoices = buildClientScopedInvoices({
      matterInvoices: [],
      directInvoices: [
        {
          id: "invoice-direct",
          invoiceName: "Direct Invoice",
          clientId: "client-a",
          totalAmount: 100,
        } satisfies Invoice,
      ],
      clientMatters: [sharedMatter],
      currentClient,
    });

    expect(invoices[0].billingRelation).toBe("owned");
    expect(invoices[0].billingRecipientClientId).toBe("client-a");
  });

  it("resolves a single preferred matter client for draft billing", () => {
    const target = resolveMatterItemDraftRecipientTarget({
      matterRecord: sharedMatter,
      currentClient,
      matterClientId: "matter-client-b",
    });

    expect(target.recipientMode).toBe("single");
    expect(target.recipientMatterClientId).toBe("matter-client-b");
    expect(getMatterItemRecipientStatusLabel(target)).toBe("Bills to Client B");
    expect(getMatterItemDraftActionLabel(target)).toBe("Bill from Matter");
    expect(
      buildMatterBillingDraftHref({
        lawFirmId: "firm-1",
        matterId: "matter-1",
        draftType: "time_entry",
        draftId: "time-1",
        target,
      }),
    ).toBe("/lawfirm/firm-1/matters/matter-1/generate-invoice?draftType=time_entry&draftId=time-1&billToMatterClientId=matter-client-b");
  });

  it("resolves multiple preferred matter clients as split billing", () => {
    const target = resolveMatterItemDraftRecipientTarget({
      matterRecord: sharedMatter,
      currentClient,
      matterClientIds: ["matter-client-a", "matter-client-b"],
    });

    expect(target.recipientMode).toBe("multiple");
    expect(getMatterItemRecipientStatusLabel(target)).toBe("Multiple preferred clients");
    expect(getMatterItemDraftActionLabel(target)).toBe("Split Bill");
    expect(
      buildMatterBillingDraftHref({
        lawFirmId: "firm-1",
        matterId: "matter-1",
        draftType: "time_entry",
        draftId: "time-2",
        target,
      }),
    ).toBe("/lawfirm/firm-1/matters/matter-1/generate-invoice?draftType=time_entry&draftId=time-2&mode=split&preferredMatterClientIds=matter-client-a%2Cmatter-client-b");
  });

  it("leaves shared matter items without a recipient unassigned", () => {
    const target = resolveMatterItemDraftRecipientTarget({
      matterRecord: sharedMatter,
      currentClient,
    });

    expect(target.recipientMode).toBe("unassigned");
    expect(getMatterItemRecipientStatusLabel(target)).toBe("Recipient not chosen");
    expect(getMatterItemDraftActionLabel(target)).toBe("Choose Recipient");
    expect(
      buildMatterBillingDraftHref({
        lawFirmId: "firm-1",
        matterId: "matter-1",
        draftType: "flat_fee",
        draftId: "fee-1",
        target,
      }),
    ).toBe("/lawfirm/firm-1/matters/matter-1/generate-invoice?draftType=flat_fee&draftId=fee-1");
  });
});
