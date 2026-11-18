/**
 * Cost planner: what a collection plan would cost per month.
 *
 * A calculator, not a bill. For each platform it multiplies the number of products by how often they are
 * checked and by the provider price entered for it. The platforms that exist come from GET /api/collection/sources
 * (their real number of active listings and current schedule); planned platforms can be added to see what growing
 * would cost. The plan is kept in this browser only — nothing here changes how collection runs.
 */
import { useEffect, useMemo, useState } from 'react';
import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import type { CollectionSource } from '@shared/api/collection.ts';
import { ChartFrame, DEEMPHASIS, Legend, OWN_COLOR, type TableView } from '@/components/charts/kit.tsx';
import { Button, cn, ErrorState, IconButton, Input, LoadingBlock, Notice, Select, StatTile } from '@/components/ui/primitives.tsx';
import { fmtNumber, fmtPct } from '@/lib/format.ts';
import { useApiQuery } from '@/lib/hooks.ts';
import type { SourcesResponse } from './health-shared.tsx';

type Route = 'provider' | 'direct' | 'feed' | 'manual';
const ROUTES: Array<{ value: Route; label: string; paid: boolean }> = [
  { value: 'provider', label: 'Data provider (paid)', paid: true },
  { value: 'direct', label: 'From the site itself (free)', paid: false },
  { value: 'feed', label: 'Retailer feed or API (free)', paid: false },
  { value: 'manual', label: 'Files or by hand (free)', paid: false },
];

type Pace = 'daily' | 'alternate' | 'twice_weekly' | 'weekly' | 'fortnightly' | 'monthly';
const PACES: Array<{ value: Pace; label: string; perMonth: number }> = [
  { value: 'daily', label: 'Every day', perMonth: 30.4 },
  { value: 'alternate', label: 'Every 2 days', perMonth: 15.2 },
  { value: 'twice_weekly', label: 'Twice a week', perMonth: 8.7 },
  { value: 'weekly', label: 'Once a week', perMonth: 4.35 },
  { value: 'fortnightly', label: 'Every 2 weeks', perMonth: 2.17 },
  { value: 'monthly', label: 'Once a month', perMonth: 1 },
];
const DAILY = PACES[0]!.perMonth;
const perMonth = (pace: Pace) => PACES.find((p) => p.value === pace)?.perMonth ?? DAILY;

/** Price assumed for a paid platform whose source has no provider price entered. */
const ASSUMED_PRICE = 1;

interface PlanRow {
  id: string;
  name: string;
  market: string;
  planned: boolean;
  products: number;
  route: Route;
  price: number;
  /** True while the price is the assumption above rather than a figure someone entered. */
  priceAssumed: boolean;
  pace: Pace;
}

interface Stored {
  growth: number;
  budget: number | null;
  edits: Record<string, Partial<Pick<PlanRow, 'route' | 'price' | 'pace'>>>;
  planned: Array<Pick<PlanRow, 'id' | 'name' | 'market' | 'products' | 'route' | 'price' | 'pace'>>;
}
const EMPTY: Stored = { growth: 1, budget: null, edits: {}, planned: [] };
const STORAGE_KEY = 'pios.cost-planner.v1';

function load(): Stored {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return {
      growth: typeof parsed.growth === 'number' && parsed.growth > 0 ? parsed.growth : 1,
      budget: typeof parsed.budget === 'number' && parsed.budget >= 0 ? parsed.budget : null,
      edits: parsed.edits && typeof parsed.edits === 'object' ? parsed.edits : {},
      planned: Array.isArray(parsed.planned) ? parsed.planned : [],
    };
  } catch {
    return EMPTY;
  }
}

const usd = (value: number) => `US$ ${value >= 100 ? fmtNumber(Math.round(value)) : value.toFixed(2)}`;

function routeOf(source: CollectionSource): Route {
  if (source.method === 'third_party') return 'provider';
  if (source.method === 'web_extraction') return 'direct';
  if (source.method === 'official_api' || source.method === 'product_feed') return 'feed';
  return 'manual';
}

function paceOf(source: CollectionSource): Pace {
  // The schedules a source can have today: every 6 or 12 hours count as daily here (the provider is billed per run).
  return source.frequency === 'weekly' ? 'weekly' : source.frequency === 'manual' ? 'weekly' : 'daily';
}

function num(value: string, fallback: number, min = 0, max = 1e9): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function PlannerTab() {
  const sources = useApiQuery<SourcesResponse>(['collection', 'sources', 'planner'], '/collection/sources', {}, { staleTime: 60_000 });
  const [stored, setStored] = useState<Stored>(load);
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {
      /* the plan simply is not remembered */
    }
  }, [stored]);

  const rows = useMemo<PlanRow[]>(() => {
    const existing = (sources.data?.rows ?? [])
      .filter((s) => s.is_active && !s.is_demo && s.method !== 'simulated')
      .map((s): PlanRow => {
        const id = `r${s.retailer_id}`;
        const edit = stored.edits[id] ?? {};
        return {
          id,
          name: s.name,
          market: s.market_code,
          planned: false,
          products: Math.round(s.listings_active * stored.growth),
          route: edit.route ?? routeOf(s),
          price: edit.price ?? s.cost_per_1000 ?? ASSUMED_PRICE,
          priceAssumed: edit.price === undefined && s.cost_per_1000 === null,
          pace: edit.pace ?? paceOf(s),
        };
      });
    return [...existing, ...stored.planned.map((p): PlanRow => ({ ...p, planned: true, priceAssumed: false }))];
  }, [sources.data, stored]);

  const figures = useMemo(
    () =>
      rows.map((row) => {
        const paid = ROUTES.find((r) => r.value === row.route)?.paid ?? false;
        const checks = row.products * perMonth(row.pace);
        return { row, paid, checks, cost: paid ? (checks / 1000) * row.price : 0, daily: paid ? ((row.products * DAILY) / 1000) * row.price : 0 };
      }),
    [rows],
  );
  const total = figures.reduce((sum, f) => sum + f.cost, 0);
  const totalDaily = figures.reduce((sum, f) => sum + f.daily, 0);
  const totalChecks = figures.reduce((sum, f) => sum + f.checks, 0);
  const totalProducts = rows.reduce((sum, r) => sum + r.products, 0);
  const saving = totalDaily > 0 ? ((totalDaily - total) / totalDaily) * 100 : null;
  const most = Math.max(1, ...figures.map((f) => Math.max(f.cost, f.daily)));
  const assumed = figures.filter((f) => f.paid && f.row.priceAssumed).length;

  const edit = (row: PlanRow, patch: Partial<Pick<PlanRow, 'route' | 'price' | 'pace' | 'name' | 'market' | 'products'>>) =>
    setStored((s) =>
      row.planned
        ? { ...s, planned: s.planned.map((p) => (p.id === row.id ? { ...p, ...patch } : p)) }
        : { ...s, edits: { ...s.edits, [row.id]: { ...s.edits[row.id], ...(patch as Partial<Pick<PlanRow, 'route' | 'price' | 'pace'>>) } } },
    );
  const addPlanned = () =>
    setStored((s) => ({
      ...s,
      planned: [...s.planned, { id: `p${Date.now()}`, name: `Planned platform ${s.planned.length + 1}`, market: '', products: 1000, route: 'provider', price: ASSUMED_PRICE, pace: 'weekly' }],
    }));

  if (sources.isError && !sources.data) return <ErrorState error={sources.error} onRetry={() => void sources.refetch()} />;
  if (!sources.data) return <LoadingBlock className="min-h-48" label="Loading the sources…" />;

  const table: TableView = {
    columns: ['Platform', 'Market', 'Products', 'How prices arrive', 'Price per 1,000 (US$)', 'Checked', 'Product checks per month', 'Cost per month (US$)', 'If checked daily (US$)'],
    numeric: [2, 4, 6, 7, 8],
    rows: figures.map(({ row, paid, checks, cost, daily }) => [
      row.name, row.market || null, row.products, ROUTES.find((r) => r.value === row.route)!.label, paid ? row.price.toFixed(2) : null,
      PACES.find((p) => p.value === row.pace)!.label, Math.round(checks), cost.toFixed(2), daily.toFixed(2),
    ]),
  };

  return (
    <div className="flex flex-col gap-4">
      <Notice tone="info" title="A calculator, not a bill">
        It multiplies each platform’s number of products by how often they are checked and by the provider price entered for it. This system does not pay or measure provider
        charges: your provider’s invoice is the figure that counts. Providers usually charge for every product they return, including ones outside your brands, so allow some
        margin. The plan is kept in this browser only and changes nothing about how collection runs.
      </Notice>

      <div className="stagger grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatTile
          label="This plan, per month"
          value={usd(total)}
          tone={stored.budget !== null && total > stored.budget ? 'warn' : 'default'}
          detail={
            stored.budget !== null
              ? total > stored.budget
                ? `${usd(total - stored.budget)} over the budget of ${usd(stored.budget)}`
                : `${usd(stored.budget - total)} under the budget of ${usd(stored.budget)}`
              : `${fmtNumber(rows.length)} platforms · ${fmtNumber(totalProducts)} products`
          }
        />
        <StatTile label="If everything were checked daily" value={usd(totalDaily)} detail="Same platforms and prices, every product every day" />
        <StatTile
          label="Saved by the schedule"
          value={saving === null ? '—' : fmtPct(Math.max(0, saving), 0)}
          detail={saving === null ? 'No paid platform in the plan' : `${usd(Math.max(0, totalDaily - total))} a month less than daily collection`}
        />
        <StatTile label="Product checks per month" value={fmtNumber(Math.round(totalChecks))} detail="Each check is one price observation kept in the ledger" />
      </div>

      <div className="sheet">
        <div className="flex flex-wrap items-end gap-x-5 gap-y-3 border-b border-line px-4 py-3">
          <label className="flex flex-col gap-1 text-[12px] text-ink-3">
            Range growth
            <span className="flex items-center gap-2">
              <Input
                type="number" min={0.1} max={50} step={0.1} className="w-24" value={stored.growth}
                onChange={(e) => setStored((s) => ({ ...s, growth: num(e.target.value, 1, 0.1, 50) }))}
                aria-label="Range growth factor"
              />
              <span className="max-w-64 text-[12px] leading-4">× today’s listings on the existing platforms (2 = twice as many brands or products)</span>
            </span>
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-ink-3">
            Monthly budget (US$, optional)
            <Input
              type="number" min={0} step={10} className="w-32" value={stored.budget ?? ''} placeholder="none"
              onChange={(e) => setStored((s) => ({ ...s, budget: e.target.value === '' ? null : num(e.target.value, 0) }))}
              aria-label="Monthly budget in US dollars"
            />
          </label>
          <div className="flex-1" />
          <Button icon={Plus} onClick={addPlanned}>
            Add a planned platform
          </Button>
          <Button variant="ghost" icon={RotateCcw} onClick={() => setStored(EMPTY)}>
            Reset
          </Button>
        </div>

        <div className="table-wrap">
          <table className="grid-table">
            <thead>
              <tr>
                <th scope="col">Platform</th>
                <th scope="col" style={{ textAlign: 'right' }}>Products</th>
                <th scope="col">How prices arrive</th>
                <th scope="col" style={{ textAlign: 'right' }}>Price per 1,000</th>
                <th scope="col">Checked</th>
                <th scope="col" style={{ textAlign: 'right' }}>Cost per month</th>
                <th scope="col" style={{ textAlign: 'right' }}>If daily</th>
                <th scope="col" aria-label="Remove" />
              </tr>
            </thead>
            <tbody>
              {figures.map(({ row, paid, cost, daily }) => (
                <tr key={row.id}>
                  <td>
                    {row.planned ? (
                      <span className="flex min-w-64 items-center gap-2">
                        <Input className="min-w-0 flex-1" value={row.name} onChange={(e) => edit(row, { name: e.target.value.slice(0, 60) })} aria-label="Name of the planned platform" />
                        <Input className="w-16" value={row.market} placeholder="Market" onChange={(e) => edit(row, { market: e.target.value.slice(0, 6).toUpperCase() })} aria-label="Market code" />
                      </span>
                    ) : (
                      <span className="whitespace-nowrap">
                        <span className="font-medium text-ink">{row.name}</span> <span className="text-[11.5px] text-ink-3">{row.market}</span>
                      </span>
                    )}
                  </td>
                  <td className="num" style={{ textAlign: 'right' }}>
                    {row.planned ? (
                      <Input type="number" min={0} step={100} className="ml-auto w-24 text-right" value={row.products} onChange={(e) => edit(row, { products: Math.round(num(e.target.value, 0)) })} aria-label="Expected number of products" />
                    ) : (
                      fmtNumber(row.products)
                    )}
                  </td>
                  <td>
                    <Select className="min-w-52" value={row.route} onChange={(e) => edit(row, { route: e.target.value as Route })} aria-label={`How prices arrive for ${row.name}`}>
                      {ROUTES.map((r) => (
                        <option key={r.value} value={r.value}>
                          {r.label}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="num" style={{ textAlign: 'right' }}>
                    {paid ? (
                      <span className="inline-flex items-center justify-end gap-1.5">
                        {row.priceAssumed ? <span className="text-[11px] text-warn-ink" title="No provider price is entered for this source: US$ 1.00 is assumed. Enter the real price here or in the source’s settings.">assumed</span> : null}
                        <Input type="number" min={0} max={1000} step={0.05} className="w-24 text-right" value={row.price} onChange={(e) => edit(row, { price: num(e.target.value, 0, 0, 1000) })} aria-label={`Provider price per 1,000 products for ${row.name}, in US dollars`} />
                      </span>
                    ) : (
                      <span className="text-ink-3">free</span>
                    )}
                  </td>
                  <td>
                    <Select className="min-w-36" value={row.pace} onChange={(e) => edit(row, { pace: e.target.value as Pace })} aria-label={`How often ${row.name} is checked`}>
                      {PACES.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="num font-semibold whitespace-nowrap text-ink" style={{ textAlign: 'right' }}>{paid ? usd(cost) : <span className="font-normal text-ink-3">—</span>}</td>
                  <td className="num whitespace-nowrap text-ink-3" style={{ textAlign: 'right' }}>{paid ? usd(daily) : '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    {row.planned ? <IconButton icon={Trash2} label={`Remove ${row.name}`} size="sm" onClick={() => setStored((s) => ({ ...s, planned: s.planned.filter((p) => p.id !== row.id) }))} /> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {assumed > 0 ? (
          <p className="border-t border-line px-4 py-2.5 text-[12px] leading-4 text-ink-3">
            {assumed === 1 ? 'One paid platform has' : `${fmtNumber(assumed)} paid platforms have`} no provider price entered, so US$ 1.00 per 1,000 products is assumed. Enter the real price in the
            table, or once in the source’s settings (Administration → Retailers &amp; listings → the source → “Provider price per 1,000 items”).
          </p>
        ) : null}
      </div>

      <ChartFrame
        title="Cost per month by platform"
        subtitle="This plan beside what daily collection of everything would cost"
        legend={
          <Legend
            items={[
              { key: 'plan', label: 'This plan', color: OWN_COLOR, shape: 'rect' },
              { key: 'daily', label: 'If checked daily', color: DEEMPHASIS, shape: 'rect' },
            ]}
          />
        }
        table={table}
        empty={figures.every((f) => !f.paid) ? <p className="py-8 text-center text-[12.5px] text-ink-3">No paid platform in the plan: nothing to chart.</p> : undefined}
      >
        <ul className="flex flex-col gap-2.5">
          {figures
            .filter((f) => f.paid)
            .sort((a, b) => b.daily - a.daily)
            .map(({ row, cost, daily }) => (
              <li key={row.id} className="grid grid-cols-1 items-center gap-x-4 gap-y-0.5 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
                <span className="truncate text-[12.5px] leading-5 text-ink">
                  {row.name} <span className="text-[11.5px] text-ink-3">{row.market}</span>
                </span>
                <div>
                  {[
                    { key: 'plan', value: cost, color: OWN_COLOR, strong: true },
                    { key: 'daily', value: daily, color: DEEMPHASIS, strong: false },
                  ].map((bar) => (
                    <div key={bar.key} className="flex h-5 items-center gap-2">
                      <div className="relative h-2 min-w-0 flex-1 rounded-full bg-wash" aria-hidden>
                        <span className="absolute inset-y-0 left-0 rounded-r-full" style={{ width: `${(bar.value / most) * 100}%`, background: bar.color, minWidth: bar.value > 0 ? 2 : 0 }} />
                      </div>
                      <span className={cn('num w-24 shrink-0 text-right text-[12.5px]', bar.strong ? 'font-semibold text-ink' : 'text-ink-3')}>{usd(bar.value)}</span>
                    </div>
                  ))}
                </div>
              </li>
            ))}
        </ul>
      </ChartFrame>
    </div>
  );
}
