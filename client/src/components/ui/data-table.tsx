/** Compact data table with server-side sorting, responsive column hiding and pagination. */
import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown } from 'lucide-react';
import { fmtNumber } from '@/lib/format.ts';
import { cn, EmptyState, IconButton, LoadingBlock } from './primitives.tsx';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T, index: number) => ReactNode;
  align?: 'left' | 'right' | 'center';
  /** Server sort key. Clicking the header toggles `key` ↔ `-key`. */
  sortKey?: string;
  width?: string;
  /** Hide the column below this breakpoint (keeps tables usable on phones). */
  hideBelow?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  headerTitle?: string;
  /** Keep the cell on one line. Default true for numeric (right-aligned) columns. */
  nowrap?: boolean;
}

const HIDE: Record<NonNullable<Column<unknown>['hideBelow']>, string> = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
  xl: 'hidden xl:table-cell',
};

export interface DataTableProps<T> {
  columns: Array<Column<T>>;
  rows: T[] | undefined;
  rowKey: (row: T, index: number) => string | number;
  sort?: string;
  onSort?: (sort: string) => void;
  onRowClick?: (row: T) => void;
  selectedKey?: string | number | null;
  loading?: boolean;
  /** True while new data is being fetched and the previous rows are still shown. */
  refetching?: boolean;
  empty?: ReactNode;
  dense?: boolean;
  /** Constrains the height and scrolls the body under a sticky header. */
  maxHeight?: number | string;
  className?: string;
  rowClassName?: (row: T) => string | undefined;
  footer?: ReactNode;
}

export function DataTable<T>({
  columns, rows, rowKey, sort, onSort, onRowClick, selectedKey, loading, refetching, empty, dense, maxHeight, className, rowClassName, footer,
}: DataTableProps<T>) {
  const sortKey = sort?.replace(/^-/, '');
  const desc = sort?.startsWith('-') ?? false;
  const showLoading = loading && !rows?.length;
  return (
    <div className={cn('min-w-0', className)}>
      <div className="table-wrap" style={maxHeight ? { maxHeight, overflowY: 'auto' } : undefined}>
        <table className={cn('grid-table', dense && 'is-dense', refetching && 'opacity-60 transition-opacity')}>
          <thead>
            <tr>
              {columns.map((col) => {
                const active = col.sortKey && col.sortKey === sortKey;
                const sortable = !!col.sortKey && !!onSort;
                return (
                  <th
                    key={col.key}
                    scope="col"
                    title={col.headerTitle}
                    style={{ width: col.width, textAlign: col.align ?? 'left' }}
                    className={cn(col.hideBelow && HIDE[col.hideBelow])}
                    aria-sort={active ? (desc ? 'descending' : 'ascending') : undefined}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        className={cn('inline-flex items-center gap-1 uppercase hover:text-ink', col.align === 'right' && 'flex-row-reverse', active && 'text-ink')}
                        onClick={() => onSort!(active && !desc ? `-${col.sortKey}` : active && desc ? col.sortKey! : col.align === 'right' ? `-${col.sortKey}` : col.sortKey!)}
                      >
                        {col.header}
                        {active ? desc ? <ArrowDown className="size-3" aria-hidden /> : <ArrowUp className="size-3" aria-hidden /> : <ChevronsUpDown className="size-3 opacity-40" aria-hidden />}
                      </button>
                    ) : (
                      col.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((row, index) => {
              const key = rowKey(row, index);
              return (
                <tr
                  key={key}
                  className={cn(onRowClick && 'is-clickable', selectedKey !== undefined && selectedKey !== null && selectedKey === key && 'is-selected', rowClassName?.(row))}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          // Only when the row itself has focus: Enter / Space on a button or link inside it belongs to that control.
                          if (e.target !== e.currentTarget) return;
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onRowClick(row);
                          }
                        }
                      : undefined
                  }
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      style={{ textAlign: col.align ?? 'left' }}
                      className={cn(col.hideBelow && HIDE[col.hideBelow], (col.nowrap ?? col.align === 'right') && 'whitespace-nowrap', col.align === 'right' && 'num', col.className)}
                    >
                      {col.cell(row, index)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {showLoading ? <LoadingBlock /> : null}
      {!showLoading && rows && rows.length === 0 ? (empty ?? <EmptyState title="Nothing to show" description="No records match the current filters." />) : null}
      {footer}
    </div>
  );
}

export function Pagination({
  page,
  pages,
  total,
  pageSize,
  onPage,
  className,
  noun = 'rows',
}: {
  page: number;
  pages: number;
  total: number;
  pageSize: number;
  onPage: (page: number) => void;
  className?: string;
  noun?: string;
}) {
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-[12.5px] text-ink-3', className)}>
      <span className="num">
        {fmtNumber(from)}–{fmtNumber(to)} of {fmtNumber(total)} {noun}
      </span>
      <span className="flex items-center gap-1">
        <IconButton icon={ChevronLeft} label="Previous page" size="sm" variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)} />
        <span className="num px-2">
          Page {fmtNumber(page)} of {fmtNumber(pages)}
        </span>
        <IconButton icon={ChevronRight} label="Next page" size="sm" variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)} />
      </span>
    </div>
  );
}
