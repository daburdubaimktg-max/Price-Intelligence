/** Quick toggles above the monitor table. Counts come from the API facets and describe the whole scope. */
import { ArrowDown, ArrowUp, CircleDashed, Clock, Link2Off, PackageX, Tag, type LucideIcon } from 'lucide-react';
import type { MonitorFacets } from '@shared/api/analytics.ts';
import { cn } from '@/components/ui/primitives.tsx';
import { fmtNumber } from '@/lib/format.ts';

export type FacetKey = 'promo' | 'out_of_stock' | 'stale' | 'up' | 'down' | 'never' | 'unmatched';

interface ChipDef {
  key: FacetKey;
  label: string;
  icon: LucideIcon;
  count?: (f: MonitorFacets) => number;
  title: string;
}

const CHIPS: ChipDef[] = [
  { key: 'promo', label: 'On promotion', icon: Tag, count: (f) => f.on_promo, title: 'Listings whose latest observation shows a promotion' },
  { key: 'out_of_stock', label: 'Out of stock', icon: PackageX, count: (f) => f.out_of_stock, title: 'Listings last observed as out of stock' },
  { key: 'up', label: 'Increased in 24 h', icon: ArrowUp, count: (f) => f.increases_24h, title: 'Selling price went up in the last 24 hours' },
  { key: 'down', label: 'Decreased in 24 h', icon: ArrowDown, count: (f) => f.decreases_24h, title: 'Selling price went down in the last 24 hours' },
  { key: 'stale', label: 'Stale', icon: Clock, count: (f) => f.stale, title: 'No fresh observation within the expected collection window (includes never observed)' },
  { key: 'never', label: 'Never observed', icon: CircleDashed, count: (f) => f.never_observed, title: 'Listings that have no observation at all' },
  { key: 'unmatched', label: 'Include unmatched', icon: Link2Off, title: 'Also show retailer listings that are not matched to a catalogue product yet' },
];

export function FacetChips({ facets, active, onToggle }: { facets: MonitorFacets | undefined; active: Set<FacetKey>; onToggle: (key: FacetKey) => void }) {
  return (
    <div className="-mx-3 flex basis-[calc(100%+1.5rem)] gap-1.5 overflow-x-auto px-3 pb-1 sm:mx-0 sm:basis-full sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0" role="group" aria-label="Quick filters">
      {CHIPS.map((chip) => {
        const on = active.has(chip.key);
        const count = chip.count && facets ? chip.count(facets) : null;
        const idle = !on && count === 0;
        return (
          <button
            key={chip.key}
            type="button"
            aria-pressed={on}
            title={chip.title}
            disabled={idle}
            onClick={() => onToggle(chip.key)}
            className={cn(
              'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] font-medium whitespace-nowrap transition-colors',
              on ? 'border-navy bg-navy text-white' : 'border-line-strong bg-surface text-ink-2 hover:border-ink-4 hover:text-ink',
              idle && 'opacity-50 hover:border-line-strong hover:text-ink-2',
            )}
          >
            <chip.icon className="size-3" aria-hidden />
            {chip.label}
            {count !== null ? <span className={cn('num font-semibold', on ? 'text-white' : 'text-ink')}>{fmtNumber(count)}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
