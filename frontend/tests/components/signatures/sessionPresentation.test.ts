import {
  participantStatusMeta,
  sentPhrase,
  sessionStatusMeta,
  sessionSummaryLine,
} from "@/components/signaturesComp/sessionPresentation";
import type { SigningSession } from "@/types/signature";

const daysAgo = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
};

const buildSession = (overrides: Partial<SigningSession> = {}): SigningSession => ({
  token: "token-1",
  fileName: "Engagement Letter.pdf",
  status: "pending",
  signerName: "Jane Smith",
  recipientEmail: "jane@example.com",
  createdAt: daysAgo(3),
  completedAt: null,
  routingMode: "sequential",
  totalParticipants: 1,
  completedParticipants: 0,
  ...overrides,
});

describe("sentPhrase", () => {
  it("lowercases relative labels so they read as part of the sentence", () => {
    expect(sentPhrase(daysAgo(0))).toBe("Sent today");
    expect(sentPhrase(daysAgo(1))).toBe("Sent yesterday");
    expect(sentPhrase(daysAgo(3))).toBe("Sent 3 days ago");
  });

  it("leaves the month name capitalised on an absolute date", () => {
    // The bug this guards: lowercasing the whole formatted date produced
    // "Sent may 5, 2026".
    expect(sentPhrase("2026-05-05T12:00:00.000Z")).toMatch(/^Sent [A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  });

  it("degrades to the bare verb with no date", () => {
    expect(sentPhrase(null)).toBe("Sent");
  });
});

describe("sessionSummaryLine", () => {
  it("leads with who a sequential session is waiting on", () => {
    const line = sessionSummaryLine(buildSession({
      status: "in_progress",
      totalParticipants: 3,
      completedParticipants: 1,
      currentSignerName: "Robert Johnson",
      currentSignerRole: "Witness",
    }));

    expect(line).toBe("Waiting on Robert Johnson (Witness) · Sent 3 days ago");
  });

  it("counts the outstanding signers on a parallel session", () => {
    const line = sessionSummaryLine(buildSession({
      status: "in_progress",
      routingMode: "parallel",
      totalParticipants: 3,
      completedParticipants: 1,
    }));

    expect(line).toBe("Waiting on 2 of 3 signers · Sent 3 days ago");
  });

  it("falls back to the single signer's name when there is no current signer", () => {
    expect(sessionSummaryLine(buildSession())).toBe("Waiting on Jane Smith · Sent 3 days ago");
  });

  it("reports who signed once a session is complete", () => {
    expect(sessionSummaryLine(buildSession({
      status: "completed",
      completedParticipants: 1,
      completedAt: daysAgo(1),
    }))).toBe("Signed by Jane Smith · Yesterday");

    expect(sessionSummaryLine(buildSession({
      status: "completed",
      totalParticipants: 3,
      completedParticipants: 3,
      completedAt: daysAgo(1),
    }))).toBe("Signed by all 3 signers · Yesterday");
  });

  it("reports how far a stopped session got instead of who it is waiting on", () => {
    const line = sessionSummaryLine(buildSession({
      status: "cancelled",
      totalParticipants: 3,
      completedParticipants: 2,
    }));

    // Nobody is waiting on a voided session, so naming a signer would be wrong.
    expect(line).toBe("Sent 3 days ago · 2 of 3 signed");
    expect(line).not.toMatch(/waiting/i);
  });
});

describe("sessionStatusMeta", () => {
  it("calls a cancelled session voided, matching the action that produced it", () => {
    expect(sessionStatusMeta("cancelled").label).toBe("Voided");
  });

  it("falls back to pending for a status it doesn't know", () => {
    expect(sessionStatusMeta("something_new").label).toBe("Pending");
  });
});

describe("participantStatusMeta", () => {
  it("distinguishes the signer whose turn it is from one still queued", () => {
    expect(participantStatusMeta("active").label).toBe("Awaiting");
    expect(participantStatusMeta("waiting").label).toBe("Queued");
    expect(participantStatusMeta("completed").label).toBe("Signed");
  });
});
