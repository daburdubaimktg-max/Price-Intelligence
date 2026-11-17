/** The six report types as selectable cards. */
import { CalendarRange, Check, GitCompareArrows, Globe2, Package, Tag, TrendingUp, type LucideIcon } from 'lucide-react';
import { cn, Skeleton } from '@/components/ui/primitives.tsx';
import type { ReportDefinition, ReportType } from '@shared/api/reports.ts';

const ICONS: Record<ReportType, LucideIcon> = {
  weekly_competitor_pricing: GitCompareArrows,
  monthly_market_pricing: Globe2,
  brand_report: Tag,
  product_report: Package,
  promotion_analysis: CalendarRange,
  competitor_price_movement: TrendingUp,
};

const REQUIREMENT: Record<string, string> = { brand: 'Needs a brand', product: 'Needs a product' };

export function ReportPicker({ definitions, value, onChange }: { definitions: ReportDefinition[] | undefined; value: ReportType | null; onChange: (type: ReportType) => void }) {
  if (!definitions) {
    return (
      <div className="grid grid-cols-2 gap-2 sm:gap-3" aria-hidden>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-14 rounded-[10px] sm:h-[104px]" />
        ))}
      </div>
    );
  }
  return (
    <div role="radiogroup" aria-label="Report type" className="grid grid-cols-2 gap-2 sm:gap-3">
      {definitions.map((def) => {
        const Icon = ICONS[def.type] ?? TrendingUp;
        const on = def.type === value;
        const needs = def.required.map((r) => REQUIREMENT[r]).filter(Boolean);
        return (
          <button
            key={def.type}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(def.type)}
            className={cn(
              'sheet relative flex min-w-0 flex-col gap-1 px-3 py-2.5 text-left transition-colors sm:px-4 sm:py-3',
              on ? 'border-navy ring-1 ring-navy' : 'hover:border-ink-4',
            )}
          >
            <span className="flex items-start gap-2">
              <span className={cn('mt-px flex size-6 shrink-0 items-center justify-center rounded-md', on ? 'bg-navy text-white' : 'bg-wash text-ink-3')} aria-hidden>
                {on ? <Check className="size-3.5" strokeWidth={2.75} /> : <Icon className="size-3.5" />}
              </span>
              <span className="min-w-0 text-[13px] leading-[18px] font-semibold text-ink">{def.title}</span>
            </span>
            <span className="hidden text-[12px] leading-[17px] text-ink-3 sm:line-clamp-3">{def.description}</span>
            <span className="hidden items-center gap-2 text-[11.5px] text-ink-3 sm:flex">
              <span className="num">Default: last {def.default_days} days</span>
              {needs.length ? <span className="text-ink-2">· {needs.join(', ')}</span> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
