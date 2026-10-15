import React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor, within } from "@testing-library/react";

import NeedsSignatureBanner from "@/components/signaturesComp/NeedsSignatureBanner";
import type { NeedsMySignatureDocument } from "@/hooks/signatureHooks/useSigningNeedsMySignature";

const buildDocs = (count: number): NeedsMySignatureDocument[] =>
  Array.from({ length: count }, (_, i) => ({
    sessionToken: `token-${i + 1}`,
    fileName: `Engagement Letter ${i + 1}.pdf`,
    createdAt: new Date().toISOString(),
    participantRole: "Attorney",
    publicToken: `public-${i + 1}`,
    totalParticipants: 2,
    completedParticipants: 1,
  }));

/** The inline banner list, excluding anything rendered into the dialog. */
const bannerList = () => within(screen.getByRole("heading", { level: 2 }).closest("div")!);

describe("NeedsSignatureBanner", () => {
  it("renders nothing when there is nothing to sign", () => {
    const { container } = render(<NeedsSignatureBanner documents={[]} onSign={jest.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists every document inline, with no overflow control, at three or fewer", () => {
    render(<NeedsSignatureBanner documents={buildDocs(3)} onSign={jest.fn()} />);

    expect(screen.getByText("3 documents need your signature")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Sign$/ })).toHaveLength(3);
    // A "see all" here would open a dialog onto the same three rows.
    expect(screen.queryByRole("button", { name: /more/ })).not.toBeInTheDocument();
  });

  it("holds the rest back behind a count once there are more than three", () => {
    render(<NeedsSignatureBanner documents={buildDocs(4)} onSign={jest.fn()} />);

    expect(screen.getByText("4 documents need your signature")).toBeInTheDocument();
    expect(bannerList().getAllByRole("button", { name: /^Sign$/ })).toHaveLength(3);
    expect(screen.getByRole("button", { name: /and 1 more/ })).toBeInTheDocument();
  });

  it("keeps the banner a fixed size and the whole set reachable when there are a lot", async () => {
    const user = userEvent.setup();
    const onSign = jest.fn();
    render(<NeedsSignatureBanner documents={buildDocs(40)} onSign={onSign} />);

    // However many arrive, the banner itself stays three rows tall.
    expect(screen.getByText("40 documents need your signature")).toBeInTheDocument();
    expect(bannerList().getAllByRole("button", { name: /^Sign$/ })).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: /and 37 more/ }));

    const dialog = screen.getByRole("dialog");
    // Exact, not a loose regex: an `&apos;` next to an interpolation used to eat
    // the space here and a `.*` match happily passed over it.
    expect(within(dialog).getByText("40 documents you've been added to as a signer.")).toBeInTheDocument();
    // All 40 are reachable, and the list scrolls rather than growing the dialog
    // past the viewport.
    expect(within(dialog).getAllByRole("button", { name: /^Sign$/ })).toHaveLength(40);
    expect(within(dialog).getByRole("list")).toHaveClass("overflow-y-auto");
    expect(dialog.className).toMatch(/max-h-\[90vh\]/);

    // The last document is present, not truncated away.
    expect(within(dialog).getByText("Engagement Letter 40.pdf")).toBeInTheDocument();
  });

  it("signs with the participant's own link, not the session token", async () => {
    const user = userEvent.setup();
    const onSign = jest.fn();
    render(<NeedsSignatureBanner documents={buildDocs(1)} onSign={onSign} />);

    await user.click(screen.getByRole("button", { name: /^Sign$/ }));
    expect(onSign).toHaveBeenCalledWith("public-1");
  });

  it("closes the dialog on Escape", async () => {
    const user = userEvent.setup();
    render(<NeedsSignatureBanner documents={buildDocs(10)} onSign={jest.fn()} />);

    await user.click(screen.getByRole("button", { name: /and 7 more/ }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
