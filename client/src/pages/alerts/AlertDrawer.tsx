/** One alert in full: what happened (payload rendered readably), where to look next, delivery attempts and actions. */
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, BellOff, Check, ExternalLink, RotateCcw } from 'lucide-react';
import { apiGet, apiPost } from '@/lib/api.ts';
import { useCan } from '@/lib/auth.tsx';
import { fmtDate, fmtHours, fmtMoney, fmtNumber, fmtPct, fmtUnitPrice } from '@/lib/format.ts';
import { Drawer, useToast } from '@/components/ui/overlays.tsx';
import { Badge, Button, cn, DescriptionList, ErrorState, Field, LoadingBlock, Notice, Textarea } from '@/components/ui/primitives.tsx';
import { AvailabilityBadge, ChangeCell, DemoBadge, FrequencyLabel, MarketTime, MethodLabel, OwnershipDot } from '@/components/domain/domain.tsx';
import { AVAILABILITY_LABELS, PROMO_TYPE_LABELS, type Availability, type PromoType } from '@shared/constants.ts';
import type {
  AlertDetail, AlertRow, CollectionFailedPayload, ComparedListing, NewListingPayload, OwnMoreExpensivePayload, PriceAlertPayload, StaleAlertPayload,
} from '@shared/api/alerts.ts';
import {
  AlertStatusBadge, alertTypeLabel, CHANNEL_LABELS, errorText, isStateAlert, NOTIFICATION_STATUS_META, SeverityBadge,
} from './shared.tsx';

function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('mt-5', className)}>
      <h3 className="eyebrow mb-2">{title}</h3>
      {children}
    </section>
  );
}

function PriceEventView({ alert, payload }: { alert: AlertRow; payload: PriceAlertPayload }) {
  const currency = payload.currency_code;
  const isPromo = payload.event_kind === 'promo_start';
  const isAvailability = payload.event_kind === 'availability_change';
  return (
    <>
      {payload.event_kind === 'price_change' ? (
        <div className="sheet flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <div>
            <div className="text-[11.5px] text-ink-3">Previous price</div>
            <div className="num text-[16px] font-semibold text-ink-2">{fmtMoney(payload.old_price, currency)}</div>
          </div>
          <ArrowRight className="size-4 text-ink-4" aria-hidden />
          <div>
            <div className="text-[11.5px] text-ink-3">New price</div>
            <div className="num text-[16px] font-semibold text-ink">{fmtMoney(payload.new_price, currency)}</div>
          </div>
          <div className="ml-auto text-right">
            <div className="text-[11.5px] text-ink-3">Change</div>
            <ChangeCell pct={payload.change_pct} className="text-[14px]" />
          </div>
        </div>
      ) : null}
      {isPromo ? (
        <div className="sheet flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <div>
            <div className="text-[11.5px] text-ink-3">Regular price</div>
            <div className="num text-[16px] font-semibold text-ink-2">{fmtMoney(payload.regular_price ?? payload.old_price, currency)}</div>
          </div>
          <ArrowRight className="size-4 text-ink-4" aria-hidden />
          <div>
            <div className="text-[11.5px] text-ink-3">Promotional price</div>
            <div className="num text-[16px] font-semibold text-ink">{fmtMoney(payload.promo_price ?? payload.new_price, currency)}</div>
          </div>
          <div className="ml-auto text-right">
            <div className="text-[11.5px] text-ink-3">Discount</div>
            <div className="num text-[14px] font-medium text-ink">{payload.discount_pct === null || payload.discount_pct === undefined ? 'Not stated' : `${fmtPct(payload.discount_pct, 1)} off`}</div>
          </div>
        </div>
      ) : null}
      {isAvailability ? (
        <div className="sheet flex flex-wrap items-center gap-3 px-4 py-3 text-[13px]">
          <span className="text-ink-2">{AVAILABILITY_LABELS[payload.old_availability as Availability] ?? payload.old_availability ?? 'Unknown'}</span>
          <ArrowRight className="size-4 text-ink-4" aria-hidden />
          <AvailabilityBadge value={payload.new_availability} />
          {payload.new_price !== null ? <span className="ml-auto text-ink-3">Last selling price {fmtMoney(payload.new_price, currency)}</span> : null}
        </div>
      ) : null}
      <DescriptionList
        className="mt-3"
        items={[
          { label: 'Pack', value: payload.pack || '—' },
          { label: 'Promotion type', value: PROMO_TYPE_LABELS[payload.promo_type as PromoType] ?? payload.promo_type ?? '—', hidden: !isPromo },
          { label: 'Offer text', value: payload.promo_description ?? '—', hidden: !isPromo || !payload.promo_description },
          {
            label: 'Change against the previous regular price',
            value: payload.change_vs_regular_pct === null || payload.change_vs_regular_pct === undefined ? '—' : fmtPct(payload.change_vs_regular_pct, 1, true),
            hidden: payload.change_vs_regular_pct === null || payload.change_vs_regular_pct === undefined,
          },
          { label: 'Observed', value: <MarketTime iso={payload.observed_at} timeZone={alert.timezone} /> },
          { label: 'Rule threshold when it fired', value: payload.threshold === null ? 'None (any occurrence)' : `${fmtNumber(payload.threshold, 2)}%` },
          { label: 'Listing title', value: payload.listing_title ?? '—', hidden: !payload.listing_title },
        ]}
      />
    </>
  );
}

function ComparedCard({ role, item, currency, unitBasis }: { role: 'own' | 'competitor'; item: ComparedListing; currency: string; unitBasis: string | null }) {
  return (
    <div className="sheet min-w-0 px-4 py-3">
      <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-ink-3">
        <OwnershipDot ownership={role} /> {role === 'own' ? 'Own product' : 'Competitor'}
      </div>
      <Link to={`/catalogue/products/${item.product_id}`} className="mt-1 block truncate text-[13px] font-medium text-ink hover:underline">
        {item.product_name}
      </Link>
      <div className="truncate text-[11.5px] text-ink-3">{[item.brand_name, item.pack].filter(Boolean).join(' · ')}</div>
      <div className="num mt-2 text-[16px] font-semibold text-ink">{fmtMoney(item.price, currency)}</div>
      <div className="num text-[11.5px] text-ink-3">
        {item.unit_price === null ? 'Unit price unknown' : `${fmtUnitPrice(item.unit_price, currency)} ${currency} ${unitBasis ?? 'per unit basis'}`}
      </div>
    </div>
  );
}

function OwnVsCompetitorView({ alert, payload }: { alert: AlertRow; payload: OwnMoreExpensivePayload }) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <ComparedCard role="own" item={payload.own} currency={payload.currency_code} unitBasis={payload.unit_basis} />
        <ComparedCard role="competitor" item={payload.competitor} currency={payload.currency_code} unitBasis={payload.unit_basis} />
      </div>
      <DescriptionList
        className="mt-3"
        items={[
          { label: 'Gap now (own vs competitor)', value: <span className="num">{fmtPct(payload.gap_pct, 1, true)} — own is more expensive</span> },
          { label: 'Gap before this change', value: payload.previous_gap_pct === null ? 'Not known' : <span className="num">{fmtPct(payload.previous_gap_pct, 1, true)}</span> },
          {
            label: 'Compared on',
            value: payload.basis === 'shelf' ? 'Pack price (like-for-like packs)' : `Unit price${payload.unit_basis ? ` (${payload.unit_basis})` : ''}`,
          },
          {
            label: 'Mapping',
            value: payload.equivalence === 'equivalent' ? <Badge tone="good">Equivalent</Badge> : <Badge tone="warn">Non-equivalent — unit price only</Badge>,
          },
          { label: 'Triggered by', value: payload.trigger === 'own_price_change' ? 'A change of the own price' : 'A change of the competitor price' },
          { label: 'Rule threshold when it fired', value: `${fmtNumber(payload.threshold, 2)}% premium` },
          { label: 'Own price observed', value: <MarketTime iso={payload.own.observed_at} timeZone={alert.timezone} /> },
          { label: 'Competitor price observed', value: <MarketTime iso={payload.competitor.observed_at} timeZone={alert.timezone} /> },
        ]}
      />
    </>
  );
}

function StaleView({ alert, payload }: { alert: AlertRow; payload: StaleAlertPayload }) {
  return (
    <>
      <DescriptionList
        items={[
          { label: 'Listings without a fresh observation', value: <span className="num">{fmtNumber(payload.stale_count)} of {fmtNumber(payload.total_listings)}</span> },
          { label: 'Never observed', value: <span className="num">{fmtNumber(payload.never_observed)}</span> },
          { label: 'Oldest observation', value: payload.oldest_observed_at ? <MarketTime iso={payload.oldest_observed_at} timeZone={alert.timezone} /> : 'None on record' },
          { label: 'Age of the oldest', value: fmtHours(payload.oldest_age_hours), hidden: payload.oldest_age_hours === null },
          { label: 'Expected within', value: `${fmtHours(payload.window_hours)} of the last observation` },
          { label: 'Source schedule', value: <FrequencyLabel frequency={payload.frequency} /> },
          { label: 'Last checked', value: <MarketTime iso={payload.checked_at} timeZone={alert.timezone} /> },
        ]}
      />
      {payload.sample?.length ? (
        <div className="table-wrap mt-3 rounded-md border border-line">
          <table className="grid-table is-dense">
            <thead>
              <tr>
                <th scope="col">Listing</th>
                <th scope="col">Product</th>
                <th scope="col">Last observed</th>
              </tr>
            </thead>
            <tbody>
              {payload.sample.map((s) => (
                <tr key={s.listing_id}>
                  <td className="mono">{s.listing_code ?? `#${s.listing_id}`}</td>
                  <td>{s.product_name ?? 'Unmatched listing'}</td>
                  <td>{s.last_observed_at ? <MarketTime iso={s.last_observed_at} timeZone={alert.timezone} short /> : 'Never'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {payload.sample && payload.stale_count > payload.sample.length ? (
        <p className="mt-1.5 text-[12px] text-ink-3">Showing {payload.sample.length} of {fmtNumber(payload.stale_count)} affected listings.</p>
      ) : null}
    </>
  );
}

function CollectionFailedView({ alert, payload }: { alert: AlertRow; payload: CollectionFailedPayload }) {
  return (
    <>
      <DescriptionList
        items={[
          { label: 'Consecutive failed runs', value: <span className="num">{fmtNumber(payload.consecutive_failures)} (rule threshold {fmtNumber(payload.threshold)})</span> },
          { label: 'Collection method', value: <MethodLabel method={payload.method} /> },
          { label: 'Last attempt', value: <MarketTime iso={payload.last_attempt_at} timeZone={alert.timezone} /> },
          { label: 'Last successful collection', value: payload.last_success_at ? <MarketTime iso={payload.last_success_at} timeZone={alert.timezone} /> : 'None on record' },
          { label: 'Last error code', value: <span className="mono">{payload.last_error_code ?? '—'}</span> },
          { label: 'Last checked', value: <MarketTime iso={payload.checked_at} timeZone={alert.timezone} /> },
        ]}
      />
      {payload.last_error_message ? (
        <Notice tone="crit" className="mt-3" title="Last error reported by the collection run">
          {payload.last_error_message}
        </Notice>
      ) : null}
    </>
  );
}

/** Listings a collection run found at the retailer that were not there before. */
function NewListingView({ payload }: { payload: NewListingPayload }) {
  const guessed = payload.brands.reduce((sum, b) => sum + b.count, 0);
  return (
    <>
      <DescriptionList
        items={[
          { label: 'New listings in this run', value: <span className="num">{fmtNumber(payload.count)}</span> },
          { label: 'Rule minimum', value: <span className="num">{fmtNumber(payload.threshold)}</span>, hidden: payload.threshold <= 1 },
          { label: 'Collection run', value: <span className="num">#{payload.job_id}</span> },
          {
            label: 'Not counted (first load)',
            value: (
              <span>
                <span className="num">{fmtNumber(payload.baseline_skipped)}</span> — the first load of a retailer, or of a brand at a retailer, is a baseline
              </span>
            ),
            hidden: payload.baseline_skipped === 0,
          },
        ]}
      />
      {payload.brands.length || payload.unrecognised ? (
        <div className="mt-3">
          <div className="eyebrow mb-1.5">By the brand named in the title</div>
          <ul className="flex flex-wrap gap-1.5">
            {payload.brands.map((b) => (
              <li key={b.brand_id}>
                <Badge tone={b.ownership === 'own' ? 'own' : 'comp'}>
                  {b.brand_name} <span className="num">{fmtNumber(b.count)}</span>
                </Badge>
              </li>
            ))}
            {payload.unrecognised > 0 ? (
              <li>
                <Badge tone="outline">
                  Brand not recognised <span className="num">{fmtNumber(payload.unrecognised)}</span>
                </Badge>
              </li>
            ) : null}
          </ul>
          {guessed > 0 ? <p className="mt-1.5 text-[12px] text-ink-3">A guess from the retailer’s wording — it is not stored and matches nothing.</p> : null}
        </div>
      ) : null}
      {payload.titles.length ? (
        <div className="mt-3">
          <div className="eyebrow mb-1.5">{payload.count > payload.titles.length ? `First ${payload.titles.length} titles` : 'Titles'}</div>
          <ul className="list-disc space-y-0.5 pl-4 text-[12.5px] leading-5 text-ink-2">
            {payload.titles.map((title, i) => (
              <li key={i}>{title}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <Notice tone="info" className="mt-3" title="Nothing is matched automatically">
        The listings are stored as unmatched. Review them — match each to an existing product, create a product for it, or ignore it.
      </Notice>
      <Link to={payload.link} className="link mt-3 inline-flex items-center gap-1 text-[12.5px] text-ink">
        Open New Products for this retailer <ArrowRight className="size-3.5" aria-hidden />
      </Link>
    </>
  );
}

function GenericPayload({ payload }: { payload: Record<string, unknown> }) {
  const entries = Object.entries(payload);
  if (!entries.length) return <p className="text-[12.5px] text-ink-3">No further details were recorded with this alert.</p>;
  return (
    <DescriptionList
      items={entries.map(([key, value]) => ({
        label: key.replace(/_/g, ' '),
        value: typeof value === 'object' && value !== null ? <span className="mono break-all">{JSON.stringify(value)}</span> : String(value ?? '—'),
      }))}
    />
  );
}

function PayloadView({ alert }: { alert: AlertDetail }) {
  const payload = alert.payload as Record<string, unknown>;
  if (alert.type === 'own_more_expensive' && payload && typeof payload.own === 'object' && typeof payload.competitor === 'object') {
    return <OwnVsCompetitorView alert={alert} payload={alert.payload as OwnMoreExpensivePayload} />;
  }
  if (alert.type === 'stale_observation' && payload && 'stale_count' in payload) return <StaleView alert={alert} payload={alert.payload as StaleAlertPayload} />;
  if (alert.type === 'collection_failed' && payload && 'consecutive_failures' in payload) {
    return <CollectionFailedView alert={alert} payload={alert.payload as CollectionFailedPayload} />;
  }
  if (alert.type === 'new_listing' && payload && Array.isArray(payload.titles) && typeof payload.link === 'string') {
    return <NewListingView payload={alert.payload as NewListingPayload} />;
  }
  if (payload && 'event_kind' in payload) return <PriceEventView alert={alert} payload={alert.payload as PriceAlertPayload} />;
  return <GenericPayload payload={payload ?? {}} />;
}

export function AlertDrawer({ alertId, onClose }: { alertId: number | null; onClose: () => void }) {
  const canManage = useCan('alerts.manage');
  const toast = useToast();
  const client = useQueryClient();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['alerts', 'detail', alertId],
    queryFn: () => apiGet<AlertDetail>(`/alerts/${alertId}`),
    enabled: alertId !== null,
  });
  useEffect(() => setNote(''), [alertId]);

  const alert = query.data;

  async function act(action: 'acknowledge' | 'resolve' | 'reopen') {
    if (!alert) return;
    setBusy(action);
    try {
      await apiPost(`/alerts/${alert.id}/${action}`, { note: action === 'resolve' && note.trim() ? note.trim() : null });
      toast.success(action === 'acknowledge' ? 'Alert acknowledged' : action === 'resolve' ? 'Alert resolved' : 'Alert reopened');
      setNote('');
      await Promise.all([client.invalidateQueries({ queryKey: ['alerts'] }), client.invalidateQueries({ queryKey: ['alert-rules'] })]);
    } catch (err) {
      toast.error('The alert was not updated', errorText(err));
    } finally {
      setBusy(null);
    }
  }

  const footer =
    alert && canManage ? (
      <>
        {alert.status !== 'open' ? (
          <Button icon={RotateCcw} onClick={() => void act('reopen')} loading={busy === 'reopen'} disabled={busy !== null}>
            Reopen
          </Button>
        ) : null}
        {alert.status === 'open' ? (
          <Button icon={BellOff} onClick={() => void act('acknowledge')} loading={busy === 'acknowledge'} disabled={busy !== null}>
            Acknowledge
          </Button>
        ) : null}
        {alert.status !== 'resolved' ? (
          <Button variant="primary" icon={Check} onClick={() => void act('resolve')} loading={busy === 'resolve'} disabled={busy !== null}>
            Resolve
          </Button>
        ) : null}
      </>
    ) : undefined;

  return (
    <Drawer
      open={alertId !== null}
      onClose={onClose}
      width="lg"
      title={alert ? alert.title : 'Alert'}
      subtitle={
        alert ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <SeverityBadge severity={alert.severity} />
            <AlertStatusBadge status={alert.status} />
            <Badge tone="outline">{alertTypeLabel(alert.type)}</Badge>
            {alert.is_demo ? <DemoBadge /> : null}
          </span>
        ) : undefined
      }
      footer={footer}
    >
      {query.isPending ? (
        <LoadingBlock />
      ) : query.isError || !alert ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <div>
          {alert.is_demo ? (
            <Notice tone="demo" className="mb-4">
              Raised from the illustrative <strong className="font-semibold text-ink">demo dataset</strong>. The prices in this alert are fictional.
            </Notice>
          ) : null}
          <p className="text-[13px] leading-5 text-ink-2">{alert.message}</p>

          <Section title="What happened">
            <PayloadView alert={alert} />
          </Section>

          <Section title="Context">
            <DescriptionList
              items={[
                { label: 'Triggered', value: <MarketTime iso={alert.triggered_at} timeZone={alert.timezone} /> },
                { label: 'Rule', value: alert.rule_name ?? 'Rule deleted' },
                {
                  label: 'Product',
                  hidden: !alert.product_id,
                  value: (
                    <Link to={`/catalogue/products/${alert.product_id}`} className="link">
                      {alert.product_name ?? alert.product_code}
                    </Link>
                  ),
                },
                { label: 'Brand', value: alert.brand_name ?? '—', hidden: !alert.brand_name },
                { label: 'Retailer', value: alert.retailer_name ?? '—', hidden: !alert.retailer_name },
                { label: 'Market', value: alert.market_name ?? '—', hidden: !alert.market_name },
                { label: 'Listing', value: <span className="mono">{alert.listing_code}</span>, hidden: !alert.listing_code },
                { label: 'Observation', value: <span className="mono">#{alert.observation_id}</span>, hidden: !alert.observation_id },
              ]}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              {alert.product_id ? (
                <Link to={`/history?product_id=${alert.product_id}${alert.retailer_id ? `&retailer_id=${alert.retailer_id}` : ''}`} className="link inline-flex items-center gap-1 text-[12.5px]">
                  Price history <ExternalLink className="size-3" aria-hidden />
                </Link>
              ) : null}
              {alert.type === 'own_more_expensive' && alert.product_id ? (
                <Link to={`/competitors?product_id=${alert.product_id}`} className="link inline-flex items-center gap-1 text-[12.5px]">
                  Competitor comparison <ExternalLink className="size-3" aria-hidden />
                </Link>
              ) : null}
              {isStateAlert(alert.type) ? (
                <Link to="/collection" className="link inline-flex items-center gap-1 text-[12.5px]">
                  Data Collection Centre <ExternalLink className="size-3" aria-hidden />
                </Link>
              ) : null}
            </div>
          </Section>

          <Section title="Notification attempts">
            {alert.notifications.length === 0 ? (
              <p className="text-[12.5px] text-ink-3">No delivery attempt has been recorded for this alert yet.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
                {alert.notifications.map((n) => {
                  const meta = NOTIFICATION_STATUS_META[n.status];
                  return (
                    <li key={n.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[12.5px]">
                      <span className="w-16 shrink-0 font-medium text-ink">{CHANNEL_LABELS[n.channel] ?? n.channel}</span>
                      <Badge tone={meta?.tone ?? 'neutral'}>{meta?.label ?? n.status}</Badge>
                      <span className="min-w-0 flex-1 truncate text-ink-3">{n.recipient ?? (n.channel === 'in_app' ? 'Alerts Centre' : '')}</span>
                      <MarketTime iso={n.created_at} short />
                      {n.error ? <span className="w-full break-words text-crit-ink">{n.error}</span> : null}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="mt-1.5 text-[12px] leading-4 text-ink-3">
              Each attempt is shown with its recorded outcome. A channel that has not been set up is recorded as “Not configured”, never as delivered.
            </p>
          </Section>

          {alert.acknowledged_at || alert.resolved_at ? (
            <Section title="Handling">
              <DescriptionList
                items={[
                  {
                    label: 'Acknowledged',
                    hidden: !alert.acknowledged_at,
                    value: (
                      <span>
                        <MarketTime iso={alert.acknowledged_at} /> {alert.acknowledged_by_name ? `by ${alert.acknowledged_by_name}` : ''}
                      </span>
                    ),
                  },
                  {
                    label: 'Resolved',
                    hidden: !alert.resolved_at,
                    value: (
                      <span>
                        <MarketTime iso={alert.resolved_at} /> {alert.resolved_by_name ? `by ${alert.resolved_by_name}` : ''}
                      </span>
                    ),
                  },
                  { label: 'Resolution note', value: alert.resolution_note ?? '—', hidden: !alert.resolution_note },
                ]}
              />
            </Section>
          ) : null}

          {isStateAlert(alert.type) ? (
            <Notice tone="info" className="mt-5">
              This alert describes a condition that is checked continuously. <strong className="font-semibold text-ink">Acknowledge</strong> keeps it quiet while the
              condition lasts. <strong className="font-semibold text-ink">Resolve</strong> closes it — it re-opens at the next check if the condition is still true, and
              closes by itself once fresh data arrives.
            </Notice>
          ) : null}

          {canManage && alert.status !== 'resolved' ? (
            <Field label="Resolution note (optional)" hint="Saved with the alert when you resolve it." className="mt-5">
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="What was checked or decided" />
            </Field>
          ) : null}
          <p className="mt-4 text-[11.5px] text-ink-4">Alert #{alert.id} · triggered {fmtDate(alert.triggered_at.slice(0, 10))} (UTC date)</p>
        </div>
      )}
    </Drawer>
  );
}
