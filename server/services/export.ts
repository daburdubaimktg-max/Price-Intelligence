/**
 * Excel (.xlsx) workbook writer shared by exports, reports and the Excel database mirror.
 *
 * Why a dedicated writer: workbooks here can hold millions of cells (the whole observation ledger).
 * This writer streams — rows are pulled from an (async) iterable, rendered straight to compressed
 * worksheet XML and written to the target with back-pressure — so memory stays flat and the event loop
 * keeps serving requests while a large workbook is produced.
 *
 * Usage
 *   const buffer = await buildXlsx([{ name: 'Prices', columns: [...], rows }]);          // small/medium outputs
 *   await writeXlsx(sheets, '/path/to/file.xlsx');                                        // large outputs → file
 *   await writeXlsx(sheets, writableStream);                                              // large outputs → stream
 *
 * Features: bold frozen header row, auto-filter, column widths, real Excel numbers / dates / percentages
 * (never numbers-as-text), sheet-name sanitising, and automatic continuation sheets ("Name (2)", …) once a
 * sheet exceeds 1,000,000 data rows. Text cells are stored as strings, so a value such as "=1+1" is never
 * evaluated as a formula by Excel.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const CSV_MIME = 'text/csv; charset=utf-8';
/** Excel allows 1,048,576 rows per sheet; data rows beyond this limit continue on a new sheet. */
export const MAX_ROWS_PER_SHEET = 1_000_000;

export type ColumnType =
  /** Always written as text. */
  | 'text'
  /** Numeric cell (General format unless `numFmt` is given). */
  | 'number'
  /** Whole number. */
  | 'integer'
  /** Price / amount: at least two and up to four decimals. */
  | 'money'
  /** Value given in percentage points (20 → shown as 20.0%). */
  | 'percent'
  /** `YYYY-MM-DD` string or Date → Excel date. */
  | 'date'
  /** ISO timestamp or Date → Excel date-time showing the UTC wall-clock time. */
  | 'datetime'
  /** Truthy → "Yes", falsy → "No", null → blank. */
  | 'boolean';

export interface ColumnSpec {
  /** Property of each row object to read. */
  key: string;
  /** Header text. */
  header: string;
  /** Column width in characters (default depends on the type and header length). */
  width?: number;
  /** Omit to infer per value (number → number, Date → date-time, everything else → text). */
  type?: ColumnType;
  /** Custom Excel number format, e.g. '0.000' (overrides the default of the type). */
  numFmt?: string;
  /** Optional description (used by data-dictionary sheets; ignored by the writer). */
  description?: string;
}

export type RowSource = Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>;

export interface SheetSpec {
  name: string;
  columns: ColumnSpec[];
  rows: RowSource;
  /** Free-text lines written above the header row (followed by one blank row). */
  notes?: string[];
}

export interface WriteXlsxOptions {
  /** Workbook title stored in the document properties. */
  title?: string;
  /** Override of the per-sheet data-row limit (tests). */
  maxRowsPerSheet?: number;
}

export interface WorkbookSummary {
  /** Sheets actually written (continuation sheets included) with their data-row counts. */
  sheets: Array<{ name: string; rows: number }>;
  /** Size of the workbook in bytes. */
  bytes: number;
}

// ---------------------------------------------------------------------------------------------
// ZIP container (streaming, deflate, data descriptors)
// ---------------------------------------------------------------------------------------------
interface ZipEntry {
  name: Buffer;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

class ZipWriter {
  private readonly out: Writable;
  private readonly entries: ZipEntry[] = [];
  private readonly dosTime: number;
  private readonly dosDate: number;
  offset = 0;

  constructor(out: Writable) {
    this.out = out;
    const now = new Date();
    this.dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    this.dosDate = ((Math.max(1980, now.getFullYear()) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  }

  private async write(buffer: Buffer): Promise<void> {
    this.offset += buffer.length;
    if (!this.out.write(buffer)) await once(this.out, 'drain');
  }

  async add(name: string, source: Iterable<string> | AsyncIterable<string>): Promise<void> {
    const nameBuffer = Buffer.from(name, 'utf8');
    const entry: ZipEntry = { name: nameBuffer, crc: 0, compressedSize: 0, size: 0, offset: this.offset };
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0808, 6); // sizes in data descriptor + UTF-8 names
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(this.dosTime, 10);
    header.writeUInt16LE(this.dosDate, 12);
    header.writeUInt16LE(nameBuffer.length, 26);
    await this.write(Buffer.concat([header, nameBuffer]));

    const deflate = zlib.createDeflateRaw({ level: 5 });
    const pump = (async () => {
      try {
        for await (const chunk of deflate as AsyncIterable<Buffer>) {
          entry.compressedSize += chunk.length;
          await this.write(chunk);
        }
      } catch (err) {
        // Output failed: stop the compressor so the producer below is released instead of waiting for a drain.
        deflate.destroy(err as Error);
        throw err;
      }
    })();
    pump.catch(() => undefined); // surfaced through `await pump` below
    try {
      for await (const piece of source) {
        if (!piece) continue;
        const buffer = Buffer.from(piece, 'utf8');
        entry.crc = zlib.crc32(buffer, entry.crc);
        entry.size += buffer.length;
        if (!deflate.write(buffer)) await once(deflate, 'drain');
        // Hand control back so HTTP requests and the compressor make progress during big sheets.
        await yieldToEventLoop();
      }
      deflate.end();
      await pump;
    } catch (err) {
      deflate.destroy();
      await pump.catch(() => undefined);
      throw err;
    }
    if (entry.size > 0xffffffff || entry.compressedSize > 0xffffffff || this.offset > 0xffffffff) {
      throw new Error('Workbook is too large for the xlsx container (4 GB limit). Narrow the export.');
    }
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(entry.crc >>> 0, 4);
    descriptor.writeUInt32LE(entry.compressedSize, 8);
    descriptor.writeUInt32LE(entry.size, 12);
    await this.write(descriptor);
    this.entries.push(entry);
  }

  async finish(): Promise<void> {
    const start = this.offset;
    for (const entry of this.entries) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4); // version made by
      header.writeUInt16LE(20, 6); // version needed
      header.writeUInt16LE(0x0808, 8);
      header.writeUInt16LE(8, 10);
      header.writeUInt16LE(this.dosTime, 12);
      header.writeUInt16LE(this.dosDate, 14);
      header.writeUInt32LE(entry.crc >>> 0, 16);
      header.writeUInt32LE(entry.compressedSize, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt32LE(entry.offset, 42);
      await this.write(Buffer.concat([header, entry.name]));
    }
    const size = this.offset - start;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(size, 12);
    end.writeUInt32LE(start, 16);
    await this.write(end);
  }
}

// ---------------------------------------------------------------------------------------------
// SpreadsheetML rendering
// ---------------------------------------------------------------------------------------------
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
// Characters that are not allowed in XML 1.0 documents.
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const MAX_CELL_CHARS = 32_767;

function xmlText(value: string): string {
  let text = value.length > MAX_CELL_CHARS ? `${value.slice(0, MAX_CELL_CHARS - 1)}…` : value;
  text = text.replace(/\r\n?/g, '\n').replace(INVALID_XML, '');
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const xmlAttr = (value: string) => xmlText(value).replace(/"/g, '&quot;');

function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const EXCEL_EPOCH_OFFSET = 25569; // days between 1899-12-30 and 1970-01-01
const MS_PER_DAY = 86_400_000;

function excelSerial(value: unknown, dateOnly: boolean): number | null {
  let ms: number;
  if (value instanceof Date) ms = value.getTime();
  else if (typeof value === 'string') {
    const text = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) ms = Date.parse(`${text}T00:00:00Z`);
    else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text)) {
      // A timestamp without an explicit offset is taken as UTC wall-clock time.
      const iso = text.replace(' ', 'T');
      ms = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`);
    } else return null;
  } else return null;
  if (Number.isNaN(ms)) return null;
  if (dateOnly) ms = Math.floor(ms / MS_PER_DAY) * MS_PER_DAY;
  const serial = ms / MS_PER_DAY + EXCEL_EPOCH_OFFSET;
  // Serials below 61 fall into Excel's fictitious 29 Feb 1900; such dates are written as text instead.
  return serial >= 61 && serial < 2_958_466 ? Number(serial.toFixed(10)) : null;
}

const DEFAULT_FORMATS: Partial<Record<ColumnType, string>> = {
  integer: '0',
  money: '#,##0.00##',
  percent: '0.0%',
  date: 'yyyy-mm-dd',
  datetime: 'yyyy-mm-dd hh:mm:ss',
};

const DEFAULT_WIDTHS: Record<ColumnType | 'auto', number> = {
  text: 22,
  number: 12,
  integer: 10,
  money: 13,
  percent: 10,
  date: 12,
  datetime: 20,
  boolean: 9,
  auto: 18,
};

/** Cell style registry → xl/styles.xml. Index 0 = default, 1 = header, 2 = note. */
class Styles {
  private readonly formats: string[] = [];
  private readonly byFormat = new Map<string, number>();
  static readonly HEADER = 1;
  static readonly NOTE = 2;
  private static readonly FIXED = 3;

  forFormat(format: string): number {
    let index = this.byFormat.get(format);
    if (index === undefined) {
      this.formats.push(format);
      index = Styles.FIXED + this.formats.length - 1;
      this.byFormat.set(format, index);
    }
    return index;
  }

  xml(): string {
    const numFmts = this.formats.map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${xmlAttr(f)}"/>`).join('');
    const xfs = this.formats
      .map((_, i) => `<xf numFmtId="${164 + i}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`)
      .join('');
    return (
      `${XML_HEADER}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      (this.formats.length ? `<numFmts count="${this.formats.length}">${numFmts}</numFmts>` : '') +
      '<fonts count="3">' +
      '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
      '<font><b/><sz val="11"/><color rgb="FF0B1F3A"/><name val="Calibri"/><family val="2"/></font>' +
      '<font><i/><sz val="11"/><color rgb="FF475569"/><name val="Calibri"/><family val="2"/></font>' +
      '</fonts>' +
      '<fills count="3">' +
      '<fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFE8EDF5"/><bgColor indexed="64"/></patternFill></fill>' +
      '</fills>' +
      '<borders count="2">' +
      '<border><left/><right/><top/><bottom/><diagonal/></border>' +
      '<border><left/><right/><top/><bottom style="thin"><color rgb="FF94A3B8"/></bottom><diagonal/></border>' +
      '</borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${Styles.FIXED + this.formats.length}">` +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>' +
      '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      xfs +
      '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>'
    );
  }
}

interface PreparedColumn {
  key: string;
  letter: string;
  type: ColumnType | 'auto';
  style: number;
  /** Style used when an untyped column meets a Date. */
  dateStyle: number;
  width: number;
}

function prepareColumns(columns: ColumnSpec[], styles: Styles): PreparedColumn[] {
  return columns.map((column, index) => {
    const type = column.type ?? 'auto';
    const format = column.numFmt ?? (type === 'auto' ? undefined : DEFAULT_FORMATS[type]);
    const width = column.width ?? Math.min(60, Math.max(DEFAULT_WIDTHS[type], column.header.length + 3));
    return {
      key: column.key,
      letter: columnLetter(index),
      type,
      style: format && type !== 'text' && type !== 'boolean' ? styles.forFormat(format) : 0,
      dateStyle: styles.forFormat(DEFAULT_FORMATS.datetime!),
      width,
    };
  });
}

function textCell(ref: string, text: string, style = 0): string {
  if (text === '') return '';
  return `<c r="${ref}"${style ? ` s="${style}"` : ''} t="inlineStr"><is><t xml:space="preserve">${xmlText(text)}</t></is></c>`;
}

function numberCell(ref: string, value: number, style: number): string {
  return `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${value}</v></c>`;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function stringify(value: unknown): string {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function renderCell(column: PreparedColumn, rowNumber: number, value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  const ref = column.letter + rowNumber;
  switch (column.type) {
    case 'text':
      return textCell(ref, stringify(value));
    case 'boolean':
      return textCell(ref, value === false || value === 0 || value === '0' || value === 'false' ? 'No' : 'Yes');
    case 'number':
    case 'integer':
    case 'money': {
      const n = toNumber(value);
      return n === null ? textCell(ref, stringify(value)) : numberCell(ref, n, column.style);
    }
    case 'percent': {
      const n = toNumber(value);
      return n === null ? textCell(ref, stringify(value)) : numberCell(ref, Number((n / 100).toPrecision(12)), column.style);
    }
    case 'date':
    case 'datetime': {
      const serial = excelSerial(value, column.type === 'date');
      return serial === null ? textCell(ref, stringify(value)) : numberCell(ref, serial, column.style);
    }
    default: {
      if (typeof value === 'number' || typeof value === 'bigint') {
        const n = toNumber(value);
        return n === null ? '' : numberCell(ref, n, column.style);
      }
      if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
      if (value instanceof Date) {
        const serial = excelSerial(value, false);
        return serial === null ? textCell(ref, stringify(value)) : numberCell(ref, serial, column.dateStyle);
      }
      return textCell(ref, stringify(value));
    }
  }
}

/** Sheet names: at most 31 characters, none of []:*?/\, not blank, unique within the workbook. */
export function sanitiseSheetName(name: string, taken: Set<string> = new Set(), suffix = ''): string {
  let base = name.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').replace(/^'+|'+$/g, '').trim();
  if (!base) base = 'Sheet';
  if (base.toLowerCase() === 'history') base = 'History data';
  const fit = (candidateSuffix: string) => `${base.slice(0, 31 - candidateSuffix.length).trimEnd()}${candidateSuffix}`;
  let candidate = fit(suffix);
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = fit(`${suffix} (${n})`);
  taken.add(candidate.toLowerCase());
  return candidate;
}

class RowReader {
  private readonly iterator: AsyncIterator<Record<string, unknown>> | Iterator<Record<string, unknown>>;
  private buffered: IteratorResult<Record<string, unknown>> | null = null;

  constructor(source: RowSource) {
    const asyncSource = source as AsyncIterable<Record<string, unknown>>;
    this.iterator =
      typeof asyncSource[Symbol.asyncIterator] === 'function'
        ? asyncSource[Symbol.asyncIterator]()
        : (source as Iterable<Record<string, unknown>>)[Symbol.iterator]();
  }

  async peekDone(): Promise<boolean> {
    this.buffered ??= await this.iterator.next();
    return this.buffered.done === true;
  }

  async next(): Promise<Record<string, unknown> | undefined> {
    const result = this.buffered ?? (await this.iterator.next());
    this.buffered = null;
    return result.done ? undefined : result.value;
  }
}

const CHUNK_CHARS = 64 * 1024;

async function* renderSheet(
  spec: SheetSpec,
  columns: PreparedColumn[],
  reader: RowReader,
  limit: number,
  selected: boolean,
  counter: { rows: number },
): AsyncGenerator<string> {
  const notes = spec.notes ?? [];
  const headerRow = notes.length ? notes.length + 2 : 1;
  const lastLetter = columns.length ? columns[columns.length - 1]!.letter : 'A';
  let xml =
    `${XML_HEADER}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView${selected ? ' tabSelected="1"' : ''} workbookViewId="0">` +
    `<pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/>` +
    `<selection pane="bottomLeft" activeCell="A${headerRow + 1}" sqref="A${headerRow + 1}"/>` +
    '</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>';
  if (columns.length) {
    xml += `<cols>${columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`).join('')}</cols>`;
  }
  xml += '<sheetData>';
  notes.forEach((note, index) => {
    xml += `<row r="${index + 1}">${textCell(`A${index + 1}`, note, Styles.NOTE)}</row>`;
  });
  xml += `<row r="${headerRow}">${spec.columns.map((c, i) => textCell(columns[i]!.letter + headerRow, c.header || ' ', Styles.HEADER)).join('')}</row>`;

  let rowNumber = headerRow;
  while (counter.rows < limit) {
    const row = await reader.next();
    if (row === undefined) break;
    rowNumber++;
    counter.rows++;
    let cells = '';
    for (const column of columns) cells += renderCell(column, rowNumber, row[column.key]);
    xml += `<row r="${rowNumber}">${cells}</row>`;
    if (xml.length >= CHUNK_CHARS) {
      yield xml;
      xml = '';
    }
  }
  xml += '</sheetData>';
  if (columns.length) xml += `<autoFilter ref="A${headerRow}:${lastLetter}${Math.max(rowNumber, headerRow)}"/>`;
  xml += '</worksheet>';
  yield xml;
}

/**
 * Streams a workbook to a file path or a writable stream. Rows are consumed lazily, so `rows` may be a
 * generator that pages through the database. Resolves once everything has been flushed.
 */
export async function writeXlsx(sheets: SheetSpec[], target: string | Writable, options: WriteXlsxOptions = {}): Promise<WorkbookSummary> {
  if (sheets.length === 0) throw new Error('A workbook needs at least one sheet');
  const limit = Math.max(1, options.maxRowsPerSheet ?? MAX_ROWS_PER_SHEET);
  let out: Writable;
  let tempPath: string | null = null;
  if (typeof target === 'string') {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Write next to the destination and rename when complete, so readers never see a half-written file.
    tempPath = `${target}.${process.pid}.${Date.now()}.tmp`;
    out = fs.createWriteStream(tempPath);
  } else {
    out = target;
  }
  const zip = new ZipWriter(out);
  const styles = new Styles();
  const written: Array<{ name: string; rows: number }> = [];
  const taken = new Set<string>();
  try {
    for (const spec of sheets) {
      const columns = prepareColumns(spec.columns, styles);
      const reader = new RowReader(spec.rows);
      let part = 0;
      do {
        part++;
        const name = sanitiseSheetName(spec.name, taken, part > 1 ? ` (${part})` : '');
        const counter = { rows: 0 };
        await zip.add(
          `xl/worksheets/sheet${written.length + 1}.xml`,
          renderSheet(spec, columns, reader, limit, written.length === 0, counter),
        );
        written.push({ name, rows: counter.rows });
      } while (!(await reader.peekDone()));
    }

    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    await zip.add('xl/styles.xml', [styles.xml()]);
    await zip.add('xl/workbook.xml', [
      `${XML_HEADER}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="16000"/></bookViews>' +
        `<sheets>${written.map((s, i) => `<sheet name="${xmlAttr(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
        '</workbook>',
    ]);
    await zip.add('xl/_rels/workbook.xml.rels', [
      `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        written
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join('') +
        `<Relationship Id="rId${written.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>',
    ]);
    await zip.add('docProps/core.xml', [
      `${XML_HEADER}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
        'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
        'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
        `<dc:title>${xmlText(options.title ?? 'Price Intelligence OS export')}</dc:title>` +
        '<dc:creator>Price Intelligence OS</dc:creator><cp:lastModifiedBy>Price Intelligence OS</cp:lastModifiedBy>' +
        `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
        `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
        '</cp:coreProperties>',
    ]);
    await zip.add('docProps/app.xml', [
      `${XML_HEADER}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">` +
        '<Application>Price Intelligence OS</Application></Properties>',
    ]);
    await zip.add('_rels/.rels', [
      `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
        '</Relationships>',
    ]);
    await zip.add('[Content_Types].xml', [
      `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        written
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join('') +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
        '</Types>',
    ]);
    await zip.finish();
    out.end();
    await finished(out);
    if (tempPath) fs.renameSync(tempPath, target as string);
  } catch (err) {
    out.destroy();
    if (tempPath) fs.rmSync(tempPath, { force: true });
    throw err;
  }
  return { sheets: written, bytes: zip.offset };
}

/** Builds a workbook in memory (reports, modest exports). For large outputs use `writeXlsx`. */
export async function buildXlsx(sheets: SheetSpec[], options: WriteXlsxOptions = {}): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  await writeXlsx(sheets, sink, options);
  return Buffer.concat(chunks);
}

/**
 * A "Provenance" sheet: where the data came from and how it was filtered. Lines are either plain text
 * or [label, value] pairs.
 */
export function provenanceSheet(title: string, lines: Array<string | [label: string, value: unknown]>, name = 'Provenance'): SheetSpec {
  return {
    name,
    notes: [title],
    columns: [
      { key: 'item', header: 'Item', type: 'text', width: 34 },
      { key: 'value', header: 'Value', width: 90 },
    ],
    rows: lines.map((line) => (Array.isArray(line) ? { item: line[0], value: line[1] } : { item: line, value: null })),
  };
}

/** Safe file name for Content-Disposition headers. */
export function downloadName(base: string, extension: string): string {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'export';
  return `${clean}-${stamp}.${extension}`;
}
