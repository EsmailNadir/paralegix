/**
 * `exportToCSV`, the download behind the matters and tasks list "Export CSV"
 * buttons. Both grid specs mock this module, so before this file nothing ran it.
 *
 * What goes wrong here is silent: a matter description with a comma splits into
 * two columns, a quote ends a cell early, a null prints "null", an ISO timestamp
 * lands on the wrong day. The file still opens; it is just wrong. Every case
 * below reads the exact bytes handed to the Blob, so a change to quoting,
 * formatting, the BOM, the line ending or the filename goes red.
 *
 * Formula-looking text is neutralised with a leading apostrophe so a title like
 * `=HYPERLINK(...)` opens as text in Excel or Sheets rather than running.
 */
import { exportToCSV, type ExportColumn } from "@/utils/csvExport";

const BOM = "﻿";

let blobs: Blob[];
let clicked: { href: string; download: string; attached: boolean; hidden: boolean }[];
let revoked: string[];

async function readBlob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  // ignoreBOM keeps the byte-order mark in the decoded text so it can be asserted.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf);
}

async function exportedText(
  rows: Record<string, unknown>[],
  columns: ExportColumn[],
  filename?: string,
): Promise<string> {
  exportToCSV(rows, columns, filename);
  expect(blobs).toHaveLength(1);
  return readBlob(blobs[0]);
}

beforeEach(() => {
  blobs = [];
  clicked = [];
  revoked = [];
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => {
    blobs.push(b);
    return `blob:mock/${blobs.length}`;
  };
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = (u: string) => {
    revoked.push(u);
  };
  jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({
      href: this.href,
      download: this.download,
      attached: document.body.contains(this),
      hidden: this.style.display === "none",
    });
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

const COLS: ExportColumn[] = [
  { field: "name", headerName: "Name" },
  { field: "notes", headerName: "Notes" },
];

describe("exportToCSV file content", () => {
  it("writes a UTF-8 BOM, the header row, then one CRLF-separated row per record", async () => {
    // The BOM is what makes Excel read the file as UTF-8 instead of mangling
    // accented client names; CRLF is the RFC 4180 record separator.
    const text = await exportedText(
      [
        { name: "Acme", notes: "first" },
        { name: "Globex", notes: "second" },
      ],
      COLS,
    );
    expect(text).toBe(`${BOM}Name,Notes\r\nAcme,first\r\nGlobex,second`);
  });

  it("takes column order from the column list, not from the row's keys", async () => {
    const text = await exportedText([{ notes: "n", name: "x" }], COLS);
    expect(text).toBe(`${BOM}Name,Notes\r\nx,n`);
  });

  it("drops the actions and selection columns and leaves every other column", async () => {
    const text = await exportedText(
      [{ __check__: true, name: "Acme", actions: "edit" }],
      [
        { field: "__check__", headerName: "" },
        { field: "name", headerName: "Name" },
        { field: "actions", headerName: "Actions" },
      ],
    );
    expect(text).toBe(`${BOM}Name\r\nAcme`);
  });

  it("writes only a header line when there are no rows", async () => {
    expect(await exportedText([], COLS)).toBe(`${BOM}Name,Notes`);
  });

  it("writes null, undefined and a missing field as an empty cell, never the word", async () => {
    const text = await exportedText(
      [{ a: null, b: undefined }],
      [
        { field: "a", headerName: "A" },
        { field: "b", headerName: "B" },
        { field: "c", headerName: "C" },
      ],
    );
    expect(text).toBe(`${BOM}A,B,C\r\n,,`);
  });
});

describe("exportToCSV quoting (RFC 4180)", () => {
  it("quotes a cell containing a comma so it stays one column", async () => {
    const text = await exportedText([{ name: "Smith, Jones & Co", notes: "x" }], COLS);
    expect(text).toBe(`${BOM}Name,Notes\r\n"Smith, Jones & Co",x`);
  });

  it("quotes a cell containing a double quote and doubles the quote inside it", async () => {
    const text = await exportedText([{ name: 'The "Big" Matter', notes: "x" }], COLS);
    expect(text).toBe(`${BOM}Name,Notes\r\n"The ""Big"" Matter",x`);
  });

  it("quotes a cell containing a newline so it stays one record", async () => {
    const text = await exportedText([{ name: "a", notes: "line1\nline2" }], COLS);
    expect(text).toBe(`${BOM}Name,Notes\r\na,"line1\nline2"`);
  });

  it("quotes a cell containing a bare carriage return", async () => {
    const text = await exportedText([{ name: "a", notes: "line1\rline2" }], COLS);
    expect(text).toBe(`${BOM}Name,Notes\r\na,"line1\rline2"`);
  });

  it("leaves a cell with none of those characters unquoted, spaces included", async () => {
    const text = await exportedText([{ name: "  padded  ", notes: "it's fine" }], COLS);
    expect(text).toBe(`${BOM}Name,Notes\r\n  padded  ,it's fine`);
  });

  it("quotes a header that itself contains a comma or a quote", async () => {
    const text = await exportedText(
      [{ a: 1, b: 2 }],
      [
        { field: "a", headerName: "Last, First" },
        { field: "b", headerName: 'Say "hi"' },
      ],
    );
    expect(text).toBe(`${BOM}"Last, First","Say ""hi"""\r\n1,2`);
  });

  it("neutralises formula-looking text with a leading apostrophe", async () => {
    // A cell starting with =, +, -, @, tab or CR is evaluated as a formula when
    // the file is opened in Excel or Sheets, so a matter or task title of
    // `=HYPERLINK(...)` would export live.
    const text = await exportedText(
      [
        { name: "=1+2", notes: "+SUM(A1)" },
        { name: "-cmd|' /C calc'!A0", notes: "@cmd" },
        { name: "\t=1", notes: "plain" },
      ],
      COLS,
    );
    expect(text).toBe(
      `${BOM}Name,Notes\r\n'=1+2,'+SUM(A1)\r\n'-cmd|' /C calc'!A0,'@cmd\r\n'\t=1,plain`,
    );
  });

  it("leaves a signed number alone, whether it arrives as a number or as numeric text", async () => {
    // A negative amount is data, not a formula. Prefixing it would turn every
    // credit in an export into text that no longer sums.
    const text = await exportedText(
      [
        { name: -3, notes: "-12.50" },
        { name: "+4", notes: "-1,234.56" },
      ],
      COLS,
    );
    expect(text).toBe(`${BOM}Name,Notes\r\n-3,-12.50\r\n+4,"-1,234.56"`);
  });
});

describe("exportToCSV value formatting", () => {
  it("writes booleans as Yes and No", async () => {
    const text = await exportedText([{ name: true, notes: false }], COLS);
    expect(text).toBe(`${BOM}Name,Notes\r\nYes,No`);
  });

  it("joins an array with comma-space and therefore quotes the cell", async () => {
    const text = await exportedText([{ name: ["Alice", "Bob"], notes: [] }], COLS);
    expect(text).toBe(`${BOM}Name,Notes\r\n"Alice, Bob",`);
  });

  it("writes numbers as their plain string, zero and negative cents included", async () => {
    // Money columns are integer cents; the export must not round, group or
    // format them (no "1,234" that would then need quoting).
    const text = await exportedText([{ name: 123456, notes: 0 }, { name: -50, notes: 1.5 }], COLS);
    expect(text).toBe(`${BOM}Name,Notes\r\n123456,0\r\n-50,1.5`);
  });

  it("leaves a day-only YYYY-MM-DD string untouched, so a due date never shifts a day", async () => {
    const text = await exportedText([{ name: "2024-03-16", notes: "2024-03-16x" }], COLS);
    expect(text).toBe(`${BOM}Name,Notes\r\n2024-03-16,2024-03-16x`);
  });

  it("renders an ISO timestamp string as the viewer's LOCAL calendar date", async () => {
    // 03:00 UTC on the 17th is still the evening of the 16th in Los Angeles
    // (the zone jest.config pins). A UTC read would print the 17th.
    const text = await exportedText([{ name: "2024-03-17T03:00:00Z", notes: "x" }], COLS);
    expect(text).toBe(`${BOM}Name,Notes\r\n3/16/2024,x`);
  });

  it("passes an ISO-shaped string that is not a real date through unchanged", async () => {
    const text = await exportedText([{ name: "2024-13-45Tnonsense", notes: "x" }], COLS);
    expect(text).toBe(`${BOM}Name,Notes\r\n2024-13-45Tnonsense,x`);
  });

  it("writes a Date object as its UTC YYYY-MM-DD, and an invalid Date as empty", async () => {
    // Note the asymmetry with the string case above: the same instant exported
    // as a Date reads as the 17th (UTC), as a string reads 3/16/2024 (local).
    // No caller passes a Date today (rows arrive as JSON), so this only pins it.
    const text = await exportedText(
      [{ name: new Date("2024-03-17T03:00:00Z"), notes: new Date("not a date") }],
      COLS,
    );
    expect(text).toBe(`${BOM}Name,Notes\r\n2024-03-17,`);
  });

  it("stringifies any other object with String()", async () => {
    const text = await exportedText([{ name: { toString: () => "custom" }, notes: "x" }], COLS);
    expect(text).toBe(`${BOM}Name,Notes\r\ncustom,x`);
  });
});

describe("exportToCSV download", () => {
  it("names the file with the caller's base and the viewer's LOCAL date", async () => {
    // 03:00 UTC on the 17th is the 16th in Los Angeles; the filename must say 16.
    jest.useFakeTimers({ now: new Date("2024-03-17T03:00:00Z") });
    exportToCSV([{ name: "a", notes: "b" }], COLS, "matters");

    expect(clicked).toEqual([
      { href: "blob:mock/1", download: "matters_2024-03-16.csv", attached: true, hidden: true },
    ]);
  });

  it("falls back to the base name 'export' when none is given", () => {
    jest.useFakeTimers({ now: new Date("2024-06-01T18:00:00Z") });
    exportToCSV([], COLS);
    expect(clicked.map((c) => c.download)).toEqual(["export_2024-06-01.csv"]);
  });

  it("types the blob as UTF-8 CSV, removes the link and revokes the object URL afterwards", () => {
    exportToCSV([], COLS, "tasks");
    expect(blobs[0].type).toBe("text/csv;charset=utf-8;");
    expect(document.body.querySelectorAll("a")).toHaveLength(0);
    expect(revoked).toEqual(["blob:mock/1"]);
  });
});
