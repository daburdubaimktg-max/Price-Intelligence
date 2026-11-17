/** Small local building blocks shared by the Historical Price Explorer and Competitor Intelligence screens. */
import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { fmtPct, fmtPrice, fmtUnitPrice } from '@/lib/format.ts';
import { useReference } from '@/lib/hooks.ts';
import { Popover } from '@/components/ui/overlays.tsx';
import { Button, cn, Field, Input, Select } from '@/components/ui/primitives.tsx';
import { SERIES_COLORS } from '@/components/charts/kit.tsx';
import { DATA_CLASSES, DATA_CLASS_LABELS, type DataClass } from '@shared/constants.ts';
import type { Metric } from '@shared/api/analytics.ts';

/** Heading of a page section with its own controls on the right. */
export function SectionHeader({ title, subtitle, controls, className }: { title: ReactNode; subtitle?: ReactNode; controls?: ReactNode; className?: string }) {
  return (
    <div className={cn('mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2', className)}>
      <div className="min-w-0">
        <h2 className="text-[15px] leading-6 font-semibold text-ink">{title}</h2>
        {subtitle ? <p className="mt-0.5 max-w-3xl text-[12.5px] leading-5 text-ink-3">{subtitle}</p> : null}
      </div>
      {controls ? <div className="no-print flex max-w-full flex-wrap items-center gap-2">{controls}</div> : null}
    </div>
  );
}

/** Compact labelled native select for card-level options. */
export function InlineSelect<T extends string>({
  label,
  value,
  onChange,
  options,
  width = 'w-40',
}: {
  label: string;
  value: T;
  onChange: (next: T) => void;
  options: Array<{ value: T; label: string }>;
  width?: string;
}) {
  return (
    <label className="inline-flex max-w-full items-center gap-1.5 text-[12.5px] text-ink-3">
      <span className="shrink-0">{label}</span>
      <span className={cn('inline-block max-w-full', width)}>
        <Select value={value} onChange={(e) => onChange(e.target.value as T)} aria-label={label}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </span>
    </label>
  );
}

/**
 * Currency mode for anything that puts several markets side by side:
 * native (each market in its own currency, never drawn on one axis) or converted to one currency.
 */
export function CurrencySelect({ value, onChange, reportingCurrency, label = 'Currency' }: { value: string; onChange: (next: string) => void; reportingCurrency: string; label?: string }) {
  const { ref } = useReference();
  const others = (ref?.currencies ?? []).filter((c) => c.code !== reportingCurrency);
  const resolved = value === reportingCurrency ? 'reporting' : value;
  return (
    <InlineSelect
      label={label}
      value={resolved}
      onChange={onChange}
      width="w-48"
      options={[
        { value: 'native', label: 'Native (per market)' },
        { value: 'reporting', label: `${reportingCurrency} — reporting currency` },
        ...others.map((c) => ({ value: c.code, label: `${c.code} — ${c.name}` })),
      ]}
    />
  );
}

/** A labelled figure without its own frame (for rows of facts inside a card). */
export function Fact({ label, value, detail }: { label: ReactNode; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[12px] leading-4 font-medium text-ink-3">{label}</div>
      <div className="mt-0.5 text-[18px] leading-6 font-semibold tracking-[-0.01em] text-ink">{value}</div>
      {detail ? <div className="truncate text-[11.5px] leading-4 text-ink-3">{detail}</div> : null}
    </div>
  );
}

/** Count / fact chip used in summary rows. */
export function Chip({ label, value, tone = 'neutral' }: { label: ReactNode; value: ReactNode; tone?: 'neutral' | 'up' | 'down' }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 rounded-lg border border-line bg-sunken px-2.5 py-1 text-[12.5px] leading-5">
      <span className={cn('num font-semibold', tone === 'up' ? 'text-crit-ink' : tone === 'down' ? 'text-good-ink' : 'text-ink')}>{value}</span>
      <span className="text-ink-3">{label}</span>
    </span>
  );
}

/** Formats a metric value: money in the series' currency, unit price, or a percentage. */
export function metricFormatter(metric: Metric, currency: string | null): (value: number) => string {
  if (metric === 'discount') return (v) => fmtPct(v, 1);
  if (metric === 'unit_price') return (v) => fmtUnitPrice(v, currency);
  return (v) => fmtPrice(v, currency);
}

export const METRIC_LABELS: Record<Metric, string> = {
  price: 'Selling price',
  unit_price: 'Unit price',
  regular_price: 'Regular (list) price',
  discount: 'Discount %',
};

export const GROUP_LABELS = {
  listing: 'Listing (product at a retailer)',
  product: 'Product',
  retailer: 'Retailer',
  brand: 'Brand',
  market: 'Market',
  category: 'Category',
  ownership: 'Own brands vs competitors',
} as const;

/** Identity colours of the four data source classes (categorical slots in fixed order). */
export const DATA_CLASS_COLORS: Record<DataClass, string> = {
  collected: SERIES_COLORS[0],
  imported: SERIES_COLORS[1],
  manual: SERIES_COLORS[2],
  simulated: SERIES_COLORS[3],
};
export const dataClassParts = (rows: Array<{ data_class: string; observations: number }>) =>
  DATA_CLASSES.map((dc) => ({ key: dc, label: DATA_CLASS_LABELS[dc], value: rows.find((r) => r.data_class === dc)?.observations ?? 0, color: DATA_CLASS_COLORS[dc] }));

/** Price range filter (minimum / maximum selling price, in each listing's own currency). */
export function PriceRangeFilter({ min, max, onChange }: { min: string | undefined; max: string | undefined; onChange: (next: { min?: string; max?: string }) => void }) {
  const [open, setOpen] = useState(false);
  const [lo, setLo] = useState(min ?? '');
  const [hi, setHi] = useState(max ?? '');
  useEffect(() => {
    setLo(min ?? '');
    setHi(max ?? '');
  }, [min, max]);
  const active = !!min || !!max;
  const invalid = lo !== '' && hi !== '' && Number(lo) > Number(hi);
  const summary = active ? `${min || '0'} – ${max || 'any'}` : undefined;
  return (
    <span className="inline-flex max-w-full">
      <Popover
        open={open}
        onOpenChange={setOpen}
        className="w-72"
        trigger={
          <button
            type="button"
            aria-haspopup="dialog"
            className={cn(
              'inline-flex h-[34px] max-w-full items-center gap-1.5 border bg-surface px-3 text-left text-[13px] transition-colors',
              active ? 'rounded-l-lg border-navy/70 text-ink' : 'rounded-lg border-line-strong text-ink-2 hover:border-ink-4',
            )}
          >
            <span className="shrink-0 text-ink-3">Price</span>
            {summary ? <span className="num min-w-0 truncate font-medium text-ink">{summary}</span> : null}
            <ChevronDown className="size-3.5 shrink-0 text-ink-3" aria-hidden />
          </button>
        }
      >
        <form
          className="p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (invalid) return;
            onChange({ min: lo || undefined, max: hi || undefined });
            setOpen(false);
          }}
        >
          <div className="eyebrow mb-2">Selling price range</div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Minimum">
              <Input type="number" inputMode="decimal" min="0" step="any" value={lo} onChange={(e) => setLo(e.target.value)} placeholder="0" />
            </Field>
            <Field label="Maximum">
              <Input type="number" inputMode="decimal" min="0" step="any" value={hi} onChange={(e) => setHi(e.target.value)} placeholder="any" />
            </Field>
          </div>
          <p className="mt-2 text-[12px] leading-4 text-ink-3">Applies to the selling price in each listing's own currency — combine it with a market filter.</p>
          {invalid ? <p className="mt-2 text-[12px] text-crit-ink">The minimum is above the maximum.</p> : null}
          <Button type="submit" variant="primary" size="sm" className="mt-3 w-full" disabled={invalid}>
            Apply
          </Button>
        </form>
      </Popover>
      {active ? (
        <button
          type="button"
          aria-label="Clear price range"
          className="-ml-px inline-flex h-[34px] w-7 items-center justify-center rounded-r-lg border border-navy/70 bg-surface text-ink-3 hover:text-ink"
          onClick={() => onChange({})}
        >
          <X className="size-3" aria-hidden />
        </button>
      ) : null}
    </span>
  );
}

/** True while a query shows previous data during a refetch. */
export const isRefetching = (q: { isPlaceholderData: boolean; isFetching: boolean; isPending: boolean }) => q.isPlaceholderData || (q.isFetching && !q.isPending);
