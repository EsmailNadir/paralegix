/**
 * A time entry's hourlyRate override must be whole cents.
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

it.each([10.999, 0.005, 33.333])('refuses an hourlyRate of %p', async (rate) => {
  const res = await owner.api.post(`/api/lawfirms/${firm.id}/billing/time-entries`).send({
    context: "client", clientId: client.id, userId: owner.uid, hours: 1, date: "2026-03-10", hourlyRate: rate,
  });
  expect(res.status).toBe(400);
  void randomUUID; void testPool;
});
