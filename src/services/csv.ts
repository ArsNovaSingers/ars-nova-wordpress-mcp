/**
 * CSV parsing + validation helper for bulk import tools.
 *
 * - Reads a CSV file from disk.
 * - Asserts required columns are present (case-sensitive, exact match).
 * - Returns rows as objects keyed by column name.
 * - Provides helpers to coerce string cells to int / int[] / boolean.
 */
import { readFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { parse } from "csv-parse/sync";

/** Generic shape — each row is a flat record of strings keyed by header. */
export type CsvRow = Record<string, string>;

export interface ParseCsvOptions {
  /** Column names that MUST be present in the CSV header. Throws if any are missing. */
  requiredColumns: string[];
  /** Column names allowed beyond the required set. If undefined, any extras are kept. */
  optionalColumns?: string[];
  /** If true, throws on rows where any required column is empty. Default true. */
  rejectEmptyRequired?: boolean;
}

export interface ParsedCsv {
  rows: CsvRow[];
  rowCount: number;
  columns: string[];
}

/**
 * Read a CSV file at absoluteOrRelativePath, return parsed rows + column metadata.
 * Relative paths are resolved against process.cwd() (the MCP server's working dir).
 *
 * Throws on:
 *   - File not found / unreadable
 *   - Missing required column in the header
 *   - Empty required cell when rejectEmptyRequired is true
 *   - Malformed CSV (parser error)
 */
export function parseCsvFile(filePath: string, opts: ParseCsvOptions): ParsedCsv {
  const absPath = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);

  let raw: string;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch (e) {
    throw new Error(
      `Could not read CSV file at '${absPath}': ${e instanceof Error ? e.message : String(e)}. ` +
      `Use an absolute path, or a path relative to where Claude Desktop launched the MCP.`
    );
  }

  // Strip UTF-8 BOM if present (Excel often adds one).
  const cleaned = raw.replace(/^﻿/, "");

  let records: CsvRow[];
  try {
    records = parse(cleaned, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: false,
      bom: true,
    });
  } catch (e) {
    throw new Error(
      `CSV parse error: ${e instanceof Error ? e.message : String(e)}. ` +
      `Check that quotes are balanced and rows have consistent column counts.`
    );
  }

  if (records.length === 0) {
    throw new Error(`CSV file '${absPath}' has a header row but no data rows.`);
  }

  // Validate required columns. csv-parse uses the header row as object keys.
  const columns = Object.keys(records[0]!);
  const missing = opts.requiredColumns.filter((c) => !columns.includes(c));
  if (missing.length > 0) {
    throw new Error(
      `CSV is missing required column(s): ${missing.join(", ")}. ` +
      `Found columns: ${columns.join(", ")}.`
    );
  }

  // Validate empty required cells if requested.
  const rejectEmpty = opts.rejectEmptyRequired ?? true;
  if (rejectEmpty) {
    for (let i = 0; i < records.length; i++) {
      const row = records[i]!;
      const emptyCols = opts.requiredColumns.filter(
        (c) => row[c] === undefined || row[c]!.trim() === ""
      );
      if (emptyCols.length > 0) {
        throw new Error(
          `Row ${i + 2} (1-indexed including header) has empty required column(s): ` +
          `${emptyCols.join(", ")}. Fix the CSV and retry.`
        );
      }
    }
  }

  return { rows: records, rowCount: records.length, columns };
}

// -----------------------------------------------------------------------------
// Cell coercion helpers
// -----------------------------------------------------------------------------

/** Parse a cell as a positive integer. Returns undefined for empty cells. */
export function cellToInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number.parseInt(value.trim(), 10);
  if (Number.isNaN(n)) {
    throw new Error(`Cannot parse '${value}' as integer.`);
  }
  return n;
}

/** Parse a comma-separated cell to a list of integers. e.g. "1,5, 7" -> [1, 5, 7]. */
export function cellToIntArray(value: string | undefined): number[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const n = Number.parseInt(s, 10);
      if (Number.isNaN(n)) {
        throw new Error(`Cannot parse '${s}' as integer (in list '${value}').`);
      }
      return n;
    });
}

/** Parse a comma-separated cell to a list of trimmed non-empty strings. */
export function cellToStringArray(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Return the cell verbatim if non-empty, else undefined. */
export function cellToOptionalString(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value;
}
