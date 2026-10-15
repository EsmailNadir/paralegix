import { neutralizeFormula } from "@/lib/utils/csv";
import { todayLocalDate } from "@/lib/utils/dateUtils";

/**
 * One column of a CSV export: which row property to read, and the header to
 * write above it. Lists render themselves with `renderRow`, so this describes
 * the exported file only, never anything on screen.
 */
export interface ExportColumn {
  field: string;
  headerName: string;
}

/**
 * Escape a CSV cell value: wrap in quotes if it contains commas, quotes, or newlines.
 * Double any internal quotes per RFC 4180.
 */
function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Format a value for CSV export. Handles dates, numbers, booleans, arrays.
 */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? "" : value.toISOString().split("T")[0];
  }
  if (typeof value === "string") {
    // Try to detect ISO date strings and format them
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
      const d = new Date(value);
      if (!isNaN(d.getTime())) {
        return d.toLocaleDateString();
      }
    }
    return neutralizeFormula(value);
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return neutralizeFormula(value.join(", "));
  if (typeof value === "number") return String(value);
  return String(value);
}

/**
 * Export rows to a CSV file and trigger a browser download.
 *
 * @param rows - Array of row objects
 * @param columns - Column definitions (uses field + headerName)
 * @param filename - Base filename (date will be appended, e.g. "matters_2024-03-16.csv")
 */
export function exportToCSV(
  rows: Record<string, unknown>[],
  columns: ExportColumn[],
  filename: string = "export",
): void {
  // Filter out non-data columns (actions, selection)
  const exportColumns = columns.filter(
    (col) => col.field !== "actions" && col.field !== "__check__",
  );

  // Build header row
  const headers = exportColumns.map((col) => escapeCell(col.headerName));

  // Build data rows
  const csvRows = rows.map((row) =>
    exportColumns.map((col) => escapeCell(formatValue(row[col.field]))).join(","),
  );

  // Combine with BOM for Excel compatibility
  const BOM = "\uFEFF";
  const csvContent = BOM + [headers.join(","), ...csvRows].join("\r\n");

  // Create blob and trigger download
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  const today = todayLocalDate();
  link.href = url;
  link.download = `${filename}_${today}.csv`;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
