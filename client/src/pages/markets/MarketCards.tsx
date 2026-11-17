/** Markets view: one card per configured market with coverage, freshness, activity, position and collection health. */
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowDown, ArrowUp, CircleCheck, CircleDashed, CirclePause, Clock, FlaskConical, TriangleAlert, type LucideIcon } from 'lucide-react';
import { IndexScale, SegmentedBar } from '@/components/charts/charts.tsx';
import { FrequencyLabel, MarketTime, MethodLabel } from '@/components/domain/domain.tsx';
import { Badge, Card, cn, Notice, StatTile, type BadgeTone } from '@/components/ui/primitives.tsx';
import { fmtDateTimeShort, fmtNumber, fmtPct, plural, tzLabel } from '@/lib/format.ts';
import { FREQUENCIES } from '@shared/constants.ts';
import type { MarketOverviewRow, RunStats } from '@shared/api/analytics.ts';

/** Freshness is a state, so it uses the status colours — always next to its figures and labels. */
const FRESHNESS_COLORS = { fresh: '#0ca30c', stale: '#fab219', never: '#ec835a' } as const;

const STATUS: Record<MarketOverviewRow['status'], { label: string; tone: BadgeTone; icon: LucideIcon }> = {
  healthy: { label: 'Healthy', tone: 'good', icon: CircleCheck },
  attention: { label: 'Needs attention', tone: 'warn', icon: TriangleAlert },
  no_data: { label: 'No data yet', tone: 'outline', icon: CircleDashed },
  inactive: { label: 'Inactive', tone: 'neutral', icon: CirclePause },
};

/** Re-renders on a slow tick so the local clocks stay current. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

function Row({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid grid-cols-[7.25rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 border-t border-line px-4 py-2.5 text-[12.5px] leading-5', className)}>
      <dt className="text-ink-3">{label}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </div>
  );
}

const Count = ({ children }: { children: ReactNode }) => <span className="num font-semibold text-ink">{children}</span>;

function CollectionLine({ stats, kind, days }: { stats: RunStats; kind: 'real' | 'simulated'; days: number }) {
  if (kind === 'real') {
    if (stats.runs === 0) {
      return (
        <span className="text-ink-3">
          No real collection has run in the last {days} days
          {stats.not_configured > 0 ? ` (${plural(stats.not_configured, 'attempt')} on a source that is not configured)` : ''}.
        </span>
      );
    }
    return (
      <span>
        <Count>{fmtPct(stats.success_rate_pct, 1)}</Count> of {plural(stats.runs, 'real run')} succeeded
        <span className="text-ink-3">
          {' '}
          ({fmtNumber(stats.failed)} failed, {fmtNumber(stats.partial)} partial{stats.not_configured ? `, ${fmtNumber(stats.not_configured)} not configured` : ''})
        </span>
      </span>
    );
  }
  if (stats.runs === 0) return <span className="text-ink-3">No simulated demo runs.</span>;
  return (
    <span>
      <Count>{fmtPct(stats.success_rate_pct, 1)}</Count> of {plural(stats.runs, 'simulated demo run')} completed
      <span className="text-ink-3">
        {' '}
        ({fmtNumber(stats.failed)} failed, {fmtNumber(stats.partial)} partial)
      </span>
    </span>
  );
}

function positionText(premium: number | null): string {
  if (premium === null) return '';
  if (Math.abs(premium) < 0.5) return 'own brands at parity with mapped competitors';
  return premium > 0 ? `own brands ${fmtPct(premium, 1)} above mapped competitors` : `own brands ${fmtPct(Math.abs(premium), 1)} below mapped competitors`;
}

export function MarketCard({ market: m, days, now, canManage }: { market: MarketOverviewRow; days: number; now: number; canManage: boolean }) {
  const status = STATUS[m.status];
  const methods = Object.entries(m.retailers.by_method).sort((a, b) => b[1] - a[1]);
  const frequencies = Object.entries(m.retailers.by_frequency).sort((a, b) => (FREQUENCIES as readonly string[]).indexOf(a[0]) - (FREQUENCIES as readonly string[]).indexOf(b[0]));
  const l = m.listings;
  return (
    <Card className="flex flex-col overflow-hidden">
      <div className="px-4 pt-3.5 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[15px] leading-6 font-semibold text-ink">{m.name}</h3>
              <span className="mono rounded bg-wash px-1.5 py-0.5 text-ink-3">{m.code}</span>
              {m.demo_only ? (
                <Badge tone="demo" icon={FlaskConical} title="Every listing in this market belongs to the illustrative demo dataset.">
                  Demo data only
                </Badge>
              ) : null}
            </div>
            <p className="mt-0.5 text-[12px] leading-4 text-ink-3">
              {[m.country_name !== m.name ? m.country_name : null, m.region, `Currency ${m.currency_code}`].filter(Boolean).join(' · ')}
            </p>
          </div>
          <Badge tone={status.tone} icon={status.icon}>
            {status.label}
          </Badge>
        </div>
        <p className="mt-2 text-[12.5px] leading-5 text-ink-2">{m.status_reason}</p>
        <p className="mt-1 flex items-center gap-1.5 text-[12px] leading-4 text-ink-3">
          <Clock className="size-3" aria-hidden />
          Local time <span className="num font-medium text-ink-2">{fmtDateTimeShort(new Date(now).toISOString(), m.timezone)}</span>
          <span>({tzLabel(m.timezone, new Date(now))})</span>
        </p>
      </div>

      <dl className="flex-1">
        <Row label="Retailers">
          <Count>{fmtNumber(m.retailers.total)}</Count>
          {m.retailers.paused ? <span className="text-ink-3"> · {fmtNumber(m.retailers.paused)} paused</span> : null}
          {methods.length ? (
            <span className="mt-1 flex flex-wrap gap-1.5">
              {methods.map(([method, count]) => (
                <Badge key={method} tone="neutral">
                  <MethodLabel method={method} /> × {count}
                </Badge>
              ))}
            </span>
          ) : null}
        </Row>
        <Row label="Schedule">
          <span>
            Default <span className="font-medium"><FrequencyLabel frequency={m.default_frequency} /></span>
          </span>
          {frequencies.length ? (
            <span className="mt-1 flex flex-wrap gap-1.5">
              {frequencies.map(([frequency, count]) => (
                <Badge key={frequency} tone="outline">
                  <FrequencyLabel frequency={frequency} /> × {count}
                </Badge>
              ))}
            </span>
          ) : null}
        </Row>
        <Row label="Listings">
          {l.active === 0 ? (
            <span className="text-ink-3">No product listings configured.</span>
          ) : (
            <>
              <SegmentedBar
                className="mt-1.5 mb-1.5"
                parts={[
                  { key: 'fresh', label: 'Fresh', value: l.fresh, color: FRESHNESS_COLORS.fresh },
                  { key: 'stale', label: 'Stale', value: l.stale, color: FRESHNESS_COLORS.stale },
                  { key: 'never', label: 'Never observed', value: l.never_observed, color: FRESHNESS_COLORS.never },
                ]}
              />
              <span className="flex flex-wrap gap-x-3 gap-y-0.5">
                {[
                  { label: 'fresh', value: l.fresh, color: FRESHNESS_COLORS.fresh },
                  { label: 'stale', value: l.stale, color: FRESHNESS_COLORS.stale },
                  { label: 'never observed', value: l.never_observed, color: FRESHNESS_COLORS.never },
                ].map((part) => (
                  <span key={part.label} className="inline-flex items-center gap-1.5">
                    <span aria-hidden className="size-2 rounded-[2px]" style={{ background: part.color }} />
                    <Count>{fmtNumber(part.value)}</Count> <span className="text-ink-3">{part.label}</span>
                  </span>
                ))}
              </span>
              <span className="block text-[12px] text-ink-3">
                {plural(l.active, 'active listing')}
                {l.unmatched ? ` · ${fmtNumber(l.unmatched)} not yet matched to a product` : ''}
              </span>
            </>
          )}
        </Row>
        <Row label="Products">
          <Count>{fmtNumber(m.products.own)}</Count> <span className="text-ink-3">own</span> · <Count>{fmtNumber(m.products.competitor)}</Count>{' '}
          <span className="text-ink-3">competitor</span>
        </Row>
        <Row label="Last observation">
          {m.last_observation_at ? <MarketTime iso={m.last_observation_at} timeZone={m.timezone} /> : <span className="text-ink-3">None yet</span>}
        </Row>
        <Row label={`Last ${days} days`}>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <span className="inline-flex items-center gap-1">
              <ArrowUp className="size-3 text-ink-3" aria-hidden />
              <Count>{fmtNumber(m.events.increases)}</Count> <span className="text-ink-3">price increases</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <ArrowDown className="size-3 text-ink-3" aria-hidden />
              <Count>{fmtNumber(m.events.decreases)}</Count> <span className="text-ink-3">decreases</span>
            </span>
          </span>
          <span className="block">
            <Count>{fmtNumber(l.on_promo)}</Count> <span className="text-ink-3">{l.on_promo === 1 ? 'promotion' : 'promotions'} running now</span>
          </span>
        </Row>
        <Row label="Own vs competitors">
          {m.position && m.position.index !== null ? (
            <>
              <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <IndexScale value={m.position.index} width={110} />
                <span>
                  index <Count>{m.position.index.toFixed(1)}</Count>
                </span>
                <span className="text-ink-3">{plural(m.position.pairs, 'pair')}</span>
              </span>
              <span className="block text-[12px] text-ink-3">100 = parity · {positionText(m.position.premium_pct)}</span>
            </>
          ) : (
            <span className="text-ink-3">No comparable own / competitor price pair at the same retailer.</span>
          )}
          <span className="block text-[12px] text-ink-3">
            {m.mapping_coverage.own_products_listed === 0
              ? 'No own product is listed in this market.'
              : `${fmtNumber(m.mapping_coverage.with_competitor_price)} of ${plural(m.mapping_coverage.own_products_listed, 'own product')} listed here have a comparable competitor price.`}
          </span>
        </Row>
        <Row label="Collection">
          <span className="block">
            <CollectionLine stats={m.collection.real} kind="real" days={days} />
          </span>
          {m.collection.simulated.runs > 0 ? (
            <span className="mt-0.5 block">
              <CollectionLine stats={m.collection.simulated} kind="simulated" days={days} />
            </span>
          ) : null}
        </Row>
      </dl>

      <div className="no-print flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-sunken px-4 py-2.5 text-[12.5px]">
        <Link className="link" to={`/monitor?market_id=${m.id}`}>
          Live prices
        </Link>
        <Link className="link" to={`/history?market_id=${m.id}`}>
          Price history
        </Link>
        <Link className="link" to={`/promotions?market_id=${m.id}`}>
          Promotions
        </Link>
        {canManage ? (
          <Link className="link ml-auto" to="/admin?tab=markets">
            Edit market
          </Link>
        ) : null}
      </div>
    </Card>
  );
}

export function MarketSummary({ markets }: { markets: MarketOverviewRow[] }) {
  const active = markets.filter((m) => m.is_active);
  const withData = active.filter((m) => m.listings.observed > 0);
  const attention = active.filter((m) => m.status === 'attention');
  const noData = active.filter((m) => m.status === 'no_data');
  const listings = active.reduce((acc, m) => acc + m.listings.active, 0);
  const fresh = active.reduce((acc, m) => acc + m.listings.fresh, 0);
  return (
    <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile label="Active markets" value={fmtNumber(active.length)} detail={markets.length > active.length ? `${fmtNumber(markets.length - active.length)} switched off` : 'Configured and switched on'} />
      <StatTile
        label="With price data"
        value={
          <>
            {fmtNumber(withData.length)}
            <span className="ml-1 text-[13px] font-medium text-ink-3">of {fmtNumber(active.length)}</span>
          </>
        }
        detail={noData.length ? `No data yet: ${noData.map((m) => m.name).join(', ')}` : 'Every active market has observations'}
      />
      <StatTile
        label="Needing attention"
        value={fmtNumber(attention.length)}
        tone={attention.length ? 'warn' : 'default'}
        icon={attention.length ? TriangleAlert : CircleCheck}
        detail={attention.length ? attention.map((m) => m.name).join(', ') : 'No market is flagged'}
      />
      <StatTile
        label="Listings with a fresh price"
        value={
          <>
            {fmtNumber(fresh)}
            <span className="ml-1 text-[13px] font-medium text-ink-3">of {fmtNumber(listings)}</span>
          </>
        }
        detail={listings ? `${fmtPct((fresh / listings) * 100, 1)} of active listings across markets` : 'No listings configured'}
      />
    </div>
  );
}

export function DemoMarketsNotice({ markets }: { markets: MarketOverviewRow[] }) {
  const withListings = markets.filter((m) => m.listings.active > 0);
  const demoOnly = withListings.filter((m) => m.demo_only);
  if (demoOnly.length === 0) return null;
  const all = demoOnly.length === withListings.length;
  return (
    <Notice tone="demo" icon={FlaskConical}>
      {all ? (
        <>
          <strong className="font-semibold text-ink">Demo data.</strong> Every listing in these markets belongs to the illustrative demo dataset — prices are fictional and collection runs are simulated.
        </>
      ) : (
        <>
          <strong className="font-semibold text-ink">Includes demo data.</strong> {demoOnly.map((m) => m.name).join(', ')} contain only illustrative demo listings; they are marked "Demo data only".
        </>
      )}
    </Notice>
  );
}
