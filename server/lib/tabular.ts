/**
 * Tabular file helpers: reading CSV and Excel (.xlsx) uploads into plain string records, and writing CSV.
 *
 * Reading never interprets values (no number/date guessing) — every cell comes back as the text a person
 * would see, so one import pipeline can validate CSV and Excel input with the same rules.
 */
import { parse as parseCsvSync } from 'csv-parse/sync';
import ExcelJS from 'exceljs';

export interface TabularData {
  /** Column headers in file order (blank headers become "Column N", duplicates get a " (2)" suffix). */
  headers: string[];
  /** One record per non-empty data row, keyed by header. Every value is a trimmed string ('' when blank). */
  rows: Record<string, string>[];
  /** Spreadsheet row number of each record (header row = usually 1), for error messages. */
  rowNumbers: number[];
}

export interface CsvData extends TabularData {
  delimiter: string;
}

export interface XlsxData extends TabularData {
  /** Names of all worksheets in the workbook. */
  sheets: string[];
  /** The worksheet that was read. */
  sheet: string;
}

const UTF8_BOM = '﻿';

/** Decodes an uploaded text file: UTF-8 (with or without BOM), UTF-16, falling back to Windows-1252. */
export function decodeText(input: Buffer | string): string {
  if (typeof input === 'string') return input.startsWith(UTF8_BOM) ? input.slice(1) : input;
  if (input.length >= 2 && input[0] === 0xff && input[1] === 0xfe) return new TextDecoder('utf-16le').decode(input.subarray(2));
  if (input.length >= 2 && input[0] === 0xfe && input[1] === 0xff) return new TextDecoder('utf-16be').decode(input.subarray(2));
  let text = new TextDecoder('utf-8').decode(input);
  if (text.includes('�')) {
    // Not valid UTF-8: Excel on Windows saves "CSV (Comma delimited)" in the ANSI code page.
    text = new TextDecoder('windows-1252').decode(input);
  }
  return text.startsWith(UTF8_BOM) ? text.slice(1) : text;
}

/** Picks the delimiter (comma, semicolon or tab) that splits the first non-empty line into the most fields. */
export function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]!++;
  }
  let best = ',';
  for (const candidate of [';', '\t']) {
    if (counts[candidate]! > counts[best]!) best = candidate;
  }
  return best;
}

function buildHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((value, index) => {
    let name = value.trim() || `Column ${index + 1}`;
    const key = name.toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count > 1) name = `${name} (${count})`;
    return name;
  });
}

function toRecords(table: Array<{ rowNumber: number; cells: string[] }>): TabularData {
  const headerIndex = table.findIndex((row) => row.cells.some((cell) => cell !== ''));
  if (headerIndex === -1) return { headers: [], rows: [], rowNumbers: [] };
  const headerCells = [...table[headerIndex]!.cells];
  while (headerCells.length > 0 && headerCells[headerCells.length - 1] === '') headerCells.pop();
  const headers = buildHeaders(headerCells);
  const rows: Record<string, string>[] = [];
  const rowNumbers: number[] = [];
  for (let i = headerIndex + 1; i < table.length; i++) {
    const { rowNumber, cells } = table[i]!;
    if (!cells.some((cell) => cell !== '')) continue;
    const record: Record<string, string> = {};
    headers.forEach((header, column) => {
      record[header] = cells[column] ?? '';
    });
    rows.push(record);
    rowNumbers.push(rowNumber);
  }
  return { headers, rows, rowNumbers };
}

/**
 * Parses CSV text. Strips a byte-order mark, auto-detects `,` `;` or tab as the delimiter, trims cells and
 * skips blank lines. The first non-empty line is the header row.
 */
export function parseCsv(input: Buffer | string): CsvData {
  const text = decodeText(input);
  const delimiter = detectDelimiter(text);
  let records: string[][];
  try {
    records = parseCsvSync(text, {
      delimiter,
      bom: false,
      trim: true,
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: false,
    }) as string[][];
  } catch (err) {
    throw new Error(`The file is not valid CSV: ${(err as Error).message}`);
  }
  const table = records.map((cells, index) => ({ rowNumber: index + 1, cells: cells.map((c) => (c ?? '').trim()) }));
  return { ...toRecords(table), delimiter };
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Excel dates carry no time zone: render the wall-clock value exactly as the cell shows it. */
function formatExcelDate(date: Date): string {
  if (Number.isNaN(date.getTime())) return '';
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  const ms = date.getUTCMilliseconds();
  const fullTime = ms ? `${time}.${pad(ms, 3)}` : time;
  // A time-of-day cell is stored as a fraction of day 0 (30 Dec 1899).
  if (date.getUTCFullYear() < 1900) return fullTime;
  const day = `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  return time === '00:00:00' && ms === 0 ? day : `${day} ${fullTime}`;
}

function numberToText(value: number, numFmt?: string): string {
  if (!Number.isFinite(value)) return '';
  if (numFmt && numFmt.includes('%')) {
    // Shown as a percentage in Excel: 0.2 is displayed (and meant) as 20%.
    return `${Number((value * 100).toPrecision(12))}%`;
  }
  return String(Number(value.toPrecision(15)));
}

function cellText(value: unknown, numFmt?: string): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return numberToText(value, numFmt);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return formatExcelDate(value);
  if (typeof value === 'object') {
    const v = value as {
      richText?: Array<{ text?: string }>;
      text?: unknown;
      hyperlink?: string;
      formula?: string;
      sharedFormula?: string;
      result?: unknown;
      error?: string;
    };
    if (Array.isArray(v.richText)) return v.richText.map((part) => part.text ?? '').join('').trim();
    if (v.formula !== undefined || v.sharedFormula !== undefined) return cellText(v.result, numFmt);
    if (v.error !== undefined) return '';
    if (v.text !== undefined) return cellText(v.text, numFmt) || (v.hyperlink ?? '').trim();
    if (v.hyperlink !== undefined) return v.hyperlink.trim();
  }
  return String(value).trim();
}

/**
 * Reads one worksheet of an .xlsx workbook (the named sheet, otherwise the first sheet that has data).
 * The first non-empty row is the header row. Dates become ISO-style text (`2026-11-17` or
 * `2026-11-17 08:15:00`, exactly the wall-clock value shown in Excel), numbers become plain strings,
 * formulas yield their cached results and rich text is flattened.
 */
export async function parseXlsx(buffer: Buffer, sheetName?: string | null): Promise<XlsxData> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as never);
  } catch (err) {
    throw new Error(`The file is not a readable Excel workbook (.xlsx): ${(err as Error).message}`);
  }
  const sheets = workbook.worksheets.map((ws) => ws.name);
  if (sheets.length === 0) throw new Error('The workbook does not contain any worksheets');
  let worksheet = sheetName ? workbook.worksheets.find((ws) => ws.name.toLowerCase() === sheetName.trim().toLowerCase()) : undefined;
  if (sheetName && !worksheet) {
    throw new Error(`Worksheet "${sheetName}" was not found. Available sheets: ${sheets.join(', ')}`);
  }
  worksheet ??= workbook.worksheets.find((ws) => ws.actualRowCount > 0) ?? workbook.worksheets[0]!;

  const table: Array<{ rowNumber: number; cells: string[] }> = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      const text = cellText(cell.value, cell.numFmt);
      for (let i = cells.length; i < columnNumber - 1; i++) cells.push('');
      cells[columnNumber - 1] = text;
    });
    table.push({ rowNumber, cells });
  });
  return { ...toRecords(table), sheets, sheet: worksheet.name };
}

// ---------------------------------------------------------------------------------------------
// CSV writing
// ---------------------------------------------------------------------------------------------
export interface CsvColumn {
  key: string;
  header: string;
}

const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/**
 * Renders one CSV cell. Text that a spreadsheet would execute as a formula (leading = + - @, tab or CR)
 * is neutralised with a leading apostrophe; genuine numbers such as -5.2 are left alone.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text: string;
  if (value instanceof Date) text = Number.isNaN(value.getTime()) ? '' : value.toISOString();
  else if (typeof value === 'number') text = Number.isFinite(value) ? String(value) : '';
  else if (typeof value === 'boolean') text = value ? 'true' : 'false';
  else if (typeof value === 'object') text = JSON.stringify(value);
  else text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text) && !PLAIN_NUMBER.test(text.trim())) text = `'${text}`;
  if (/[",\r\n]/.test(text) || /^\s|\s$/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** Yields the CSV line by line (each chunk ends with CRLF); the first chunk carries the UTF-8 BOM and header. */
export function* csvLines(columns: CsvColumn[], rows: Iterable<Record<string, unknown>>): Generator<string> {
  yield `${UTF8_BOM}${columns.map((c) => csvCell(c.header)).join(',')}\r\n`;
  for (const row of rows) {
    yield `${columns.map((c) => csvCell(row[c.key])).join(',')}\r\n`;
  }
}

/** RFC 4180 CSV (CRLF line ends) with a UTF-8 byte-order mark so Excel opens it with the right encoding. */
export function toCsv(columns: CsvColumn[], rows: Iterable<Record<string, unknown>>): string {
  let out = '';
  for (const line of csvLines(columns, rows)) out += line;
  return out;
}
