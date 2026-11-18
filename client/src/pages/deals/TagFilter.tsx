/**
 * Deal-specific quick filters: one toggle per tag (with the number of deals carrying it) and a few switches.
 * Tag counts come from the API with every filter applied except the tag filter itself, so the numbers stay
 * put while a tag is selected.
 */
import type { LucideIcon } from 'lucide-react';
import { dealTagDescription, dealTagIcon, dealTagKeys, dealTagKind, dealTagLabel } from '@/components/domain/signals.tsx';
import { cn } from '@/components/ui/primitives.tsx';
import { fmtNumber } from '@/lib/format.ts';

const CHIP = 'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] font-medium whitespace-nowrap transition-colors';

export function ToggleChip({ on, onToggle, label, icon: Icon, count, title, disabled }: { on: boolean; onToggle: () => void; label: string; icon?: LucideIcon; count?: number | null; title?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        CHIP,
        on ? 'border-navy bg-navy text-white' : 'border-line-strong bg-surface text-ink-2 hover:border-ink-4 hover:text-ink',
        disabled && 'opacity-50 hover:border-line-strong hover:text-ink-2',
      )}
    >
      {Icon ? <Icon className="size-3" aria-hidden /> : null}
      {label}
      {count !== null && count !== undefined ? <span className={cn('num font-semibold', on ? 'text-white' : 'text-ink')}>{fmtNumber(count)}</span> : null}
    </button>
  );
}

export function TagFilterChips({ counts, selected, onToggle, loading }: { counts: Partial<Record<string, number>> | undefined; selected: string[]; onToggle: (tag: string) => void; loading?: boolean }) {
  // offer tags always have a chip (so the row does not jump while filtering); badges only when they occur
  const keys = dealTagKeys(selected).filter((tag) => dealTagKind(tag) === 'offer' || (counts?.[tag] ?? 0) > 0 || selected.includes(tag));
  const offers = keys.filter((tag) => dealTagKind(tag) === 'offer');
  const badges = keys.filter((tag) => dealTagKind(tag) !== 'offer');
  const chip = (tag: string) => {
    const on = selected.includes(tag);
    const count = counts ? (counts[tag] ?? 0) : null;
    return (
      <ToggleChip
        key={tag}
        on={on}
        onToggle={() => onToggle(tag)}
        label={dealTagLabel(tag, true)}
        icon={dealTagIcon(tag)}
        count={count}
        disabled={!on && count === 0}
        title={[dealTagLabel(tag), dealTagDescription(tag)].filter(Boolean).join(' — ')}
      />
    );
  };
  return (
    <div
      className={cn('flex items-center gap-1.5 overflow-x-auto px-3 pb-1 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0', loading && 'opacity-70')}
      role="group"
      aria-label="Filter by deal tag"
    >
      <span className="eyebrow shrink-0 pr-0.5">Offer tags</span>
      {offers.map(chip)}
      {badges.length ? (
        <>
          <span className="eyebrow shrink-0 pr-0.5 pl-2">Badges</span>
          {badges.map(chip)}
        </>
      ) : null}
    </div>
  );
}
