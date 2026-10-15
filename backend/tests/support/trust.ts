/**
 * Trust ledger calls every trust spec makes: open an account, post an entry,
 * read a client's balance. All three go through the real routes, so the
 * permission check, validation and the ledger's row-locked balance update run
 * exactly as they do in production.
 *
 * Amounts are CENTS: the trust API takes `amountCents` directly.
 */
import type { Actor } from './actors';

const trustBase = (lawFirmId: string) => `/api/lawfirms/${lawFirmId}/trust`;

/** Open an IOLTA account through the API and return its id. */
export async function createTrustAccount(
  actor: Actor,
  lawFirmId: string,
  { name = 'Primary IOLTA', last4 = '1111' }: { name?: string; last4?: string } = {},
): Promise<string> {
  const res = await actor.api.post(`${trustBase(lawFirmId)}/accounts`).send({
    name, accountType: 'iolta', bankName: 'Test Bank', accountNumberLast4: last4,
  });
  if (res.status !== 201) {
    throw new Error(`createTrustAccount answered ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body.account.id as string;
}

export interface TrustEntry {
  trustAccountId: string;
  clientId: string;
  type: string;
  amountCents: number;
  [field: string]: unknown;
}

/**
 * POST one ledger entry and return the raw response, so a spec can assert a
 * refusal as easily as a success. `clientName` and `date` default to the values
 * every spec used; anything else in `entry` is sent as given.
 */
export function postTrustTxn(actor: Actor, lawFirmId: string, entry: TrustEntry) {
  return actor.api.post(`${trustBase(lawFirmId)}/transactions`).send({
    clientName: 'Trust Client',
    date: '2026-03-15',
    ...entry,
  });
}

/**
 * The client's total trust balance as the balance route reports it. Read without
 * a fallback: if `totalBalanceCents` disappeared this returns NaN and a spec
 * asserting zero fails, rather than passing on a defaulted 0.
 */
export async function trustClientBalanceCents(actor: Actor, lawFirmId: string, clientId: string): Promise<number> {
  const res = await actor.api.get(`${trustBase(lawFirmId)}/clients/${clientId}/balance`);
  if (res.status !== 200) {
    throw new Error(`client balance answered ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return Number(res.body.totalBalanceCents);
}
