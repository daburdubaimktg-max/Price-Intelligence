/**
 * A report table. Cells are rendered from the column type the server declares. Long tables are paged on
 * screen (the exports always hold every row) and any column can be sorted. A text column that says the same
 * thing in every row (one brand, one currency, one data source…) is stated once above the table instead of
 * being repeated, which keeps wide tables readable without hiding anything.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import { currencyDecimals, DASH, fmtDate, fmtDateTime, fmtNumber, fmtPct } from '@/lib/format.ts';
import { Pagination } from '@/components/ui/data-table.tsx';
import { Badge, cn } from '@/components/ui/primitives.tsx';
import { IndexScale } from '@/components/charts/charts.tsx';
import { AVAILABILITY_LABELS, type Availability } from '@shared/constants.ts';
import type { ReportColumn, ReportTable } from '@shared/api/reports.ts';

type Row = ReportTable['rows'][number];

export const SCREEN_PAGE = 25;
/** Rows printed per table; anything longer points at the export. */
export const PRINT_ROWS = 250;

const NUMERIC = new Set<ReportColumn['type']>(['integer', 'number', 'money', 'percent', 'signed_percent', 'index']);
const blank = (value: Row[string] | undefined): boolean => value === null || value === undefined || value === '';

function moneyText(value: number, currency: string): string {
  const d = currencyDecimals(currency || null);
  // unit prices below 1 may carry one more decimal than the currency normally shows
  return new Intl.NumberFormat('en-GB', { minimumFractionDigits: d, maximumFractionDigits: Math.abs(value) < 1 ? d + 1 : d }).format(value);
}

/** Signed percentage: the arrow and the sign carry the direction; the colour stays neutral. */
function SignedPct({ value }: { value: number }) {
  const flat = Math.abs(value) < 0.05;
  const Icon = flat ? Minus : value > 0 ? ArrowUp : ArrowDown;
  return (
    <span className="inline-flex items-center justify-end gap-0.5 font-medium whitespace-nowrap text-ink">
      <Icon className="size-3 text-ink-3" aria-hidden />
      {fmtPct(flat ? 0 : value, 1, true)}
      <span className="sr-only">{flat ? 'unchanged' : value > 0 ? 'higher' : 'lower'}</span>
    </span>
  );
}

/** Text values that end in a DEMO marker get the same hatched stamp used everywhere else. */
function TextValue({ text }: { text: string }) {
  const match = /^(.*?)\s*(?:\(DEMO\)|·\s*DEMO)$/.exec(text);
  if (match) {
    return (
      <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        {match[1]}
        <Badge tone="demo" title="Illustrative demo data — fictional, not a market observation.">
          DEMO
        </Badge>
      </span>
    );
  }
  return <>{AVAILABILITY_LABELS[text as Availability] ?? text}</>;
}

function cell(column: ReportColumn, row: Row, currencyShown: boolean): ReactNode {
  const value = row[column.key];
  if (blank(value)) return <span className="text-ink-4">{DASH}</span>;
  switch (column.type) {
    case 'money': {
      const currency = column.currency_key ? String(row[column.currency_key] ?? '') : '';
      return (
        <>
          {moneyText(Number(value), currency)}
          {!currencyShown && currency ? <span className="ml-1 text-[11px] text-ink-3">{currency}</span> : null}
        </>
      );
    }
    case 'percent':
      return fmtPct(Number(value), 1);
    case 'signed_percent':
      return <SignedPct value={Number(value)} />;
    case 'index':
      return (
        <span className="inline-flex items-center justify-end gap-2">
          <IndexScale value={Number(value)} width={56} className="hidden md:inline-block" />
          <span className="font-medium text-ink">{Number(value).toFixed(1)}</span>
        </span>
      );
    case 'integer':
      return fmtNumber(Number(value));
    case 'number':
      return fmtNumber(Number(value), 2);
    case 'date':
      return fmtDate(String(value));
    case 'datetime':
      return fmtDateTime(String(value), 'UTC');
    default:
      return <TextValue text={String(value)} />;
  }
}

/** Orders two rows by a column. Blank cells sort last whichever direction is chosen. */
function compare(a: Row, b: Row, column: ReportColumn, desc: boolean): number {
  const x = a[column.key];
  const y = b[column.key];
  if (blank(x) || blank(y)) return blank(x) === blank(y) ? 0 : blank(x) ? 1 : -1;
  const order = NUMERIC.has(column.type) ? Number(x) - Number(y) : String(x).localeCompare(String(y), 'en', { numeric: true });
  return desc ? -order : order;
}

interface Layout {
  /** Columns drawn in the grid. */
  columns: Array<ReportColumn & { wrap: boolean; minWidth?: number }>;
  /** Text columns holding one and the same value in every row, stated once above the grid. */
  constant: Array<{ column: ReportColumn; value: string }>;
}

function layoutOf(table: ReportTable): Layout {
  const constant: Layout['constant'] = [];
  const columns: Layout['columns'] = [];
  const currencyKeys = new Set(table.columns.map((c) => c.currency_key).filter(Boolean));
  for (const column of table.columns) {
    if (column.type !== 'text') {
      columns.push({ ...column, wrap: false });
      continue;
    }
    let longest = 0;
    let first: string | null = null;
    let same = table.rows.length > 1;
    for (const row of table.rows) {
      const text = blank(row[column.key]) ? '' : String(row[column.key]);
      if (first === null) first = text;
      else if (text !== first) same = false;
      if (text.length > longest) longest = text.length;
    }
    // the leading column identifies the row and always stays in the grid
    if (same && columns.length > 0) {
      constant.push({ column, value: first ?? '' });
      continue;
    }
    // short labels stay on one line; longer text may wrap, but never into a sliver
    const wrap = longest > 18 && !currencyKeys.has(column.key);
    columns.push({ ...column, wrap, minWidth: wrap ? (longest > 44 ? 200 : longest > 28 ? 150 : 116) : undefined });
  }
  return { columns, constant };
}

export function ReportTableView({ table, printing, label }: { table: ReportTable; printing: boolean; label: string }) {
  const [sort, setSort] = useState<string | undefined>(undefined);
  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
    setSort(undefined);
  }, [table]);

  const layout = useMemo(() => layoutOf(table), [table]);
  const textKeys = useMemo(() => new Set(layout.columns.filter((c) => c.type === 'text').map((c) => c.key)), [layout]);
  // a currency stated once above the grid still names the currency of every money cell
  const statedCurrencies = useMemo(() => new Set(layout.constant.map((c) => c.column.key)), [layout]);

  const sorted = useMemo(() => {
    if (!sort) return table.rows;
    const key = sort.replace(/^-/, '');
    const column = table.columns.find((c) => c.key === key);
    if (!column) return table.rows;
    const desc = sort.startsWith('-');
    return [...table.rows].sort((a, b) => compare(a, b, column, desc));
  }, [table.rows, table.columns, sort]);

  const total = sorted.length;
  const pages = Math.max(1, Math.ceil(total / SCREEN_PAGE));
  const current = Math.min(page, pages);
  const shown = printing ? sorted.slice(0, PRINT_ROWS) : sorted.slice((current - 1) * SCREEN_PAGE, current * SCREEN_PAGE);
  const sortKey = sort?.replace(/^-/, '');
  const desc = sort?.startsWith('-') ?? false;

  return (
    <div className="overflow-hidden rounded-[10px] border border-line bg-surface">
      {layout.constant.length ? (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-line bg-sunken px-3.5 py-2 text-[12px] leading-5" role="note" aria-label="Values that are the same in every row">
          {layout.constant.map(({ column, value }) => (
            <span key={column.key} className="inline-flex items-center gap-1.5">
              <span className="text-ink-3">{column.label}</span>
              <span className="font-medium text-ink">{value ? <TextValue text={value} /> : <span className="font-normal text-ink-3">none</span>}</span>
            </span>
          ))}
          <span className="text-ink-4">— the same in every row</span>
        </div>
      ) : null}
      <div className="table-wrap">
        <table className="grid-table is-dense">
          <thead>
            <tr>
              {layout.columns.map((c) => {
                const active = sortKey === c.key;
                const right = NUMERIC.has(c.type);
                return (
                  <th key={c.key} scope="col" style={{ textAlign: right ? 'right' : 'left' }} aria-sort={active ? (desc ? 'descending' : 'ascending') : undefined}>
                    <button
                      type="button"
                      title={`Sort by ${c.label}`}
                      className={cn('inline-flex items-end gap-1 text-left uppercase hover:text-ink', right && 'flex-row-reverse text-right', active && 'text-ink')}
                      onClick={() => {
                        // numbers start with the largest, text with A; a third click returns to the report's own order
                        const firstDesc = right;
                        const next = !active ? (firstDesc ? `-${c.key}` : c.key) : desc === firstDesc ? (firstDesc ? c.key : `-${c.key}`) : undefined;
                        setSort(next);
                        setPage(1);
                      }}
                    >
                      <span>{c.label}</span>
                      {active ? desc ? <ArrowDown className="no-print mb-px size-3 shrink-0" aria-hidden /> : <ArrowUp className="no-print mb-px size-3 shrink-0" aria-hidden /> : null}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, r) => (
              <tr key={r}>
                {layout.columns.map((c) => {
                  const right = NUMERIC.has(c.type);
                  const currencyShown = !!c.currency_key && (textKeys.has(c.currency_key) || statedCurrencies.has(c.currency_key));
                  return (
                    <td key={c.key} style={{ textAlign: right ? 'right' : 'left' }} className={cn(right && 'num', !c.wrap && 'whitespace-nowrap', (c.type === 'date' || c.type === 'datetime') && 'num')}>
                      {c.wrap ? (
                        <span className="block" style={{ minWidth: c.minWidth }}>
                          {cell(c, row, currencyShown)}
                        </span>
                      ) : (
                        cell(c, row, currencyShown)
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total === 0 ? <p className="px-4 py-6 text-center text-[12.5px] text-ink-3">No rows — nothing was recorded in this period and selection that belongs in “{label}”.</p> : null}
      {printing ? (
        total > PRINT_ROWS ? (
          <p className="border-t border-line px-4 py-2 text-[12px] text-ink-3">
            First {fmtNumber(PRINT_ROWS)} of {fmtNumber(total)} rows — the full table is in the Excel and CSV downloads.
          </p>
        ) : null
      ) : total > SCREEN_PAGE ? (
        <Pagination page={current} pages={pages} total={total} pageSize={SCREEN_PAGE} onPage={setPage} className="no-print" />
      ) : null}
      {table.note ? <p className="border-t border-line px-4 py-2 text-[12px] leading-5 text-ink-3">{table.note}</p> : null}
    </div>
  );
}
