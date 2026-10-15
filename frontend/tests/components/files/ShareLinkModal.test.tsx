/**
 * The share-link modal, opened on one item or on a selection.
 *
 * One item keeps the original request shape. A selection sends every selected
 * id in one request, so the recipient gets ONE link, not one per item. Either
 * way the dialog lists the live links on what it was opened for, and each says
 * what else it reaches, so revoking one never cuts off something unannounced.
 *
 * What has to break for these to go red: a selection's links not being looked
 * up, a link's other items not being named (or a link to only this item being
 * given a line anyway), the hover list missing any name (shown, folded or cut
 * off) or the count of items behind a wall, or a link that reaches further being revoked
 * without the confirmation that names what it cuts off.
 */
jest.unmock("@/services/files.service");

import React from "react";
import userEvent from "@testing-library/user-event";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installApiMock, type ApiMock } from "../../support/apiMock";
import { holdResponse } from "../../support/deferred";

import ShareLinkModal from "@/components/filesComp/ShareLinkModal";

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  api.restore();
});

const LINK = {
  token: "tok1",
  fileId: null,
  isMultiItem: true,
  displayName: "2 items",
  permission: "download",
  hasPassword: false,
  expiresAt: "2026-10-01T00:00:00.000Z",
  accessCount: 0,
  url: "https://app.test/share/tok1",
  items: [
    { fileId: "d1", name: "Discovery", isFolder: true },
    { fileId: "f1", name: "Engagement Letter.pdf", isFolder: false },
  ],
  hiddenItemCount: 0,
};

/** A link to one document and nothing else. */
const ONLY_F1 = {
  ...LINK,
  token: "tok2",
  fileId: "f1",
  isMultiItem: false,
  displayName: "Engagement Letter.pdf",
  url: "https://app.test/share/tok2",
  items: [{ fileId: "f1", name: "Engagement Letter.pdf", isFolder: false }],
};

const ENGAGEMENT = { fileId: "f1", name: "Engagement Letter.pdf", isFolder: false };

function renderModal(items: Array<{ fileId: string; name: string; isFolder: boolean }>) {
  return render(
    React.createElement(ShareLinkModal, { open: true, onClose: jest.fn(), lawFirmId: "firm1", items }),
  );
}

describe("sharing a selection", () => {
  it("creates one link naming every selected item", async () => {
    const user = userEvent.setup();
    api.get("/file-share-links", { links: [] });
    api.post("/file-share-links", { link: LINK });
    renderModal([
      { fileId: "d1", name: "Discovery", isFolder: true },
      { fileId: "f1", name: "Engagement Letter.pdf", isFolder: false },
    ]);

    expect(screen.getByText("2 items")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create link" }));

    await waitFor(() => expect(api.calls("POST")).toHaveLength(1));
    const [call] = api.calls("POST");
    expect(call.body).toMatchObject({ fileIds: ["d1", "f1"] });
    expect(await screen.findByDisplayValue("https://app.test/share/tok1")).toBeInTheDocument();
  });

  it("lists the links on any selected item, each naming everything it shares", async () => {
    api.get("/file-share-links", { links: [LINK, ONLY_F1] });
    renderModal([
      { fileId: "d1", name: "Discovery", isFolder: true },
      { fileId: "f1", name: "Engagement Letter.pdf", isFolder: false },
    ]);

    // A link may cover only some of the selection, so each says all it holds.
    expect(await screen.findByText("Shares Discovery, Engagement Letter.pdf")).toBeInTheDocument();
    expect(screen.getByText("Shares Engagement Letter.pdf")).toBeInTheDocument();
    expect(api.calls("GET")[0].query.fileIds).toEqual(["d1,f1"]);
  });

  it("says when there are no links on the selection", async () => {
    api.get("/file-share-links", { links: [] });
    renderModal([
      { fileId: "d1", name: "Discovery", isFolder: true },
      { fileId: "f1", name: "Engagement Letter.pdf", isFolder: false },
    ]);

    expect(await screen.findByText("No active share links for these items.")).toBeInTheDocument();
  });
});

describe("sharing one item", () => {
  it("names what else a link shares, and gives a link to only this item no such line", async () => {
    api.get("/file-share-links", { links: [LINK, ONLY_F1] });
    renderModal([ENGAGEMENT]);

    // Found again from one of its items, the link says what else it reaches.
    expect(await screen.findByText("Also shares Discovery")).toBeInTheDocument();
    expect(screen.getAllByText(/shares/)).toHaveLength(1);
    expect(api.callsTo("/file-share-links")[0].query.fileId).toEqual(["f1"]);
  });

  it("folds names past the first two, and items behind a wall, into +N more", async () => {
    const user = userEvent.setup();
    api.get("/file-share-links", {
      links: [{
        ...LINK,
        items: [
          ENGAGEMENT,
          { fileId: "a", name: "Answer.pdf", isFolder: false },
          { fileId: "b", name: "Brief.pdf", isFolder: false },
          { fileId: "c", name: "Complaint.pdf", isFolder: false },
        ],
        hiddenItemCount: 2,
      }],
    });
    renderModal([ENGAGEMENT]);

    expect(await screen.findByText("Also shares Answer.pdf, Brief.pdf")).toBeInTheDocument();
    await user.hover(screen.getByText("+3 more"));

    // Everything the link also shares, not just what "+3 more" folded away:
    // the names before it are cut off when they are long.
    const list = await screen.findByRole("tooltip");
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Answer.pdf",
      "Brief.pdf",
      "Complaint.pdf",
      "2 items you can't access",
    ]);
  });

  it("lists every name on hover even with nothing folded into +N more", async () => {
    const user = userEvent.setup();
    api.get("/file-share-links", {
      links: [{
        ...LINK,
        items: [
          ENGAGEMENT,
          { fileId: "a", name: "A very long correspondence folder name that gets cut off", isFolder: true },
        ],
      }],
    });
    renderModal([ENGAGEMENT]);

    await user.hover(await screen.findByText(/^Also shares/));
    const list = await screen.findByRole("tooltip");
    expect(within(list).getByText("A very long correspondence folder name that gets cut off")).toBeInTheDocument();
  });

  it("counts, without naming, what a link holds behind a wall", async () => {
    api.get("/file-share-links", {
      links: [{ ...LINK, items: [ENGAGEMENT], hiddenItemCount: 1 }],
    });
    renderModal([ENGAGEMENT]);

    expect(await screen.findByText("Also shares 1 item you can't access")).toBeInTheDocument();
  });

  it("creates a link for a single folder with the original request shape", async () => {
    const user = userEvent.setup();
    api.get("/file-share-links", { links: [] });
    api.post("/file-share-links", { link: { ...LINK, displayName: "Discovery" } });
    renderModal([{ fileId: "d1", name: "Discovery", isFolder: true }]);

    await screen.findByText("No active share links for this folder.");
    await user.click(screen.getByRole("button", { name: "Create link" }));

    await waitFor(() => expect(api.calls("POST")).toHaveLength(1));
    const post = api.calls("POST")[0];
    expect(post.body).toMatchObject({ fileId: "d1" });
    expect((post.body as Record<string, unknown>).fileIds).toBeUndefined();
  });
});

describe("revoking a link", () => {
  it("revokes a link to only this item straight away", async () => {
    const user = userEvent.setup();
    api.get("/file-share-links", { links: [ONLY_F1] });
    api.delete("/file-share-links/tok2", { message: "Share link revoked", token: "tok2" });
    renderModal([ENGAGEMENT]);

    await user.click(await screen.findByRole("button", { name: /Revoke/ }));

    await waitFor(() => expect(api.calls("DELETE")).toHaveLength(1));
    expect(screen.queryByText("Revoke this link?")).not.toBeInTheDocument();
  });

  it("asks first when the link reaches more, naming what it cuts off", async () => {
    const user = userEvent.setup();
    api.get("/file-share-links", { links: [{ ...LINK, hiddenItemCount: 1 }] });
    api.delete("/file-share-links/tok1", { message: "Share link revoked", token: "tok1" });
    renderModal([ENGAGEMENT]);

    await user.click(await screen.findByRole("button", { name: /^Revoke$/ }));
    expect(await screen.findByText(
      "It also shares Discovery and 1 item you can't access. Anyone with the link loses access to all 3 items.",
    )).toBeInTheDocument();
    expect(api.calls("DELETE")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.calls("DELETE")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: /^Revoke$/ }));
    await user.click(await screen.findByRole("button", { name: "Revoke link" }));
    await waitFor(() => expect(api.calls("DELETE")).toHaveLength(1));
    expect(api.calls("DELETE")[0].url).toContain("/file-share-links/tok1");
  });
});

/**
 * Reopening the dialog on another item while the first item's links are still
 * on their way.
 *
 * WHAT BREAKS THESE: writing a links response without checking it is for the
 * item on screen now (the previous item's links replace this one's), or letting
 * an old response end the loading state (the empty message shows before this
 * item's links have arrived).
 */
describe("links for an item the dialog has moved on from", () => {
  const ALPHA = { fileId: "a", name: "Alpha.pdf", isFolder: false };
  const BETA = { fileId: "b", name: "Beta.pdf", isFolder: false };
  const linkOn = (item: typeof ALPHA, other: string) => ({
    ...LINK,
    token: `tok-${item.fileId}`,
    url: `https://app.test/share/tok-${item.fileId}`,
    items: [item, { fileId: `${item.fileId}-other`, name: other, isFolder: false }],
  });

  /** Holds each item's links request open until the spec answers it. */
  function deferLinks() {
    const pending = new Map<string, (body: unknown) => void>();
    api.get("/file-share-links", (call) => new Promise((resolve) => {
      pending.set(String(call.query.fileId?.[0]), resolve);
    }));
    return (fileId: string, links: unknown[]) => pending.get(fileId)?.({ links });
  }

  function renderOn(item: typeof ALPHA) {
    const props = { open: true, onClose: jest.fn(), lawFirmId: "firm1" };
    const view = render(React.createElement(ShareLinkModal, { ...props, items: [item] }));
    const reopenOn = (next: typeof ALPHA) => {
      view.rerender(React.createElement(ShareLinkModal, { ...props, open: false, items: [item] }));
      view.rerender(React.createElement(ShareLinkModal, { ...props, items: [next] }));
    };
    return reopenOn;
  }

  it("shows the open item's links even when the previous item's answer lands last", async () => {
    const answer = deferLinks();
    const reopenOn = renderOn(ALPHA);
    await waitFor(() => expect(api.callsTo("/file-share-links")).toHaveLength(1));

    reopenOn(BETA);
    await waitFor(() => expect(api.callsTo("/file-share-links")).toHaveLength(2));

    answer("b", [linkOn(BETA, "Beta sibling.pdf")]);
    expect(await screen.findByText("Also shares Beta sibling.pdf")).toBeInTheDocument();

    answer("a", [linkOn(ALPHA, "Alpha sibling.pdf")]);
    // Let the stale answer settle before looking for what it would have drawn.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.getByText("Also shares Beta sibling.pdf")).toBeInTheDocument();
    expect(screen.queryByText("Also shares Alpha sibling.pdf")).not.toBeInTheDocument();
  });

  it("keeps loading when the previous item's answer lands before the open item's", async () => {
    const answer = deferLinks();
    const reopenOn = renderOn(ALPHA);
    await waitFor(() => expect(api.callsTo("/file-share-links")).toHaveLength(1));

    reopenOn(BETA);
    await waitFor(() => expect(api.callsTo("/file-share-links")).toHaveLength(2));

    answer("a", [linkOn(ALPHA, "Alpha sibling.pdf")]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.getByText("Loading links…")).toBeInTheDocument();
    expect(screen.queryByText("Also shares Alpha sibling.pdf")).not.toBeInTheDocument();

    answer("b", []);
    expect(await screen.findByText("No active share links for this file.")).toBeInTheDocument();
  });
});

/**
 * Copy feedback belongs to the link that was copied.
 *
 * WHAT BREAKS THESE: one shared "copied" flag (copying a listed link flips the
 * new link's button and leaves the row itself unchanged), or an earlier copy's
 * timer clearing a later copy's feedback early.
 */
describe("copying a link", () => {
  const CREATED = LINK;
  const OTHER = ONLY_F1;

  /** The copy button beside the "ready" link's url field. */
  const readyButton = () =>
    within(screen.getByDisplayValue(CREATED.url).parentElement as HTMLElement).getByRole("button");
  const rowButton = (index: number) =>
    within(screen.getAllByRole("listitem")[index]).getByRole("button", { name: /Cop/ });

  async function createThenList(user: ReturnType<typeof userEvent.setup>) {
    api.get("/file-share-links", { links: [CREATED, OTHER] });
    api.post("/file-share-links", { link: CREATED });
    renderModal([ENGAGEMENT]);
    await screen.findAllByRole("listitem");
    await user.click(screen.getByRole("button", { name: "Create link" }));
    await screen.findByDisplayValue(CREATED.url);
  }

  it("marks the listed link that was copied, and not the new link's button", async () => {
    const user = userEvent.setup();
    await createThenList(user);

    await user.click(rowButton(1));

    await waitFor(() => expect(rowButton(1)).toHaveTextContent("Copied"));
    expect(readyButton()).toHaveTextContent("Copy");
    expect(readyButton()).not.toHaveTextContent("Copied");
    expect(rowButton(0)).not.toHaveTextContent("Copied");
    await expect(navigator.clipboard.readText()).resolves.toBe(OTHER.url);
  });

  it("keeps a second copy's feedback for its full time after an earlier copy", async () => {
    jest.useFakeTimers();
    try {
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      await createThenList(user);

      await user.click(rowButton(1));
      await waitFor(() => expect(rowButton(1)).toHaveTextContent("Copied"));

      act(() => { jest.advanceTimersByTime(1500); });
      await user.click(readyButton());
      await waitFor(() => expect(readyButton()).toHaveTextContent("Copied"));

      // Past the first copy's two seconds, inside the second's.
      act(() => { jest.advanceTimersByTime(1000); });
      expect(readyButton()).toHaveTextContent("Copied");

      act(() => { jest.advanceTimersByTime(1500); });
      expect(readyButton()).not.toHaveTextContent("Copied");
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("Escape while a link request is in flight", () => {
  // Red if: the dialog stays dismissible (or Done stays enabled) while the
  // create POST is pending, so Escape closes it and the new link's URL, which
  // is only ever shown here, is lost.
  it("keeps the dialog open while a link is being created", async () => {
    const user = userEvent.setup();
    api.get("/file-share-links", { links: [] });
    const post = holdResponse();
    api.post("/file-share-links", post.handler);
    const onClose = jest.fn();
    render(React.createElement(ShareLinkModal, { open: true, onClose, lawFirmId: "firm1", items: [ENGAGEMENT] }));

    await user.click(screen.getByRole("button", { name: "Create link" }));
    await post.untilRequested();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();

    await act(async () => post.release({ link: ONLY_F1 }));
    expect(await screen.findByDisplayValue("https://app.test/share/tok2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeEnabled();
    expect(onClose).not.toHaveBeenCalled();
  });

  // Red if: the dialog stays dismissible while the revoke DELETE is pending, so
  // a refused revoke reports into a closed dialog and the link stays live
  // without the user knowing.
  it("keeps the dialog open while a link is being revoked", async () => {
    const user = userEvent.setup();
    api.get("/file-share-links", { links: [ONLY_F1] });
    const del = holdResponse();
    api.delete("/file-share-links/tok2", del.handler);
    const onClose = jest.fn();
    render(React.createElement(ShareLinkModal, { open: true, onClose, lawFirmId: "firm1", items: [ENGAGEMENT] }));

    await user.click(await screen.findByRole("button", { name: /Revoke/ }));
    await del.untilRequested();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();

    await act(async () => del.release({ message: "Share link revoked", token: "tok2" }));
    expect(await screen.findByText("No active share links for this file.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeEnabled();
  });
});
