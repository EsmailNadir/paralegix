/**
 * The fill dialog tells the person when a filled overlay document has text
 * that did not print.
 *
 * The stamp falls back to a bundled font for names the template's own font
 * cannot draw, but no bundled font has CJK, Hebrew or Arabic. Those characters
 * print as "?". The document is still produced, so the dialog closes on
 * download, and the notice is a toast that outlives it.
 */
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "../../setup";

const mockUseQuery = jest.fn();
jest.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useQueries: () => [],
}));
jest.mock("@/components/templatesComp/SaveToFilesModal", () => ({ __esModule: true, default: () => null }));

const mockFill = jest.fn();
jest.mock("@/services/templates.service", () => ({
  __esModule: true,
  ...jest.requireActual("@/services/templates.service"),
  templatesService: {
    getById: jest.fn(),
    fillDocxTemplate: (...args: unknown[]) => mockFill(...args),
  },
}));

import FillTemplateModal from "@/components/templatesComp/FillTemplateModal";

const template = {
  id: "template-1",
  name: "Court Form",
  type: "overlay" as const,
  fields: [],
  repeaters: [],
  folderId: null,
  createdAt: "2026-04-09T00:00:00.000Z",
};

beforeEach(() => {
  mockFill.mockReset();
  mockUseQuery.mockImplementation(({ queryKey }: { queryKey: string[] }) => (
    queryKey[0] === "template-fill-detail"
      ? { data: { ...template, html: null, assets: [] }, isLoading: false }
      : { data: undefined, isLoading: false }
  ));
});

const download = async (incompleteFields: Array<{ fieldName: string; characters: string[] }>) => {
  mockFill.mockResolvedValue({ url: "https://files.test/filled.pdf", incompleteFields });
  const onClose = jest.fn();
  const { rerender } = render(<FillTemplateModal open template={template} lawFirmId="firm-1" onClose={onClose} />);
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  rerender(<FillTemplateModal open={false} template={template} lawFirmId="firm-1" onClose={onClose} />);
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
};

it("names the fields whose characters could not be printed, after the download", async () => {
  await download([
    { fieldName: "company", characters: ["株", "式"] },
    { fieldName: "label", characters: ["第"] },
  ]);

  expect(mockFill).toHaveBeenCalled();
  expect(screen.getByRole("status")).toHaveTextContent(
    'The document was created, but some characters in {company} and {label} couldn\'t be printed and show as "?". Check them before you send it.',
  );
});

it("says nothing when every field printed", async () => {
  await download([]);

  expect(mockFill).toHaveBeenCalled();
  expect(screen.queryByText(/couldn't be printed/)).not.toBeInTheDocument();
});

it("clears the notice when the next fill prints every field", async () => {
  mockFill
    .mockResolvedValueOnce({ url: "https://files.test/1.pdf", incompleteFields: [{ fieldName: "company", characters: ["株"] }] })
    .mockResolvedValueOnce({ url: "https://files.test/2.pdf", incompleteFields: [] });
  const onClose = jest.fn();
  render(<FillTemplateModal open template={template} lawFirmId="firm-1" onClose={onClose} />);

  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  expect(await screen.findByText(/couldn't be printed/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  await waitFor(() => expect(mockFill).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByText(/couldn't be printed/)).not.toBeInTheDocument());
});
