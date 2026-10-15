import React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen, within } from "@testing-library/react";

const mockNavigate = jest.fn();

jest.mock("@/contexts/NavigationContext", () => ({
  __esModule: true,
  useNavigation: () => ({ navigate: mockNavigate, isNavigating: false }),
}));

import SigningSessionRow from "@/components/signaturesComp/SigningSessionRow";
import type { SigningParticipantSummary, SigningSession } from "@/types/signature";

const buildSigner = (overrides: Partial<SigningParticipantSummary> = {}): SigningParticipantSummary => ({
  participantId: "participant-1",
  roleLabel: "Client",
  name: "Jane Smith",
  email: "jane@example.com",
  status: "active",
  order: 1,
  deliveryMethod: "email",
  ...overrides,
});

const buildSession = (overrides: Partial<SigningSession> = {}): SigningSession => ({
  token: "token-1",
  sessionToken: "token-1",
  fileName: "Settlement Agreement.pdf",
  status: "in_progress",
  signerName: "Jane Smith",
  recipientEmail: "jane@example.com",
  createdAt: new Date().toISOString(),
  completedAt: null,
  routingMode: "sequential",
  totalParticipants: 3,
  completedParticipants: 1,
  ...overrides,
});

function renderRow(session: SigningSession, overrides: Record<string, any> = {}, { canSend = true }: { canSend?: boolean } = {}) {
  const handlers = {
    onSignNow: jest.fn(),
    onPreview: jest.fn(),
    onDownloadDocument: jest.fn(),
    onVoid: jest.fn(),
    onRemind: jest.fn(),
    ...overrides,
  };

  render(
    <SigningSessionRow
      session={session}
      lawFirmId="law-firm-1"
      canOpenDestination
      canSend={canSend}
      remindCooldowns={{}}
      downloadingDocument={false}
      voiding={false}
      {...(handlers as any)}
    />
  );

  return handlers;
}

/** The row's disclosure control, named after the document it opens. */
const disclosureFor = (fileName: string) =>
  screen.getByRole("button", { name: new RegExp(fileName.replace(".", "\\.")) });

/**
 * The always-visible strip of the row.
 *
 * The disclosure panel stays mounted while collapsed (see the component), and
 * jsdom does not implement `inert`, so an unscoped query would also match the
 * controls inside it — which a real browser keeps out of the accessibility tree.
 */
const rowHeader = (fileName = "Settlement Agreement.pdf") =>
  within(disclosureFor(fileName).parentElement!);

describe("SigningSessionRow", () => {
  beforeEach(() => mockNavigate.mockClear());

  it("summarises a multi-signer session's progress without expanding it", () => {
    renderRow(buildSession({
      signers: [
        buildSigner({ participantId: "p1", name: "Jane Smith", status: "completed", order: 1 }),
        buildSigner({ participantId: "p2", name: "Robert Johnson", roleLabel: "Witness", status: "active", order: 2 }),
        buildSigner({ participantId: "p3", name: "Maria Garcia", roleLabel: "Counsel", status: "waiting", order: 3 }),
      ],
      currentSignerName: "Robert Johnson",
      currentSignerRole: "Witness",
    }));

    expect(screen.getByText("1/3 signed")).toBeInTheDocument();
    expect(screen.getByText(/Waiting on Robert Johnson \(Witness\)/)).toBeInTheDocument();
  });

  it("keeps the signer track collapsed until the row is opened", async () => {
    const user = userEvent.setup();

    renderRow(buildSession({
      signers: [
        buildSigner({ participantId: "p1", name: "Jane Smith", status: "completed", order: 1 }),
        buildSigner({ participantId: "p2", name: "Robert Johnson", status: "active", order: 2 }),
      ],
      totalParticipants: 2,
    }));

    const disclosure = disclosureFor("Settlement Agreement.pdf");
    const panel = document.getElementById(disclosure.getAttribute("aria-controls")!)!;

    // The panel is mounted for the transition, so "collapsed" is inert rather
    // than absent — which is what keeps Tab out of it.
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(panel).toHaveAttribute("inert");

    await user.click(disclosure);

    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(panel).not.toHaveAttribute("inert");
    // Per-signer status, in signing order. Scoped to the track because the detail
    // grid below it also has a "Signed" caption.
    const track = within(panel).getAllByRole("listitem");
    expect(within(track[0]).getByText("Jane Smith")).toBeInTheDocument();
    expect(within(track[0]).getByText("Signed")).toBeInTheDocument();
    expect(within(track[1]).getByText("Robert Johnson")).toBeInTheDocument();
    expect(within(track[1]).getByText("Awaiting")).toBeInTheDocument();
  });

  it("marks the signed-in user's own row in the signer track, and only there", async () => {
    const user = userEvent.setup();

    renderRow(buildSession({
      signers: [
        buildSigner({ participantId: "p1", name: "Jane Smith", status: "completed", order: 1 }),
        buildSigner({ participantId: "p2", name: "Alex Sule", roleLabel: "Attorney", status: "active", order: 2, isCurrentUser: true }),
      ],
      totalParticipants: 2,
      currentSignerName: "Alex Sule",
    }));

    // Not on the collapsed row — the marker belongs to the signer track alone.
    expect(rowHeader().queryByText("(You)")).not.toBeInTheDocument();

    await user.click(disclosureFor("Settlement Agreement.pdf"));

    const track = screen.getAllByRole("listitem");
    expect(within(track[0]).queryByText("(You)")).not.toBeInTheDocument();
    expect(within(track[1]).getByText("(You)")).toBeInTheDocument();
  });

  it("offers a one-click reminder only when a single signer is holding it up", () => {
    const single = renderRow(buildSession({
      signers: [
        buildSigner({ participantId: "p1", status: "completed", order: 1 }),
        buildSigner({ participantId: "p2", name: "Robert Johnson", status: "active", order: 2 }),
        buildSigner({ participantId: "p3", name: "Maria Garcia", status: "waiting", order: 3 }),
      ],
    }));

    rowHeader().getByRole("button", { name: "Remind Robert Johnson" }).click();
    expect(single.onRemind).toHaveBeenCalledWith(expect.objectContaining({ participantId: "p2" }));
  });

  it("hides Remind for a viewer without signatures.send, even with a single signer holding it up", () => {
    renderRow(
      buildSession({
        signers: [
          buildSigner({ participantId: "p1", status: "completed", order: 1 }),
          buildSigner({ participantId: "p2", name: "Robert Johnson", status: "active", order: 2 }),
        ],
      }),
      {},
      { canSend: false },
    );

    expect(rowHeader().queryByRole("button", { name: "Remind Robert Johnson" })).not.toBeInTheDocument();
  });

  it("leaves the choice of who to remind to the signer track when several are awaiting", () => {
    renderRow(buildSession({
      routingMode: "parallel",
      signers: [
        buildSigner({ participantId: "p1", name: "Jane Smith", status: "active", order: 1 }),
        buildSigner({ participantId: "p2", name: "Robert Johnson", status: "active", order: 2 }),
        buildSigner({ participantId: "p3", name: "Maria Garcia", status: "active", order: 3 }),
      ],
      completedParticipants: 0,
    }));

    // A row-level "Remind" would have to pick one of them silently.
    expect(rowHeader().queryByRole("button", { name: /^Remind / })).not.toBeInTheDocument();
  });

  it("puts signing first for the member whose signature is being waited on", () => {
    const handlers = renderRow(buildSession({
      readyForCurrentUser: true,
      currentUserSigningToken: "participant-token",
      signers: [buildSigner({ status: "active" })],
      totalParticipants: 1,
      completedParticipants: 0,
    }));

    rowHeader().getByRole("button", { name: "Sign now" }).click();
    expect(handlers.onSignNow).toHaveBeenCalledWith("participant-token");
  });

  it("does not offer to void a session that has already finished", () => {
    renderRow(buildSession({
      status: "completed",
      completedAt: new Date().toISOString(),
      completedParticipants: 3,
      signers: [buildSigner({ status: "completed" })],
    }));

    expect(rowHeader().getByRole("button", { name: "View signed document" })).toBeInTheDocument();
    expect(rowHeader().queryByRole("button", { name: /^Remind / })).not.toBeInTheDocument();
  });
});
