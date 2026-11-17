/**
 * Filter controls. One row of these sits above the content it scopes (never inside a chart card):
 * date range first, then dimensions.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarRange, Check, ChevronDown, Search, X } from 'lucide-react';
import { apiGet } from '@/lib/api.ts';
import { fmtDate } from '@/lib/format.ts';
import { addDays, useDebounced, type DateRange } from '@/lib/hooks.ts';
import type { ProductOption } from '@shared/api/catalogue.ts';
import { Popover } from './overlays.tsx';
import { Button, cn, Input, Spinner } from './primitives.tsx';

export interface Option {
  value: string;
  label: string;
  sublabel?: string;
  group?: string;
  /** Small marker rendered after the label (e.g. a DEMO tag). */
  tag?: ReactNode;
}

function TriggerButton({ label, value, active, onClear, className, icon }: { label: string; value?: ReactNode; active?: boolean; onClear?: () => void; className?: string; icon?: ReactNode }) {
  return (
    <span className={cn('inline-flex max-w-full', className)}>
      <span
        className={cn(
          'inline-flex h-[34px] max-w-full items-center gap-1.5 rounded-lg border bg-surface px-3 text-[13px] transition-colors',
          active ? 'border-navy/70 text-ink' : 'border-line-strong text-ink-2 hover:border-ink-4',
        )}
      >
        {icon}
        <span className="shrink-0 text-ink-3">{label}</span>
        {value ? <span className="min-w-0 truncate font-medium text-ink">{value}</span> : null}
        <ChevronDown className="size-3.5 shrink-0 text-ink-3" aria-hidden />
      </span>
      {active && onClear ? (
        // A span, not a <button>: this control sits inside the popover's trigger button, and a button
        // may not contain another button.
        <span
          role="button"
          tabIndex={0}
          aria-label={`Clear ${label}`}
          className="-ml-px inline-flex h-[34px] w-7 cursor-pointer items-center justify-center rounded-r-lg border border-l-0 border-navy/70 bg-surface text-ink-3 hover:text-ink"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onClear();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.stopPropagation();
              e.preventDefault();
              onClear();
            }
          }}
        >
          <X className="size-3" aria-hidden />
        </span>
      ) : null}
    </span>
  );
}

function OptionList({ options, selected, onToggle, emptyText = 'No matches' }: { options: Option[]; selected: Set<string>; onToggle: (value: string) => void; emptyText?: string }) {
  const groups = useMemo(() => {
    const map = new Map<string, Option[]>();
    for (const o of options) {
      const key = o.group ?? '';
      const list = map.get(key);
      if (list) list.push(o);
      else map.set(key, [o]);
    }
    return [...map.entries()];
  }, [options]);
  if (options.length === 0) return <p className="px-3 py-6 text-center text-[12.5px] text-ink-3">{emptyText}</p>;
  return (
    <div role="listbox" aria-multiselectable className="max-h-72 overflow-y-auto p-1">
      {groups.map(([group, list]) => (
        <div key={group}>
          {group ? <div className="eyebrow px-2.5 pt-2 pb-1">{group}</div> : null}
          {list.map((o) => {
            const on = selected.has(o.value);
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => onToggle(o.value)}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-wash"
              >
                <span className={cn('flex size-4 shrink-0 items-center justify-center rounded border', on ? 'border-navy bg-navy text-white' : 'border-line-strong bg-surface')}>
                  {on ? <Check className="size-3" strokeWidth={3} aria-hidden /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-ink">{o.label}</span>
                    {o.tag}
                  </span>
                  {o.sublabel ? <span className="block truncate text-[11.5px] text-ink-3">{o.sublabel}</span> : null}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Multi-select combobox for a dimension (markets, retailers, brands…). */
export function MultiSelect({
  label,
  options,
  value,
  onChange,
  searchable,
  single,
  className,
}: {
  label: string;
  options: Option[];
  value: string[];
  onChange: (next: string[]) => void;
  searchable?: boolean;
  /** Only one value may be selected. */
  single?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const selected = useMemo(() => new Set(value), [value]);
  const showSearch = searchable ?? options.length > 8;
  const filtered = useMemo(() => {
    const t = term.trim().toLowerCase();
    if (!t) return options;
    return options.filter((o) => o.label.toLowerCase().includes(t) || o.sublabel?.toLowerCase().includes(t));
  }, [options, term]);
  const summary = value.length === 0 ? undefined : value.length === 1 ? (options.find((o) => o.value === value[0])?.label ?? '1 selected') : `${value.length} selected`;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setTerm('');
      }}
      trigger={
        <button type="button" className={cn('max-w-full text-left', className)} aria-haspopup="listbox">
          <TriggerButton label={label} value={summary} active={value.length > 0} onClear={() => onChange([])} />
        </button>
      }
    >
      {showSearch ? (
        <div className="border-b border-line p-2">
          <Input autoFocus placeholder={`Search ${label.toLowerCase()}…`} value={term} onChange={(e) => setTerm(e.target.value)} />
        </div>
      ) : null}
      <OptionList
        options={filtered}
        selected={selected}
        onToggle={(v) => {
          if (single) {
            onChange(selected.has(v) ? [] : [v]);
            setOpen(false);
          } else {
            onChange(selected.has(v) ? value.filter((x) => x !== v) : [...value, v]);
          }
        }}
      />
      {!single && value.length > 0 ? (
        <div className="flex items-center justify-between border-t border-line px-3 py-2 text-[12px] text-ink-3">
          <span>{value.length} selected</span>
          <button type="button" className="link" onClick={() => onChange([])}>
            Clear
          </button>
        </div>
      ) : null}
    </Popover>
  );
}

/** Product picker backed by the catalogue typeahead (the catalogue can be large). */
export function ProductPicker({
  label = 'Product',
  value,
  onChange,
  ownership,
  multiple = true,
  className,
}: {
  label?: string;
  value: string[];
  onChange: (next: string[], picked?: ProductOption) => void;
  ownership?: 'own' | 'competitor';
  multiple?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const debounced = useDebounced(term, 200);
  const search = useQuery({
    queryKey: ['product-options', debounced, ownership ?? ''],
    queryFn: () => apiGet<{ rows: ProductOption[] }>('/products/options', { q: debounced, ownership, limit: 40 }),
    enabled: open,
    staleTime: 30_000,
  });
  const chosen = useQuery({
    queryKey: ['product-options', 'ids', value.join(',')],
    queryFn: () => apiGet<{ rows: ProductOption[] }>('/products/options', { ids: value.join(','), limit: 100 }),
    enabled: value.length > 0,
    staleTime: 60_000,
  });
  const selected = useMemo(() => new Set(value), [value]);
  const rows = search.data?.rows ?? [];
  const toOption = (p: ProductOption): Option => ({
    value: String(p.id),
    label: p.name,
    sublabel: `${p.brand_name} · ${p.code}`,
    group: p.ownership === 'own' ? 'Own brands' : 'Competitors',
  });
  const summary =
    value.length === 0 ? undefined : value.length === 1 ? (chosen.data?.rows.find((p) => String(p.id) === value[0])?.name ?? '1 selected') : `${value.length} selected`;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setTerm('');
      }}
      className="w-96"
      trigger={
        <button type="button" className={cn('max-w-full text-left', className)} aria-haspopup="listbox">
          <TriggerButton label={label} value={summary} active={value.length > 0} onClear={() => onChange([])} />
        </button>
      }
    >
      <div className="relative border-b border-line p-2">
        <Input autoFocus placeholder="Search name, code, SKU or barcode…" value={term} onChange={(e) => setTerm(e.target.value)} />
        {search.isFetching ? <Spinner className="absolute top-1/2 right-4 -translate-y-1/2" /> : null}
      </div>
      <OptionList
        options={rows.map(toOption)}
        selected={selected}
        emptyText={search.isPending ? 'Searching…' : 'No products match'}
        onToggle={(v) => {
          const picked = rows.find((p) => String(p.id) === v);
          if (!multiple) {
            onChange(selected.has(v) ? [] : [v], picked);
            setOpen(false);
          } else {
            onChange(selected.has(v) ? value.filter((x) => x !== v) : [...value, v], picked);
          }
        }}
      />
    </Popover>
  );
}

export type DatePreset = 'today' | 'yesterday' | '7d' | '30d' | '90d' | 'mtd' | 'all';
const PRESET_LABELS: Record<DatePreset, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  mtd: 'Month to date',
  all: 'All time',
};

export function presetRange(preset: DatePreset, today: string): Partial<DateRange> {
  // "today" comes from the server; until it has loaded no preset can be resolved.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today ?? '')) return {};
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case '7d':
      return { from: addDays(today, -6), to: today };
    case '30d':
      return { from: addDays(today, -29), to: today };
    case '90d':
      return { from: addDays(today, -89), to: today };
    case 'mtd':
      return { from: `${today.slice(0, 8)}01`, to: today };
    case 'all':
      return {};
  }
}

/** Finds the preset that produces exactly this range, if any. */
export function matchPreset(range: Partial<DateRange>, today: string, presets: DatePreset[]): DatePreset | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today ?? '')) return null;
  for (const p of presets) {
    const r = presetRange(p, today);
    if ((r.from ?? '') === (range.from ?? '') && (r.to ?? '') === (range.to ?? '')) return p;
  }
  return null;
}

/** Date range: presets as rows, custom range in the footer. */
export function DateRangePicker({
  value,
  onChange,
  today,
  presets = ['today', '7d', '30d', '90d', 'mtd', 'all'],
  label = 'Dates',
  min,
}: {
  value: Partial<DateRange>;
  onChange: (next: Partial<DateRange>) => void;
  today: string;
  presets?: DatePreset[];
  label?: string;
  min?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(value.from ?? '');
  const [to, setTo] = useState(value.to ?? '');
  useEffect(() => {
    setFrom(value.from ?? '');
    setTo(value.to ?? '');
  }, [value.from, value.to]);
  const active = matchPreset(value, today, presets);
  const summary = active ? PRESET_LABELS[active] : value.from || value.to ? `${value.from ? fmtDate(value.from) : 'Start'} – ${value.to ? fmtDate(value.to) : 'Latest'}` : 'All time';
  const invalid = !!from && !!to && from > to;
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      className="w-72"
      trigger={
        <button type="button" className="max-w-full text-left" aria-haspopup="dialog">
          <TriggerButton label={label} value={summary} icon={<CalendarRange className="size-3.5 text-ink-3" aria-hidden />} />
        </button>
      }
    >
      <div className="p-1">
        {presets.map((p) => (
          <button
            key={p}
            type="button"
            className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink hover:bg-wash"
            onClick={() => {
              onChange(presetRange(p, today));
              setOpen(false);
            }}
          >
            {PRESET_LABELS[p]}
            {active === p ? <Check className="size-4 text-ink" strokeWidth={2.75} aria-hidden /> : null}
          </button>
        ))}
      </div>
      <form
        className="border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (invalid) return;
          onChange({ from: from || undefined, to: to || undefined });
          setOpen(false);
        }}
      >
        <div className="eyebrow mb-2">Custom range</div>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-[11.5px] text-ink-3">
            From
            <Input type="date" value={from} min={min ?? undefined} max={to || today} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-[11.5px] text-ink-3">
            To
            <Input type="date" value={to} min={from || min || undefined} max={today} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
        {invalid ? <p className="mt-2 text-[12px] text-crit-ink">The start date is after the end date.</p> : null}
        <Button type="submit" variant="primary" size="sm" className="mt-3 w-full" disabled={invalid}>
          Apply range
        </Button>
      </form>
    </Popover>
  );
}

/** Search box that reports its value after typing pauses. */
export function SearchInput({ value, onChange, placeholder = 'Search…', className, delay = 300 }: { value: string; onChange: (next: string) => void; placeholder?: string; className?: string; delay?: number }) {
  const [text, setText] = useState(value);
  // Text typed by the user that has not been reported yet. Only this is ever emitted, so a stale debounced
  // value can never overwrite a change that came from outside (Reset, browser back).
  const pending = useRef<string | null>(null);
  const seen = useRef(value);
  useEffect(() => {
    if (value !== seen.current) {
      seen.current = value;
      pending.current = null;
      setText(value);
    }
  }, [value]);
  const debounced = useDebounced(text, delay);
  useEffect(() => {
    if (pending.current === null || debounced !== pending.current) return;
    pending.current = null;
    if (debounced !== seen.current) {
      seen.current = debounced;
      onChange(debounced);
    }
  }, [debounced, onChange]);
  return (
    <span className={cn('relative inline-flex w-56 max-w-full', className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" aria-hidden />
      <Input
        type="search"
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          pending.current = e.target.value;
          setText(e.target.value);
        }}
        className="pl-8"
        aria-label={placeholder}
      />
    </span>
  );
}

/** The single filter row above a view. */
export function FilterBar({ children, onReset, activeCount = 0, trailing, className }: { children: ReactNode; onReset?: () => void; activeCount?: number; trailing?: ReactNode; className?: string }) {
  return (
    <div className={cn('no-print mb-4 flex flex-wrap items-center gap-2', className)} role="group" aria-label="Filters">
      {children}
      {onReset && activeCount > 0 ? (
        <Button variant="ghost" size="md" icon={X} onClick={onReset}>
          Reset
        </Button>
      ) : null}
      {trailing ? <div className="ml-auto flex flex-wrap items-center gap-2">{trailing}</div> : null}
    </div>
  );
}
