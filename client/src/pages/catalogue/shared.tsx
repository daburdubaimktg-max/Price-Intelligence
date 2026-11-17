/** Helpers shared by the catalogue screens: mutation runner, status badges, taxonomy helpers and small form bits. */
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, CircleCheck, CirclePause, ExternalLink, type LucideIcon } from 'lucide-react';
import type { Column } from '@/components/ui/data-table.tsx';
import { useToast } from '@/components/ui/overlays.tsx';
import { Badge, cn } from '@/components/ui/primitives.tsx';
import { MANUAL_STALE_HOURS, staleAfterHours, type Frequency } from '@shared/constants.ts';
import type { CategoryRef, ListingRow, MappingRow, ProductStatus } from '@shared/api/catalogue.ts';

/** react-query key namespace of everything this section loads. */
export const CATALOGUE = 'catalogue';

export function errorMessage(error: unknown, fallback = 'Something went wrong'): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Runs a write, then refreshes every cached view (the catalogue feeds the monitor, analytics and pickers,
 * so all non-session queries are marked stale) and reports the outcome.
 */
export function useCatalogueActions() {
  const client = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const invalidate = useCallback(async () => {
    await client.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'auth' });
  }, [client]);

  const run = useCallback(
    async <T,>(
      key: string,
      fn: () => Promise<T>,
      options: { success?: string | ((result: T) => string | null | undefined); errorTitle?: string; quietError?: boolean } = {},
    ): Promise<{ ok: true; result: T } | { ok: false; error: unknown }> => {
      setBusy(key);
      try {
        const result = await fn();
        await invalidate();
        const message = typeof options.success === 'function' ? options.success(result) : options.success;
        if (message) toast.success(message);
        return { ok: true, result };
      } catch (error) {
        if (!options.quietError) toast.fromError(error, options.errorTitle ?? 'Could not save the change');
        return { ok: false, error };
      } finally {
        setBusy(null);
      }
    },
    [invalidate, toast],
  );

  return { run, busy, invalidate };
}

export function ProductStatusBadge({ status }: { status: ProductStatus }) {
  if (status === 'active') return <Badge tone="good" icon={CircleCheck}>Active</Badge>;
  if (status === 'inactive') return <Badge tone="neutral" icon={CirclePause}>Inactive</Badge>;
  return <Badge tone="outline" icon={Archive}>Archived</Badge>;
}

export function MappingStatusBadge({ status }: { status: MappingRow['status'] }) {
  if (status === 'approved') return <Badge tone="good">Approved</Badge>;
  if (status === 'suggested') return <Badge tone="accent">Suggested</Badge>;
  return <Badge tone="neutral">Rejected</Badge>;
}

/** Equivalent = genuinely like-for-like. Anything else is labelled NON-EQUIVALENT, never left ambiguous. */
export function EquivalenceBadge({ mapping }: { mapping: Pick<MappingRow, 'equivalence' | 'comparability'> }) {
  if (mapping.equivalence === 'equivalent') return <Badge tone="own">Equivalent</Badge>;
  return (
    <Badge tone="warn" title="Not like-for-like. Compared on unit price only, and labelled as non-equivalent wherever it is shown.">
      {mapping.comparability.same_dimension === false ? 'Non-equivalent — units differ' : 'Non-equivalent — unit price only'}
    </Badge>
  );
}

/** A navigation link that looks like the kit's small button (a real link: it can be opened in a new tab). */
export function LinkButton({ to, icon: Icon, children, variant = 'secondary', title }: { to: string; icon?: LucideIcon; children: ReactNode; variant?: 'primary' | 'secondary'; title?: string }) {
  return (
    <Link
      to={to}
      title={title}
      className={cn(
        'inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md border px-2.5 text-[12.5px] font-medium whitespace-nowrap transition-colors select-none',
        variant === 'primary' ? 'border-navy bg-navy text-white hover:bg-navy-hover' : 'border-line-strong bg-surface text-ink hover:border-ink-4 hover:bg-sunken',
      )}
    >
      {Icon ? <Icon className="size-3.5" aria-hidden /> : null}
      {children}
    </Link>
  );
}

/** Interactive content inside a clickable table row: keeps clicks and key presses from triggering the row. */
export function RowActions({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center justify-end gap-1', className)} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {children}
    </span>
  );
}

/** External link that shows the host and never navigates the app away. */
export function ExternalUrl({ url, className, label }: { url: string | null | undefined; className?: string; label?: string }) {
  if (!url) return <span className="text-ink-4">No URL</span>;
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* show the raw value */
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      title={url}
      onClick={(e) => e.stopPropagation()}
      className={cn('link inline-flex max-w-full items-center gap-1 text-[12.5px]', className)}
    >
      <span className="truncate">{label ?? host}</span>
      <ExternalLink className="size-3 shrink-0" aria-hidden />
    </a>
  );
}

export interface CategoryNode extends CategoryRef {
  children: CategoryRef[];
}

/** Two-level category tree from the flat reference list. */
export function categoryTree(categories: CategoryRef[] | undefined): CategoryNode[] {
  const list = categories ?? [];
  return list
    .filter((c) => c.parent_id === null)
    .map((c) => ({ ...c, children: list.filter((x) => x.parent_id === c.id).sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const PACK_UNIT_LABELS: Record<string, string> = { ml: 'ml', l: 'litres', g: 'g', kg: 'kg', unit: 'units' };

/** '' → null, otherwise a finite number or NaN (callers validate). */
export function parseNumber(text: string): number | null {
  const t = text.trim().replace(/,/g, '');
  if (!t) return null;
  return Number(t);
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Whether a listing's last observation is older than its source's schedule allows. */
export function listingIsStale(listing: Pick<ListingRow, 'last_observed_at' | 'collection_method' | 'collection_frequency'>, now = Date.now()): boolean {
  if (!listing.last_observed_at) return false;
  const limit =
    listing.collection_method === 'manual' || listing.collection_method === 'csv_import'
      ? MANUAL_STALE_HOURS
      : staleAfterHours(listing.collection_frequency as Frequency);
  return (now - Date.parse(listing.last_observed_at)) / 3_600_000 > limit;
}

export function pctChange(from: number | null | undefined, to: number | null | undefined): number | null {
  if (from === null || from === undefined || to === null || to === undefined || !(from > 0)) return null;
  return ((to - from) / from) * 100;
}

/** Simple checklist used for market availability and brand associations. */
export function CheckList({
  options,
  value,
  onChange,
  columns = 2,
  disabled,
}: {
  options: Array<{ value: number; label: string; hint?: string }>;
  value: number[];
  onChange: (next: number[]) => void;
  columns?: 1 | 2 | 3;
  disabled?: boolean;
}) {
  const selected = new Set(value);
  return (
    <div className={cn('grid gap-x-4 gap-y-1.5', columns === 3 ? 'sm:grid-cols-3' : columns === 2 ? 'sm:grid-cols-2' : '')}>
      {options.map((o) => (
        <label key={o.value} className="flex min-w-0 items-start gap-2 text-[13px] text-ink-2">
          <input
            type="checkbox"
            disabled={disabled}
            checked={selected.has(o.value)}
            onChange={(e) => onChange(e.target.checked ? [...value, o.value] : value.filter((v) => v !== o.value))}
            className="mt-[3px] size-3.5 shrink-0 rounded border-line-strong accent-[var(--color-navy)]"
          />
          <span className="min-w-0">
            <span className="block truncate text-ink">{o.label}</span>
            {o.hint ? <span className="block truncate text-[11.5px] text-ink-3">{o.hint}</span> : null}
          </span>
        </label>
      ))}
    </div>
  );
}

/**
 * Width of an element in px, kept current with a ResizeObserver (0 until it is mounted).
 * The catalogue tables choose their columns from the room their card really has: with the app shell's
 * sidebar, a viewport breakpoint says little about that.
 */
export function useElementWidth(): [(element: HTMLElement | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((element: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!element) return;
    const measure = () => setWidth(Math.round(element.getBoundingClientRect().width));
    measure();
    observer.current = new ResizeObserver(measure);
    observer.current.observe(element);
  }, []);
  return [ref, width];
}

/** A table column that is shown only when the table's container is at least `minWidth` px wide. */
export type FitColumn<T> = Column<T> & { minWidth?: number };

export function fitColumns<T>(columns: Array<FitColumn<T>>, width: number): Array<Column<T>> {
  return columns.filter((column) => !column.minWidth || width >= column.minWidth);
}
