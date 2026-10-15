import { buildExistingEventsPayload } from "@/lib/utils/existingEventsSyncPayload";
import type { MatterEvent } from "@/types/matterEvent";
import type { ClientEvent } from "@/types/clientEvent";

const FIRM = "firm-1";

function matterEvent(overrides: Partial<MatterEvent> = {}): MatterEvent {
  return {
    id: "me-1",
    type: "hearing",
    title: "Motion hearing",
    date: "2026-09-10T14:00:00.000Z",
    status: "scheduled",
    matterId: "matter-1",
    lawFirmId: FIRM,
    createdBy: "u-1",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  } as MatterEvent;
}

function clientEvent(overrides: Partial<ClientEvent> = {}): ClientEvent {
  return {
    id: "ce-1",
    type: "meeting",
    title: "Client check-in",
    date: "2026-09-02T17:00:00.000Z",
    status: "scheduled",
    source: "client",
    clientId: "client-1",
    lawFirmId: FIRM,
    createdBy: "u-1",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  } as ClientEvent;
}

describe("buildExistingEventsPayload", () => {
  test("names a matter event by its matter and a client event by its client", () => {
    const payload = buildExistingEventsPayload(FIRM, [matterEvent()], [clientEvent()], "googleEventId");

    expect(payload).toEqual([
      {
        eventId: "me-1", matterId: "matter-1", lawFirmId: FIRM, title: "Motion hearing",
        notes: null, location: null, date: "2026-09-10T14:00:00.000Z", type: "hearing",
      },
      {
        eventId: "ce-1", clientId: "client-1", lawFirmId: FIRM, title: "Client check-in",
        notes: null, location: null, date: "2026-09-02T17:00:00.000Z", type: "meeting",
      },
    ]);
  });

  test("leaves out events with no date", () => {
    const payload = buildExistingEventsPayload(
      FIRM, [matterEvent({ date: null })], [clientEvent({ date: null })], "googleEventId",
    );
    expect(payload).toEqual([]);
  });

  test("leaves out a matter event already carrying this provider's id, and only this provider's", () => {
    const synced = matterEvent({ googleEventId: "g-1" });
    expect(buildExistingEventsPayload(FIRM, [synced], [], "googleEventId")).toEqual([]);
    expect(buildExistingEventsPayload(FIRM, [synced], [], "outlookId")).toHaveLength(1);
  });

  test("leaves out a client-list row that is really a matter event", () => {
    const payload = buildExistingEventsPayload(
      FIRM, [], [clientEvent({ source: "matter", matterId: "matter-1" })], "outlookId",
    );
    expect(payload).toEqual([]);
  });
});
