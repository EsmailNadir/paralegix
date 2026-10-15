/**
 * Dependency-free CSV helpers for client-side exports.
 *
 * Values are escaped per RFC 4180: any field containing a quote, comma, or
 * newline is wrapped in double quotes, and embedded quotes are doubled.
 */

export interface CsvColumn {
  key: string;
  header: string;
}

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
const SIGNED_NUMBER = /^[+-]?\d[\d,]*(\.\d+)?$/;

/**
 * Stop a spreadsheet from running a cell as a formula (CSV injection).
 *
 * Excel and Sheets evaluate a cell that starts with `=`, `+`, `-`, `@`, a tab
 * or a CR, so a matter title or ledger description of `=HYPERLINK(...)` would
 * export live. A leading apostrophe makes the app read it as text. A signed
 * number is left alone: a withdrawal of -12.50 is data and has to still sum.
 */
export function neutralizeFormula(str: string): string {
  return FORMULA_TRIGGER.test(str) && !SIGNED_NUMBER.test(str) ? `'${str}` : str;
}

/** Escape a single CSV field value. */
function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = typeof value === "string" ? neutralizeFormula(value) : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Build a CSV string from an array of row objects and a column spec. Column
 * order and headers come from `columns`; each row reads `row[column.key]`.
 */
export function toCsv(rows: Record<string, any>[], columns: CsvColumn[]): string {
  const headerLine = columns.map((c) => escapeCell(c.header)).join(",");
  const dataLines = rows.map((row) =>
    columns.map((c) => escapeCell(row[c.key])).join(","),
  );
  return [headerLine, ...dataLines].join("\r\n");
}

/**
 * Parse CSV text into a 2D array of string cells (RFC 4180-ish).
 *
 * Handles quoted fields, commas inside quotes, escaped quotes (""), and both
 * CRLF and LF line endings. A trailing blank line is ignored. Dependency-free.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { rows.push(row); row = []; };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ",") { pushField(); i++; continue; }
    if (ch === "\r") {
      // Consume CRLF (and a lone CR) as a single row break.
      pushField(); pushRow();
      if (text[i + 1] === "\n") i += 2; else i++;
      continue;
    }
    if (ch === "\n") { pushField(); pushRow(); i++; continue; }
    field += ch; i++;
  }
  // Flush the final field/row unless the input ended on a clean row break.
  if (field !== "" || row.length > 0) { pushField(); pushRow(); }
  // Drop a trailing blank LINE, which a terminal newline produces as a row of
  // one empty cell. A row of several empty cells is not that: ",," is a real
  // record of three blank fields, and popping it loses a row on import.
  const last = rows[rows.length - 1];
  if (last && last.length === 1 && last[0] === "") rows.pop();
  return rows;
}

/** Trigger a browser download of CSV text as a .csv file. */
export function downloadCsv(filename: string, csv: string): void {
  // Prepend a BOM so spreadsheet apps detect UTF-8 and render accents correctly.
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Trigger a browser download of a value serialized as a pretty-printed .json file. */
export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
