import {
  createFirm, createPersonClient, createOrgClient, linkPersonToOrg, createPortalUser, ownerOf, as, tokenFor, drainEvents,
} from '../../support/setupInProcess';

export const day = (offset: number, from = new Date()) =>
  new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + offset)).toISOString().slice(0, 10);

/** One firm, one owner, one client with a portal login. Days are UTC, and the viewer zone is UTC. */
export async function mini() {
  const firm = await createFirm({ planId: 'enterprise' });
  const owner = await ownerOf(firm.id);
  const login = await createPortalUser();
  const client = await createPersonClient(firm.id, { name: 'Mini', email: 'mini@example.test', userId: login.uid });
  const B = `/api/lawfirms/${firm.id}/billing`;
  const api = as(tokenFor({ uid: owner.uid }), 'UTC');
  const portal = as(tokenFor({ uid: login.uid }), 'UTC');
  const issue = async (name: string, dollars: number, dueDay: string | null, invoiceDate = day(-2)) => {
    const res = await api.post(`${B}/invoices/client/${client.id}`).send({
      invoiceName: name, invoiceDate, ...(dueDay ? { dueDate: dueDay } : {}),
      totalAmount: dollars, flatFeesAmount: dollars,
      flatFees: dollars > 0 ? [{ description: name, amount: dollars }] : [],
    });
    expect(res.status).toBe(201);
    await drainEvents();
    return res.body.invoice.id as string;
  };
  return { firm, owner, api, portal, client, B, issue, login, createOrgClient, linkPersonToOrg };
}
