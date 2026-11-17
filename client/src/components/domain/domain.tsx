/**
 * Domain building blocks used on every screen: provenance badges (collected / imported / manual / simulated),
 * the DEMO marker, price and change cells, availability, confidence, product identity and market-local time.
 */
import { type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  ArrowDown, ArrowUp, BadgeCheck, Ban, CircleDashed, CircleHelp, FileSpreadsheet, FlaskConical, Hand, Minus, PackageX, Radio, Tag, type LucideIcon,
} from 'lucide-react';
import {
  AVAILABILITY_LABELS, COLLECTION_METHOD_LABELS, confidenceBand, DATA_CLASS_LABELS, FREQUENCY_LABELS, PROMO_TYPE_LABELS,
  type Availability, type CollectionMethod, type DataClass, type Frequency, type PromoType,
} from '@shared/constants.ts';
import { formatPack, unitBasisLabel } from '@shared/units.ts';
import { DASH, fmtDateTime, fmtDateTimeShort, fmtMoney, fmtPct, fmtPrice, fmtRelative, fmtUnitPrice, initials, tzLabel } from '@/lib/format.ts';
import { Badge, cn, Notice, Tip, type BadgeTone } from '../ui/primitives.tsx';
import type { Conversion } from '@shared/api/analytics.ts';

// ---------------------------------------------------------------------------------------------
// Provenance — how an observation entered the system. These four classes are never visually confused.
// ---------------------------------------------------------------------------------------------
const DATA_CLASS_META: Record<DataClass, { icon: LucideIcon; tone: BadgeTone; hint: string }> = {
  collected: { icon: Radio, tone: 'good', hint: 'Captured by a configured real integration (API, feed, permitted extraction or third-party provider).' },
  imported: { icon: FileSpreadsheet, tone: 'accent', hint: 'Imported from a CSV or Excel file, with its original observation date.' },
  manual: { icon: Hand, tone: 'neutral', hint: 'Entered by a person.' },
  simulated: { icon: FlaskConical, tone: 'demo', hint: 'Simulated demonstration data. Not a real market observation.' },
};

export function DataClassBadge({ value, short }: { value: DataClass | string | null | undefined; short?: boolean }) {
  if (!value || !(value in DATA_CLASS_META)) return <span className="text-ink-4">{DASH}</span>;
  const meta = DATA_CLASS_META[value as DataClass];
  const label = DATA_CLASS_LABELS[value as DataClass];
  return (
    <Tip content={meta.hint}>
      <span className="inline-flex">
        <Badge tone={meta.tone} icon={meta.icon}>
          {short ? label.replace(' (real)', '').replace(' history', '').replace(' entry', '').replace(' demo', '') : label}
        </Badge>
      </span>
    </Tip>
  );
}

/** The DEMO stamp. Shown next to any record that belongs to the illustrative demo dataset. */
export function DemoBadge({ className }: { className?: string }) {
  return (
    <Tip content="Illustrative demo data — fictional, not a market observation.">
      <span className={cn('inline-flex', className)}>
        <Badge tone="demo">DEMO</Badge>
      </span>
    </Tip>
  );
}

/** Banner for a view whose figures include demo data. Renders nothing when there is none. */
export function DemoNotice({ demo, className }: { demo: { any_demo: boolean; all_demo: boolean; demo_rows?: number; total_rows?: number } | null | undefined; className?: string }) {
  if (!demo?.any_demo) return null;
  return (
    <Notice tone="demo" icon={FlaskConical} className={className}>
      {demo.all_demo ? (
        <>
          <strong className="font-semibold text-ink">Demo data.</strong> Every figure in this view comes from the illustrative demo dataset — prices are fictional.
        </>
      ) : (
        <>
          <strong className="font-semibold text-ink">Includes demo data.</strong> Part of this view comes from the illustrative demo dataset; those rows carry a DEMO marker.
        </>
      )}
    </Notice>
  );
}

export function MethodLabel({ method }: { method: CollectionMethod | string | null | undefined }) {
  if (!method) return <span className="text-ink-4">{DASH}</span>;
  return <>{COLLECTION_METHOD_LABELS[method as CollectionMethod] ?? method}</>;
}

export function FrequencyLabel({ frequency }: { frequency: Frequency | string | null | undefined }) {
  if (!frequency) return <span className="text-ink-4">{DASH}</span>;
  return <>{FREQUENCY_LABELS[frequency as Frequency] ?? frequency}</>;
}

// ---------------------------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------------------------
export function OwnershipBadge({ ownership }: { ownership: 'own' | 'competitor' | 'mixed' | null | undefined }) {
  if (ownership === 'own') return <Badge tone="own">Own</Badge>;
  if (ownership === 'competitor') return <Badge tone="comp">Competitor</Badge>;
  if (ownership === 'mixed') return <Badge tone="neutral">Mixed</Badge>;
  return <Badge tone="outline">Unmatched</Badge>;
}

/** Small coloured dot + text: identity for own vs competitor without colouring the text itself. */
export function OwnershipDot({ ownership, className }: { ownership: 'own' | 'competitor' | null | undefined; className?: string }) {
  return (
    <span
      aria-label={ownership === 'own' ? 'Own brand' : ownership === 'competitor' ? 'Competitor' : 'Unmatched'}
      title={ownership === 'own' ? 'Own brand' : ownership === 'competitor' ? 'Competitor' : 'Unmatched'}
      className={cn('inline-block size-2 shrink-0 rounded-full', ownership === 'own' ? 'bg-own' : ownership === 'competitor' ? 'bg-comp' : 'bg-ink-4', className)}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Product identity
// ---------------------------------------------------------------------------------------------
export function ProductCell({
  name,
  brand,
  pack,
  ownership,
  productId,
  code,
  isDemo,
  variant,
  imageUrl,
  compact,
}: {
  name: string | null | undefined;
  brand?: string | null;
  pack?: string | null;
  ownership?: 'own' | 'competitor' | null;
  productId?: number | null;
  code?: string | null;
  isDemo?: boolean | number | null;
  variant?: string | null;
  imageUrl?: string | null;
  compact?: boolean;
}) {
  const title = name ?? 'Unmatched listing';
  const body = (
    <span className="flex min-w-0 items-center gap-2.5">
      {!compact ? (
        imageUrl ? (
          <img src={imageUrl} alt="" loading="lazy" className="size-7 shrink-0 rounded-md border border-line object-cover" />
        ) : (
          <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold', ownership === 'own' ? 'bg-own-soft text-own-ink' : ownership === 'competitor' ? 'bg-comp-soft text-comp-ink' : 'bg-wash text-ink-3')} aria-hidden>
            {initials(brand ?? name ?? '?')}
          </span>
        )
      ) : (
        <OwnershipDot ownership={ownership ?? null} />
      )}
      <span className="min-w-0">
        <span className="flex items-center gap-1.5">
          <span className={cn('truncate font-medium text-ink', productId && 'group-hover:underline')}>{title}</span>
          {isDemo ? <DemoBadge /> : null}
        </span>
        <span className="block truncate text-[11.5px] leading-4 text-ink-3">
          {[brand, variant ?? pack, code].filter(Boolean).join(' · ') || DASH}
        </span>
      </span>
    </span>
  );
  if (productId) {
    return (
      <Link to={`/catalogue/products/${productId}`} className="group block min-w-0" onClick={(e) => e.stopPropagation()}>
        {body}
      </Link>
    );
  }
  return body;
}

export function packText(row: { pack_size: number | null; pack_unit: string | null; units_per_pack?: number | null }): string {
  return formatPack(row.pack_size, row.pack_unit, row.units_per_pack ?? 1);
}

// ---------------------------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------------------------
/** Selling price with the regular price struck through when on promotion. */
export function PriceCell({ price, regular, currency, isPromo, showCurrency = true, className }: { price: number | null | undefined; regular?: number | null; currency: string | null | undefined; isPromo?: boolean | number | null; showCurrency?: boolean; className?: string }) {
  if (price === null || price === undefined) return <span className="text-ink-4">{DASH}</span>;
  const struck = isPromo && regular !== null && regular !== undefined && regular > price;
  return (
    <span className={cn('num inline-flex items-baseline justify-end gap-1.5 whitespace-nowrap', className)}>
      {struck ? <span className="text-[11.5px] text-ink-4 line-through">{fmtPrice(regular, currency)}</span> : null}
      <span className="font-medium text-ink">{fmtPrice(price, currency)}</span>
      {showCurrency && currency ? <span className="text-[11px] text-ink-3">{currency}</span> : null}
    </span>
  );
}

export function UnitPriceCell({ value, currency, dimension }: { value: number | null | undefined; currency: string | null | undefined; dimension?: string | null }) {
  if (value === null || value === undefined) return <span className="text-ink-4">{DASH}</span>;
  const basis = unitBasisLabel(dimension as never);
  return (
    <span className="num whitespace-nowrap text-ink-2">
      {fmtUnitPrice(value, currency)}
      {basis ? <span className="ml-1 text-[11px] text-ink-3">{basis.replace('per ', '/')}</span> : null}
    </span>
  );
}

/**
 * % change with an arrow. Price drops read green and increases red (the shopper's convention);
 * the arrow and the sign always carry the direction so colour is never the only cue.
 */
export function ChangeCell({ pct, className, neutral }: { pct: number | null | undefined; className?: string; neutral?: boolean }) {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return <span className="text-ink-4">{DASH}</span>;
  const flat = Math.abs(pct) < 0.05;
  const up = pct > 0;
  const Icon = flat ? Minus : up ? ArrowUp : ArrowDown;
  return (
    <span className={cn('num inline-flex items-center justify-end gap-0.5 font-medium whitespace-nowrap', flat || neutral ? 'text-ink-2' : up ? 'text-crit-ink' : 'text-good-ink', className)}>
      <Icon className="size-3" aria-hidden />
      {fmtPct(Math.abs(pct), 1)}
      <span className="sr-only">{flat ? 'unchanged' : up ? 'increase' : 'decrease'}</span>
    </span>
  );
}

/** Own-vs-competitor gap: positive = own is more expensive. */
export function GapCell({ pct, basis }: { pct: number | null | undefined; basis?: 'shelf' | 'unit' | 'not_comparable' | null }) {
  if (basis === 'not_comparable') {
    return (
      <Tip content="Measured in different units (e.g. g vs ml) — a price gap would be misleading, so none is calculated.">
        <span className="inline-flex items-center gap-1 text-[12px] text-ink-3">
          <Ban className="size-3" aria-hidden /> Not comparable
        </span>
      </Tip>
    );
  }
  if (pct === null || pct === undefined) return <span className="text-ink-4">{DASH}</span>;
  const flat = Math.abs(pct) < 0.5;
  return (
    <Tip content={flat ? 'Own product is at parity with this competitor.' : pct > 0 ? 'Own product is more expensive than this competitor.' : 'Own product is cheaper than this competitor.'}>
      <span className="num inline-flex items-center gap-1 font-medium whitespace-nowrap text-ink">
        <span aria-hidden className={cn('size-1.5 rounded-full', flat ? 'bg-ink-4' : pct > 0 ? 'bg-s8' : 'bg-s1')} />
        {fmtPct(pct, 1, true)}
        {basis === 'unit' ? <span className="text-[11px] font-normal text-ink-3">unit</span> : null}
      </span>
    </Tip>
  );
}

export function PromoBadge({ type, discount, description }: { type: PromoType | string | null | undefined; discount?: number | null; description?: string | null }) {
  if (!type) return null;
  const label = PROMO_TYPE_LABELS[type as PromoType] ?? 'Offer';
  return (
    <Tip content={description ?? label}>
      <span className="inline-flex">
        <Badge tone="warn" icon={Tag}>
          {discount !== null && discount !== undefined ? `${fmtPct(discount, 0)} off` : label}
        </Badge>
      </span>
    </Tip>
  );
}

export function AvailabilityBadge({ value }: { value: Availability | string | null | undefined }) {
  if (!value) return <span className="text-ink-4">{DASH}</span>;
  const label = AVAILABILITY_LABELS[value as Availability] ?? value;
  if (value === 'in_stock') return <span className="text-[12.5px] text-ink-2">{label}</span>;
  if (value === 'out_of_stock') return <Badge tone="crit" icon={PackageX}>{label}</Badge>;
  if (value === 'limited') return <Badge tone="warn">{label}</Badge>;
  return <span className="text-[12.5px] text-ink-4">{label}</span>;
}

export function ConfidenceBadge({ value }: { value: number | null | undefined }) {
  const band = confidenceBand(value);
  if (band === 'unknown') {
    return (
      <span className="inline-flex items-center gap-1 text-[12px] text-ink-4">
        <CircleHelp className="size-3" aria-hidden /> n/a
      </span>
    );
  }
  const meta = { high: { tone: 'good' as const, icon: BadgeCheck, label: 'High' }, medium: { tone: 'warn' as const, icon: CircleDashed, label: 'Medium' }, low: { tone: 'crit' as const, icon: CircleDashed, label: 'Low' } }[band];
  return (
    <Tip content={`Evidence / extraction confidence ${Math.round((value ?? 0) * 100)}%`}>
      <span className="inline-flex">
        <Badge tone={meta.tone} icon={meta.icon}>
          {meta.label}
        </Badge>
      </span>
    </Tip>
  );
}

// ---------------------------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------------------------
/** A UTC instant shown in the market's local time, with the exact UTC value on hover. */
export function MarketTime({ iso, timeZone, short, relative }: { iso: string | null | undefined; timeZone?: string | null; short?: boolean; relative?: boolean }) {
  if (!iso) return <span className="text-ink-4">{DASH}</span>;
  const local = short ? fmtDateTimeShort(iso, timeZone) : fmtDateTime(iso, timeZone);
  return (
    <Tip content={`${fmtDateTime(iso, timeZone)} ${tzLabel(timeZone, new Date(iso))} (market time) · ${iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}`}>
      <span className="num whitespace-nowrap text-ink-2">
        {relative ? fmtRelative(iso) : local}
        {relative ? null : timeZone ? <span className="ml-1 text-[11px] text-ink-4">{tzLabel(timeZone, new Date(iso))}</span> : null}
      </span>
    </Tip>
  );
}

export function FreshnessCell({ iso, stale, timeZone }: { iso: string | null | undefined; stale?: boolean | number | null; timeZone?: string | null }) {
  if (!iso) return <Badge tone="warn">Never observed</Badge>;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <MarketTime iso={iso} timeZone={timeZone} relative />
      {stale ? <Badge tone="warn">Stale</Badge> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Currency conversion footnote — rate, timestamp and source are always stated.
// ---------------------------------------------------------------------------------------------
export function FxNote({ conversions, missing, target, className }: { conversions: Conversion[] | undefined; missing?: string[]; target?: string | null; className?: string }) {
  const used = (conversions ?? []).filter((c) => c.from !== c.to);
  if (!used.length && !missing?.length) return null;
  const anyDemo = used.some((c) => c.is_demo);
  return (
    <div className={cn('text-[12px] leading-5 text-ink-3', className)}>
      {used.length ? (
        <p>
          <span className="font-medium text-ink-2">Converted to {target ?? used[0]!.to}.</span>{' '}
          {used.map((c, i) => (
            <span key={c.from} className="num">
              {i ? ' · ' : ''}1 {c.from} = {c.rate >= 1 ? c.rate.toFixed(4) : c.rate.toPrecision(4)} {c.to}
            </span>
          ))}
          . Rates as of {fmtDateTime(used.map((c) => c.as_of).sort()[0], 'UTC')} UTC; source: {[...new Set(used.flatMap((c) => c.sources))].join(', ') || 'n/a'}.
          {anyDemo ? <strong className="font-semibold text-warn-ink"> Illustrative demo rates — not market rates.</strong> : null}
        </p>
      ) : null}
      {missing?.length ? <p className="text-crit-ink">No exchange rate available for {missing.join(', ')} — those values are not converted.</p> : null}
    </div>
  );
}

export function money(value: number | null | undefined, currency: string | null | undefined): ReactNode {
  return <span className="num whitespace-nowrap">{fmtMoney(value, currency)}</span>;
}
