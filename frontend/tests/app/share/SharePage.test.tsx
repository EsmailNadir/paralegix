/**
 * The public share-link landing page. "View file" used to navigate the whole
 * tab away to the raw storage url (`window.location.href = data.url`),
 * bypassing the in-app preview popup every other file-view affordance uses.
 */
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "../../setup";
import { setupApiMock } from "../../support/apiMock";

jest.mock("next/navigation", () => ({
  useParams: () => ({ token: "shr_test" }),
}));

import SharePage from "@/app/share/[token]/page";

const api = setupApiMock();

describe("viewing a shared file", () => {
  it("opens the in-app preview popup instead of navigating away", async () => {
    api.get("/share/shr_test", {
      displayName: "photo.png",
      permission: "view",
      requiresPassword: false,
      expiresAt: null,
      contentType: "image/png",
    });
    api.post("/share/shr_test/download", {
      url: "https://example.test/photo.png",
      contentType: "image/png",
      displayName: "photo.png",
    });

    render(React.createElement(SharePage));

    fireEvent.click(await screen.findByRole("button", { name: "View file" }));

    // The popup renders the image inline and repeats the file's name in its own
    // header, alongside the page's own heading; a same-tab navigation away would
    // produce neither.
    const img = await screen.findByAltText("photo.png");
    expect(img).toHaveAttribute("src", "https://example.test/photo.png");
    expect(screen.getAllByText("photo.png")).toHaveLength(2);
  });

  it("exposes the popup as a real dialog and closes it on Escape", async () => {
    api.get("/share/shr_test", {
      displayName: "photo.png",
      permission: "view",
      requiresPassword: false,
      expiresAt: null,
      contentType: "image/png",
    });
    api.post("/share/shr_test/download", {
      url: "https://example.test/photo.png",
      contentType: "image/png",
      displayName: "photo.png",
    });

    render(React.createElement(SharePage));

    fireEvent.click(await screen.findByRole("button", { name: "View file" }));

    // A raw `fixed inset-0` div with no role, no aria-modal and no keyboard
    // handling used to back this popup - a screen reader had no way to tell it
    // was a dialog, and Escape did nothing.
    const dialog = await screen.findByRole("dialog", { name: "photo.png" });
    expect(dialog).toHaveAttribute("aria-modal", "true");

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("a link to several files and folders", () => {
  const META = {
    isMultiItem: true,
    displayName: "2 items",
    permission: "download",
    requiresPassword: false,
    expiresAt: null,
    contentType: null,
  };
  const TOP = {
    folder: null,
    path: [],
    items: [
      { id: "d1", name: "Discovery", isFolder: true, sizeBytes: null, contentType: null },
      { id: "f1", name: "Engagement Letter.pdf", isFolder: false, sizeBytes: 2048, contentType: "application/pdf" },
    ],
  };
  const DISCOVERY = {
    folder: { id: "d1", name: "Discovery" },
    path: [{ id: "d1", name: "Discovery" }],
    items: [
      { id: "f2", name: "Interrogatories.pdf", isFolder: false, sizeBytes: 1024, contentType: "application/pdf" },
    ],
  };

  it("lists the shared items and opens a folder", async () => {
    api.get("/share/shr_test", META);
    api.post("/share/shr_test/items", (call) => {
      const body = call.body as { folderId?: string };
      return body.folderId === "d1" ? DISCOVERY : TOP;
    });

    render(React.createElement(SharePage));

    expect(await screen.findByText("Engagement Letter.pdf")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Discovery" }));

    expect(await screen.findByText("Interrogatories.pdf")).toBeInTheDocument();
    expect(screen.queryByText("Engagement Letter.pdf")).not.toBeInTheDocument();
    const calls = api.callsTo("/share/shr_test/items");
    expect(calls[calls.length - 1].body).toMatchObject({ folderId: "d1" });
  });

  it("downloads the file that was clicked, by id", async () => {
    api.get("/share/shr_test", META);
    api.post("/share/shr_test/items", TOP);
    api.post("/share/shr_test/download", { url: "https://example.test/letter.pdf", contentType: "application/pdf" });

    render(React.createElement(SharePage));

    fireEvent.click(await screen.findByRole("button", { name: "Download Engagement Letter.pdf" }));

    // A multi-item link serves nothing without a file id, so the id is the
    // whole request.
    await waitFor(() => expect(api.callsTo("/share/shr_test/download")).toHaveLength(1));
    expect(api.callsTo("/share/shr_test/download")[0].body).toMatchObject({ fileId: "f1" });
  });

  it("previews a file from a download link without downloading it", async () => {
    api.get("/share/shr_test", META);
    api.post("/share/shr_test/items", {
      ...TOP,
      items: [{ id: "f3", name: "photo.png", isFolder: false, sizeBytes: 512, contentType: "image/png" }],
    });
    api.post("/share/shr_test/download", { url: "https://example.test/photo.png", contentType: "image/png" });

    render(React.createElement(SharePage));

    // A download link offers both; the view opens the in-app preview in place.
    expect(await screen.findByRole("button", { name: "Download photo.png" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View photo.png" }));

    const img = await screen.findByAltText("photo.png");
    expect(img).toHaveAttribute("src", "https://example.test/photo.png");
    expect(api.callsTo("/share/shr_test/download")[0].body).toMatchObject({ fileId: "f3" });
  });

  it("offers a download inside the preview of a download link", async () => {
    api.get("/share/shr_test", META);
    api.post("/share/shr_test/items", {
      ...TOP,
      items: [{ id: "f3", name: "photo.png", isFolder: false, sizeBytes: 512, contentType: "image/png" }],
    });
    api.post("/share/shr_test/download", { url: "https://example.test/photo.png", contentType: "image/png" });

    render(React.createElement(SharePage));

    fireEvent.click(await screen.findByRole("button", { name: "View photo.png" }));
    const dialog = await screen.findByRole("dialog", { name: "photo.png" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Download/ }));

    // A second request for the same file: the download asks for its own url
    // rather than reusing the preview's, which may have lapsed while reading.
    await waitFor(() => expect(api.callsTo("/share/shr_test/download")).toHaveLength(2));
    expect(api.callsTo("/share/shr_test/download")[1].body).toMatchObject({ fileId: "f3" });
  });

  it("offers no download inside the preview of a view-only link", async () => {
    api.get("/share/shr_test", { ...META, permission: "view" });
    api.post("/share/shr_test/items", {
      ...TOP,
      items: [{ id: "f3", name: "photo.png", isFolder: false, sizeBytes: 512, contentType: "image/png" }],
    });
    api.post("/share/shr_test/download", { url: "https://example.test/photo.png", contentType: "image/png" });

    render(React.createElement(SharePage));

    fireEvent.click(await screen.findByRole("button", { name: "View photo.png" }));
    const dialog = await screen.findByRole("dialog", { name: "photo.png" });

    // The preview did open (the image is there), so the missing button is the permission.
    expect(within(dialog).getByAltText("photo.png")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Download/ })).not.toBeInTheDocument();
  });

  it("offers only a view on a view-only link", async () => {
    api.get("/share/shr_test", { ...META, permission: "view" });
    api.post("/share/shr_test/items", TOP);

    render(React.createElement(SharePage));

    expect(await screen.findByRole("button", { name: "View Engagement Letter.pdf" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download Engagement Letter.pdf" })).not.toBeInTheDocument();
  });

  it("asks for the password before listing anything, then sends it with every request", async () => {
    api.get("/share/shr_test", { ...META, requiresPassword: true });
    api.post("/share/shr_test/items", (call) => {
      const body = call.body as { password?: string };
      return body.password === "correct horse"
        ? TOP
        : { status: 401, body: { code: "SHARE_LINK_PASSWORD", error: "Incorrect password" } };
    });
    api.post("/share/shr_test/download", { url: "https://example.test/letter.pdf", contentType: "application/pdf" });

    render(React.createElement(SharePage));

    const field = await screen.findByLabelText(/Password/);
    expect(api.callsTo("/share/shr_test/items")).toHaveLength(0);
    fireEvent.change(field, { target: { value: "wrong horse" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Incorrect password. Please try again.")).toBeInTheDocument();
    expect(screen.queryByText("Engagement Letter.pdf")).not.toBeInTheDocument();

    fireEvent.change(field, { target: { value: "correct horse" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Download Engagement Letter.pdf" }));

    await waitFor(() => expect(api.callsTo("/share/shr_test/download")).toHaveLength(1));
    expect(api.callsTo("/share/shr_test/download")[0].body).toMatchObject({
      fileId: "f1",
      password: "correct horse",
    });
  });
});

/**
 * Moving on before a folder has loaded. The breadcrumb stays clickable while a
 * folder is on its way, so a recipient can leave for "All items" first.
 *
 * WHAT BREAKS THIS: writing a folder listing without checking it is still the
 * one asked for last, which drops the recipient back into the folder they left.
 */
describe("a folder answer that arrives after the recipient moved on", () => {
  it("stays where the recipient went last", async () => {
    const META = {
      isMultiItem: true,
      displayName: "2 items",
      permission: "download",
      requiresPassword: false,
      expiresAt: null,
      contentType: null,
    };
    const TOP = {
      folder: null,
      path: [],
      items: [
        { id: "d1", name: "Discovery", isFolder: true, sizeBytes: null, contentType: null },
        { id: "f1", name: "Engagement Letter.pdf", isFolder: false, sizeBytes: 2048, contentType: "application/pdf" },
      ],
    };
    const DISCOVERY = {
      folder: { id: "d1", name: "Discovery" },
      path: [{ id: "d1", name: "Discovery" }],
      items: [{ id: "d2", name: "Depositions", isFolder: true, sizeBytes: null, contentType: null }],
    };
    const DEPOSITIONS = {
      folder: { id: "d2", name: "Depositions" },
      path: [{ id: "d1", name: "Discovery" }, { id: "d2", name: "Depositions" }],
      items: [{ id: "f9", name: "Witness transcript.pdf", isFolder: false, sizeBytes: 10, contentType: "application/pdf" }],
    };
    let releaseDepositions: ((body: unknown) => void) | undefined;
    api.get("/share/shr_test", META);
    api.post("/share/shr_test/items", (call) => {
      const { folderId } = call.body as { folderId?: string };
      if (folderId === "d2") return new Promise((resolve) => { releaseDepositions = resolve; });
      return folderId === "d1" ? DISCOVERY : TOP;
    });

    render(React.createElement(SharePage));

    fireEvent.click(await screen.findByRole("button", { name: "Open Discovery" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open Depositions" }));
    await waitFor(() => expect(releaseDepositions).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: "All items" }));
    expect(await screen.findByText("Engagement Letter.pdf")).toBeInTheDocument();

    releaseDepositions?.(DEPOSITIONS);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.getByText("Engagement Letter.pdf")).toBeInTheDocument();
    expect(screen.queryByText("Witness transcript.pdf")).not.toBeInTheDocument();
  });
});

it.each([false, true])('associates and focuses password errors before a corrected share opens (multiple=%s)', async isMultiItem => {
  api.get('/share/shr_test', { isMultiItem, displayName: 'Protected file', permission: 'view', requiresPassword: true, expiresAt: null, contentType: 'image/png' });
  api.post(isMultiItem ? '/share/shr_test/items' : '/share/shr_test/download', (call) => {
    if ((call.body as { password: string }).password !== 'correct') return { status: 401, body: { code: 'SHARE_LINK_PASSWORD' } };
    return isMultiItem
      ? { folder: null, path: [], items: [{ id: 'file-a', name: 'Private.png', isFolder: false, contentType: 'image/png', sizeBytes: 111 }] }
      : { url: 'https://example.test/private.png', contentType: 'image/png' };
  });
  render(<SharePage />);
  const password = await screen.findByLabelText('Password *');
  fireEvent.change(password, { target: { value: 'wrong' } });
  fireEvent.click(screen.getByRole('button', { name: isMultiItem ? 'Continue' : 'View file' }));
  await screen.findByRole('alert');
  expect(password).toHaveAttribute('aria-invalid', 'true');
  expect(password).toHaveAccessibleDescription('Incorrect password. Please try again.');
  expect(password).toHaveFocus();
  fireEvent.change(password, { target: { value: 'correct' } });
  fireEvent.keyDown(password, { key: 'Enter' });
  if (isMultiItem) expect(await screen.findByText('Private.png')).toBeInTheDocument();
  else expect(await screen.findByRole('dialog', { name: 'Protected file' })).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('focuses the expired result when a share expires during an open request', async () => {
  api.get('/share/shr_test', { displayName: 'Expiring file', permission: 'view', requiresPassword: false, expiresAt: null, contentType: 'image/png' });
  api.post('/share/shr_test/download', { status: 410, body: {} });
  render(<SharePage />);
  fireEvent.click(await screen.findByRole('button', { name: 'View file' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Link expired' })).toHaveFocus());
  expect(screen.queryByRole('button', { name: 'View file' })).not.toBeInTheDocument();
});
