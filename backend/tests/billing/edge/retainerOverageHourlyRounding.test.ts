/**
 * A retainer overage line is priced like the stored time entry amount (round half up).
 */
import { randomUUID } from "crypto";
import {
  drainEvents, createFirm, createPersonClient, ownerOf, testPool,
  type Actor, type Firm, type ClientRecord,
} from "../../support/setupInProcess";

let firm: Firm; let owner: Actor; let client: ClientRecord;
beforeEach(async () => {
  firm = await createFirm(); owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: "C" }); await drainEvents();
});

it("prices a 0.3 h overage at 123.45 as 3704 cents on the draft invoice", async () => {
  const T = `/api/lawfirms/${firm.id}/billing/time-entries`;
  const t = await owner.api.post(T).send({ clientId: client.id, userId: owner.uid, hours: 2.3, date: "2026-03-10", hourlyRate: 123.45, description: "W" });
  expect(t.status).toBe(201);
  const P = `/api/lawfirms/${firm.id}/billing/plans`;
  const plan = await owner.api.post(P).send({ contextType: "client", entityId: client.id, name: "Retainer", intervalUnit: "month", startDate: "2026-03-01", amount: 500, includedHours: 2 });
  expect(plan.status).toBe(201);
  const draft = await owner.api.post(`${P}/${plan.body.plan.id}/periods/2026-03-01/create-draft`).send({});
  expect(draft.status).toBe(201);
  const line = (await testPool.query("select amount_cents::int c from invoice_line_items where invoice_id = $1 and kind = 'time_entry'", [draft.body.invoice.id])).rows[0];
  expect(line.c).toBe(3704);
});
