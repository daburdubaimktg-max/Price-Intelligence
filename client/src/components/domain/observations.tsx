/**
 * Shared observation widgets (used by the monitor, catalogue, history and collection screens):
 *   ListingDrawer            latest price, history chart and recent observations of one retailer listing
 *   ObservationDrawer        full provenance of one observation (source, evidence, confidence, void / restore)
 *   ManualObservationDialog  manual price entry with optional supporting evidence
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, ExternalLink, FileText, History, Plus, RotateCcw, Upload } from 'lucide-react';
import { ApiError, apiGet, apiPost, apiUpload, fetchObjectUrl, type Paged } from '@/lib/api.ts';
import { useCan } from '@/lib/auth.tsx';
import { DASH, fmtDate, fmtDateTime, fmtMoney, fmtNumber, fmtPct, fmtPrice, titleCase, tzLabel } from '@/lib/format.ts';
import { addDays, useDates, useReference } from '@/lib/hooks.ts';
import { ChartEmpty, ChartFrame } from '@/components/charts/kit.tsx';
import { seriesTable, TimeSeriesChart } from '@/components/charts/charts.tsx';
import { DataTable, type Column } from '@/components/ui/data-table.tsx';
import { ConfirmDialog, Dialog, Drawer, useToast } from '@/components/ui/overlays.tsx';
import { Badge, Button, DescriptionList, ErrorState, Field, Input, LoadingBlock, Notice, Segmented, Select, Textarea } from '@/components/ui/primitives.tsx';
import {
  AVAILABILITY, AVAILABILITY_LABELS, COLLECTION_METHOD_LABELS, PROMO_TYPE_LABELS, PROMO_TYPES, type Availability, type PromoType,
} from '@shared/constants.ts';
import { unitBasisLabel } from '@shared/units.ts';
import type { TimelineResult } from '@shared/api/analytics.ts';
import type { ListingRow } from '@shared/api/catalogue.ts';
import type { EvidenceRecord, ManualObservationInput, ManualObservationResponse, ObservationDetail, ObservationRecord } from '@shared/api/observations.ts';
import {
  AvailabilityBadge, ConfidenceBadge, DataClassBadge, DemoBadge, FreshnessCell, MarketTime, OwnershipBadge, PriceCell, PromoBadge, UnitPriceCell,
} from './domain.tsx';
import { DealTagChips, hasSignals, signalItems, SignalLine } from './signals.tsx';

const BASIS_TEXT: Record<string, string> = {
  exact: 'Exact time from the source',
  date_only: 'Date only — the time of day is unknown (12:00 market time assumed)',
  import_time: 'Original date not available — the import time was used',
};

function isRealUrl(url: string | null | undefined): url is string {
  return !!url && /^https?:\/\//i.test(url) && !/\.invalid(\/|$)/i.test(url);
}

function UrlText({ url }: { url: string | null | undefined }) {
  if (!url) return <span className="text-ink-4">{DASH}</span>;
  if (!isRealUrl(url)) {
    return (
      <span className="break-all text-ink-3" title="Placeholder address of a demo listing — it does not point to a real page">
        {url}
      </span>
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer noopener" className="link inline-flex items-center gap-1 break-all">
      {url} <ExternalLink className="size-3 shrink-0" aria-hidden />
    </a>
  );
}

// ---------------------------------------------------------------------------------------------
// Observation drawer
// ---------------------------------------------------------------------------------------------
export interface ObservationDrawerProps {
  observationId: number | null;
  onClose: () => void;
  /** Called after the observation was voided or restored. */
  onChanged?: () => void;
}

export function ObservationDrawer({ observationId, onClose, onChanged }: ObservationDrawerProps) {
  const canVoid = useCan('observations.void');
  const toast = useToast();
  const client = useQueryClient();
  const [voidOpen, setVoidOpen] = useState(false);
  const [reason, setReason] = useState('');
  const detail = useQuery({
    queryKey: ['observation', observationId],
    queryFn: () => apiGet<ObservationDetail>(`/observations/${observationId}`),
    enabled: observationId !== null,
  });
  const refreshAll = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['observation'] }),
      client.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === 'string' && q.queryKey[0] !== 'auth' && q.queryKey[0] !== 'reference' && q.queryKey[0] !== 'observation' }),
    ]);
    onChanged?.();
  };
  const voidMutation = useMutation({
    mutationFn: () => apiPost(`/observations/${observationId}/void`, { reason }),
    onSuccess: async () => {
      toast.success('Observation voided', 'It stays in the ledger but is excluded from analytics.');
      setVoidOpen(false);
      setReason('');
      await refreshAll();
    },
    onError: (err) => toast.fromError(err, 'Could not void the observation'),
  });
  const restoreMutation = useMutation({
    mutationFn: () => apiPost(`/observations/${observationId}/restore`),
    onSuccess: async () => {
      toast.success('Observation restored');
      await refreshAll();
    },
    onError: (err) => toast.fromError(err, 'Could not restore the observation'),
  });

  const data = detail.data;
  const o = data?.observation;
  const openEvidence = async (evidence: EvidenceRecord) => {
    try {
      const url = await fetchObjectUrl(`/evidence/${evidence.id}/file`);
      window.open(url, '_blank', 'noopener');
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      toast.fromError(err, 'Could not open the evidence file');
    }
  };

  return (
    <>
      <Drawer
        open={observationId !== null}
        onClose={onClose}
        width="md"
        title={o ? (o.product_name ?? o.listing_title ?? 'Observation') : 'Observation'}
        subtitle={o ? `${o.retailer_name} · ${o.market_name} · observation #${o.id}` : undefined}
        footer={
          o && canVoid ? (
            data?.void ? (
              <Button icon={RotateCcw} loading={restoreMutation.isPending} onClick={() => restoreMutation.mutate()}>
                Restore observation
              </Button>
            ) : (
              <Button variant="danger" icon={Ban} onClick={() => setVoidOpen(true)}>
                Void observation
              </Button>
            )
          ) : undefined
        }
      >
        {detail.isPending ? (
          <LoadingBlock />
        ) : detail.isError || !data || !o ? (
          <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
        ) : (
          <div className="flex flex-col gap-5">
            {data.void ? (
              <Notice tone="warn" icon={Ban} title="Voided — excluded from analytics">
                {data.void.reason}
                <span className="block text-ink-3">
                  {fmtDateTime(data.void.voided_at)} {data.void.voided_by_name ? `by ${data.void.voided_by_name}` : ''}. The record is retained in the ledger.
                </span>
              </Notice>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <DataClassBadge value={o.data_class} />
              {o.is_demo ? <DemoBadge /> : null}
              <ConfidenceBadge value={o.confidence} />
              {o.is_promo ? <PromoBadge type={o.promo_type} discount={o.discount_pct} description={o.promo_description} /> : null}
              <AvailabilityBadge value={o.availability} />
              <DealTagChips tags={o.tags} tagText={o.tag_text} />
            </div>

            <section>
              <h4 className="eyebrow mb-2">Price</h4>
              <DescriptionList
                items={[
                  { label: 'Current selling price', value: <span className="num">{fmtMoney(o.current_price, o.currency_code)}</span> },
                  { label: 'Regular listed price', value: <span className="num">{fmtMoney(o.regular_price, o.currency_code)}</span> },
                  { label: 'Promotional price', value: <span className="num">{fmtMoney(o.promo_price, o.currency_code)}</span>, hidden: !o.is_promo },
                  { label: 'Discount', value: fmtPct(o.discount_pct), hidden: !o.is_promo },
                  { label: 'Promotion', value: [o.promo_type ? PROMO_TYPE_LABELS[o.promo_type] : null, o.promo_description].filter(Boolean).join(' — ') || DASH, hidden: !o.is_promo },
                  {
                    label: 'Stated promotion dates',
                    value: `${o.promo_starts_on ? fmtDate(o.promo_starts_on) : '?'} – ${o.promo_ends_on ? fmtDate(o.promo_ends_on) : '?'}`,
                    hidden: !o.promo_starts_on && !o.promo_ends_on,
                  },
                  { label: `Unit price ${unitBasisLabel(o.content_dimension)}`, value: <UnitPriceCell value={o.unit_price} currency={o.currency_code} />, hidden: o.unit_price === null },
                  { label: 'Availability', value: AVAILABILITY_LABELS[o.availability] },
                  {
                    label: 'Neighbouring observations',
                    value: (
                      <span className="num text-ink-2">
                        {data.previous ? `${fmtPrice(data.previous.current_price, o.currency_code)} (${fmtDate(data.previous.observed_local_date)})` : 'none before'} →{' '}
                        <strong className="text-ink">{fmtPrice(o.current_price, o.currency_code)}</strong> →{' '}
                        {data.next ? `${fmtPrice(data.next.current_price, o.currency_code)} (${fmtDate(data.next.observed_local_date)})` : 'latest'}
                      </span>
                    ),
                  },
                ]}
              />
            </section>

            {hasSignals(o) ? (
              <section>
                <h4 className="eyebrow mb-2">Shown with the price</h4>
                <DescriptionList items={signalItems(o)} />
                <p className="mt-2 text-[12px] leading-4 text-ink-3">Tags, rating, rank and seller as the retailer showed them at this observation. They are kept with it, like the price.</p>
              </section>
            ) : null}

            <section>
              <h4 className="eyebrow mb-2">When</h4>
              <DescriptionList
                items={[
                  { label: 'Observed (market time)', value: <MarketTime iso={o.observed_at} timeZone={o.timezone} /> },
                  { label: 'Observed (UTC)', value: <span className="num">{o.observed_at.replace('T', ' ').replace(/\.\d+Z$/, '')}</span> },
                  { label: 'Timestamp basis', value: BASIS_TEXT[o.observed_basis] ?? o.observed_basis },
                  { label: 'Collected by this system', value: <MarketTime iso={o.collected_at} timeZone={o.timezone} /> },
                  { label: 'Timestamp reported by the source', value: <MarketTime iso={o.source_timestamp} timeZone={o.timezone} />, hidden: !o.source_timestamp },
                ]}
              />
            </section>

            <section>
              <h4 className="eyebrow mb-2">Source and evidence</h4>
              <DescriptionList
                items={[
                  { label: 'Source method', value: COLLECTION_METHOD_LABELS[o.source_method] },
                  { label: 'Capture', value: o.collection_status === 'complete' ? 'Complete' : 'Partial (some fields missing)' },
                  {
                    label: 'Collection job',
                    value: data.job ? `#${data.job.id} · ${titleCase(data.job.status)} · ${data.job.data_class === 'simulated' ? 'simulated demo run' : 'real run'}` : DASH,
                    hidden: !data.job,
                  },
                  { label: 'Import file', value: data.import_batch ? `${data.import_batch.file_name} (batch #${data.import_batch.id})` : DASH, hidden: !data.import_batch },
                  { label: 'Entered by', value: data.entered_by?.name ?? DASH, hidden: !data.entered_by },
                  { label: 'Listing', value: <span className="mono">{o.listing_code}</span> },
                  { label: 'Product URL at observation', value: <UrlText url={o.product_url ?? o.listing_url} /> },
                  { label: 'Note', value: o.note ?? DASH, hidden: !o.note },
                ]}
              />
              {data.evidence ? (
                <div className="mt-3 rounded-lg border border-line bg-sunken p-3 text-[12.5px] leading-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 font-medium text-ink">
                      <FileText className="size-3.5 text-ink-3" aria-hidden /> Evidence · {titleCase(data.evidence.kind)}
                      {data.evidence.is_demo ? <DemoBadge /> : null}
                    </span>
                    {data.evidence.has_file ? (
                      <Button size="sm" onClick={() => void openEvidence(data.evidence!)}>
                        Open file
                      </Button>
                    ) : null}
                  </div>
                  <p className="mt-1 break-all text-ink-2">{data.evidence.reference}</p>
                  {data.evidence.note ? <p className="text-ink-3">{data.evidence.note}</p> : null}
                  {data.evidence.excerpt ? <pre className="mono mt-2 max-h-32 overflow-auto rounded bg-surface p-2 whitespace-pre-wrap text-ink-2">{data.evidence.excerpt}</pre> : null}
                  {data.evidence.sha256 ? <p className="mono mt-1 break-all text-ink-4">sha256 {data.evidence.sha256}</p> : null}
                </div>
              ) : (
                <p className="mt-2 text-[12.5px] text-ink-3">No evidence reference is attached to this observation.</p>
              )}
            </section>

            <div className="flex flex-wrap gap-2">
              {o.product_id ? (
                <Link to={`/catalogue/products/${o.product_id}`} className="link text-[13px]" onClick={onClose}>
                  Open product
                </Link>
              ) : null}
              <Link to={`/history?listing_id=${o.listing_id}`} className="link text-[13px]" onClick={onClose}>
                Full history of this listing
              </Link>
            </div>
          </div>
        )}
      </Drawer>
      <ConfirmDialog
        open={voidOpen}
        onClose={() => setVoidOpen(false)}
        onConfirm={() => reason.trim().length >= 3 && voidMutation.mutate()}
        title="Void this observation?"
        confirmLabel="Void observation"
        danger
        loading={voidMutation.isPending}
      >
        <p className="mb-3">
          The record is never deleted or changed. Voiding excludes it from prices, charts and alerts, and can be undone. Say why, for the audit trail.
        </p>
        <Field label="Reason" required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. wrong currency in the source file" autoFocus />
        </Field>
      </ConfirmDialog>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Listing drawer
// ---------------------------------------------------------------------------------------------
export interface ListingDrawerProps {
  listingId: number | null;
  onClose: () => void;
}

export function ListingDrawer({ listingId, onClose }: ListingDrawerProps) {
  const canWrite = useCan('observations.write');
  const dates = useDates();
  const [days, setDays] = useState<'30' | '90' | 'all'>('90');
  const [observationId, setObservationId] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const client = useQueryClient();
  const enabled = listingId !== null;
  const listing = useQuery({ queryKey: ['listing', listingId], queryFn: () => apiGet<ListingRow>(`/listings/${listingId}`), enabled });
  const today = dates.data?.today;
  const from = days === 'all' || !today ? undefined : addDays(today, -(Number(days) - 1));
  const history = useQuery({
    queryKey: ['listing-timeline', listingId, days, today],
    queryFn: () => apiGet<TimelineResult>('/history/timeline', { listing_id: listingId!, group_by: 'listing', include_unmatched: true, from: from ?? '2000-01-01', to: today }),
    enabled: enabled && !!today,
  });
  const recent = useQuery({
    queryKey: ['listing-observations', listingId],
    queryFn: () => apiGet<Paged<ObservationRecord>>('/observations', { listing_id: listingId!, include_unmatched: true, page_size: 12 }),
    enabled,
  });

  const l = listing.data;
  // tags, rating, rank and seller belong to an observation; the latest one describes the listing as it is now
  const latestSignals = recent.data?.rows.find((r) => r.id === l?.latest?.observation_id) ?? null;
  const series = history.data?.series[0];
  const chartSeries = useMemo(
    () => (series ? [{ key: series.key, label: 'Selling price', points: series.points.map((p) => ({ date: p.date, value: p.value, promo: p.promo > 0 })) }] : []),
    [series],
  );
  const currency = l?.currency_code ?? null;
  const columns: Array<Column<ObservationRecord>> = [
    { key: 'when', header: 'Observed', cell: (r) => <MarketTime iso={r.observed_at} timeZone={r.timezone} short /> },
    { key: 'price', header: 'Price', align: 'right', cell: (r) => <PriceCell price={r.current_price} regular={r.regular_price} currency={r.currency_code} isPromo={r.is_promo} showCurrency={false} /> },
    {
      key: 'promo',
      header: 'Offer · tags',
      hideBelow: 'sm',
      cell: (r) =>
        r.is_promo || r.tags.length ? (
          <span className="flex max-w-56 flex-wrap items-center gap-1">
            {r.is_promo ? <PromoBadge type={r.promo_type} discount={r.discount_pct} description={r.promo_description} /> : null}
            <DealTagChips tags={r.tags} tagText={r.tag_text} max={2} />
          </span>
        ) : (
          <span className="text-ink-4">{DASH}</span>
        ),
    },
    { key: 'avail', header: 'Availability', cell: (r) => <AvailabilityBadge value={r.availability} />, hideBelow: 'sm' },
    { key: 'source', header: 'Source', cell: (r) => <DataClassBadge value={r.data_class} short /> },
  ];

  return (
    <>
      <Drawer
        open={enabled}
        onClose={onClose}
        width="lg"
        title={l ? (l.product_name ?? l.title ?? l.code) : 'Listing'}
        subtitle={
          l ? (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>
                {l.retailer_name} · {l.market_name}
              </span>
              <span className="mono">{l.code}</span>
              {l.is_demo ? <DemoBadge /> : null}
              {l.match_status !== 'matched' ? <Badge tone="warn">{l.match_status === 'ignored' ? 'Ignored' : 'Not matched to a product'}</Badge> : <OwnershipBadge ownership={l.ownership} />}
              {!l.is_active ? <Badge tone="outline">Inactive</Badge> : null}
            </span>
          ) : undefined
        }
        footer={
          l ? (
            <>
              <Link to={`/history?listing_id=${l.id}`} onClick={onClose}>
                <Button icon={History}>Open in History Explorer</Button>
              </Link>
              {canWrite && l.is_active ? (
                <Button variant="primary" icon={Plus} onClick={() => setAddOpen(true)}>
                  Add observation
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      >
        {listing.isPending ? (
          <LoadingBlock />
        ) : listing.isError || !l ? (
          <ErrorState error={listing.error} onRetry={() => void listing.refetch()} />
        ) : (
          <div className="flex flex-col gap-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg border border-line p-3">
                <div className="eyebrow">Current price</div>
                <div className="mt-1 text-[18px] leading-6 font-semibold text-ink">{l.latest ? fmtMoney(l.latest.current_price, currency) : DASH}</div>
                {l.latest?.is_promo ? (
                  <div className="mt-1">
                    <PromoBadge type={l.latest.promo_type} discount={l.latest.discount_pct} />
                  </div>
                ) : null}
              </div>
              <div className="rounded-lg border border-line p-3">
                <div className="eyebrow">Regular price</div>
                <div className="num mt-1 text-[15px] leading-6 font-medium text-ink">{l.latest ? fmtMoney(l.latest.regular_price, currency) : DASH}</div>
                <div className="num text-[12px] text-ink-3">Previous: {fmtPrice(l.previous_price, currency)}</div>
              </div>
              <div className="rounded-lg border border-line p-3">
                <div className="eyebrow">Unit price</div>
                <div className="mt-1 text-[15px] leading-6 font-medium">
                  <UnitPriceCell value={l.latest?.unit_price} currency={currency} dimension={l.content_dimension} />
                </div>
                <div className="text-[12px] text-ink-3">{l.variant_name ?? l.pack_label ?? DASH}</div>
              </div>
              <div className="rounded-lg border border-line p-3">
                <div className="eyebrow">Last observed</div>
                <div className="mt-1 text-[13px] leading-6">
                  <FreshnessCell iso={l.last_observed_at} timeZone={l.timezone} />
                </div>
                <div className="text-[12px] text-ink-3">{fmtNumber(l.obs_count)} observations</div>
              </div>
            </div>

            {latestSignals && hasSignals(latestSignals) ? (
              <section aria-label="Shown with the latest price" className="-mt-1 flex flex-col gap-1.5 rounded-lg border border-line bg-sunken px-3 py-2.5">
                <div className="eyebrow">Shown with the latest price</div>
                <DealTagChips tags={latestSignals.tags} tagText={latestSignals.tag_text} variant="full" />
                <SignalLine signals={latestSignals} className="text-[12.5px]" />
              </section>
            ) : null}

            <ChartFrame
              title="Selling price history"
              subtitle={`${currency ?? ''} · last daily observation · gaps mean no observation was captured`}
              actions={<Segmented size="sm" value={days} onChange={setDays} options={[{ value: '30', label: '30 d' }, { value: '90', label: '90 d' }, { value: 'all', label: 'All' }]} label="Period" />}
              table={chartSeries.length ? seriesTable(chartSeries, (v) => fmtPrice(v, currency)) : null}
              refetching={history.isFetching && !history.isPending}
              empty={!history.isPending && chartSeries.length === 0 ? <ChartEmpty title="No observations in this period" /> : undefined}
              className="!border-line"
            >
              {history.isPending ? <LoadingBlock /> : <TimeSeriesChart series={chartSeries} colorScope={`listing-${listingId}`} height={220} curve="step" formatValue={(v) => fmtPrice(v, currency)} valueLabel="Selling price" />}
            </ChartFrame>

            <section>
              <h4 className="eyebrow mb-2">Listing</h4>
              <DescriptionList
                items={[
                  { label: 'Retailer item id', value: l.external_id ? <span className="mono">{l.external_id}</span> : DASH },
                  { label: 'Title at retailer', value: l.title ?? DASH },
                  { label: 'URL', value: <UrlText url={l.url} /> },
                  { label: 'Source method', value: COLLECTION_METHOD_LABELS[l.collection_method] },
                  { label: 'First observed', value: <MarketTime iso={l.first_observed_at} timeZone={l.timezone} /> },
                  { label: 'Last price change', value: <MarketTime iso={l.last_price_change_at} timeZone={l.timezone} /> },
                  {
                    label: 'Product',
                    value: l.product_id ? (
                      <Link to={`/catalogue/products/${l.product_id}`} className="link" onClick={onClose}>
                        {l.product_name}
                      </Link>
                    ) : (
                      <Link to="/catalogue?tab=matching" className="link" onClick={onClose}>
                        Match this listing to a product
                      </Link>
                    ),
                  },
                ]}
              />
            </section>

            <section>
              <h4 className="eyebrow mb-2">Latest observations</h4>
              <div className="rounded-lg border border-line">
                <DataTable columns={columns} rows={recent.data?.rows} rowKey={(r) => r.id} loading={recent.isPending} dense onRowClick={(r) => setObservationId(r.id)} />
              </div>
              <p className="mt-2 text-[12px] text-ink-3">Times are in {l.market_name} local time ({tzLabel(l.timezone)}). Select a row for its full provenance.</p>
            </section>
          </div>
        )}
      </Drawer>
      <ObservationDrawer observationId={observationId} onClose={() => setObservationId(null)} />
      <ManualObservationDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        listingId={listingId}
        onSaved={() => {
          void client.invalidateQueries({ queryKey: ['listing'] });
          void client.invalidateQueries({ queryKey: ['listing-timeline'] });
          void client.invalidateQueries({ queryKey: ['listing-observations'] });
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Manual price entry
// ---------------------------------------------------------------------------------------------
export interface ManualObservationDialogProps {
  open: boolean;
  onClose: () => void;
  /** Pre-select a listing… */
  listingId?: number | null;
  /** …or limit the listing choice to one product. */
  productId?: number | null;
  onSaved?: () => void;
}

const numberOrNull = (text: string): number | null => {
  const t = text.trim().replace(/,/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : Number.NaN;
};

export function ManualObservationDialog({ open, onClose, listingId, productId, onSaved }: ManualObservationDialogProps) {
  const { ref } = useReference();
  const toast = useToast();
  const client = useQueryClient();
  const [retailerId, setRetailerId] = useState('');
  const [chosenListing, setChosenListing] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [regular, setRegular] = useState('');
  const [current, setCurrent] = useState('');
  const [promo, setPromo] = useState('');
  const [discount, setDiscount] = useState('');
  const [promoType, setPromoType] = useState<'' | PromoType>('');
  const [promoDescription, setPromoDescription] = useState('');
  const [promoStart, setPromoStart] = useState('');
  const [promoEnd, setPromoEnd] = useState('');
  const [availability, setAvailability] = useState<Availability>('in_stock');
  const [confidence, setConfidence] = useState('0.95');
  const [note, setNote] = useState('');
  const [evidenceMode, setEvidenceMode] = useState<'none' | 'url' | 'note' | 'file'>('none');
  const [evidenceText, setEvidenceText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRetailerId('');
    setChosenListing(listingId ? String(listingId) : '');
    setDate('');
    setTime('');
    setRegular('');
    setCurrent('');
    setPromo('');
    setDiscount('');
    setPromoType('');
    setPromoDescription('');
    setPromoStart('');
    setPromoEnd('');
    setAvailability('in_stock');
    setConfidence('0.95');
    setNote('');
    setEvidenceMode('none');
    setEvidenceText('');
    setFile(null);
    setError(null);
  }, [open, listingId]);

  const fixed = useQuery({ queryKey: ['listing', listingId], queryFn: () => apiGet<ListingRow>(`/listings/${listingId}`), enabled: open && !!listingId });
  const choices = useQuery({
    queryKey: ['listing-choices', productId ?? null, retailerId],
    queryFn: () => apiGet<Paged<ListingRow>>('/listings', { product_id: productId ?? undefined, retailer_id: retailerId || undefined, active: true, page_size: 200, sort: 'product' }),
    enabled: open && !listingId && (!!productId || !!retailerId),
  });
  const listing = listingId ? fixed.data : choices.data?.rows.find((l) => String(l.id) === chosenListing);
  const currency = listing?.currency_code ?? '';
  const hasPromo = !!promo || !!promoType || !!promoDescription || !!discount;

  const save = useMutation({
    mutationFn: async () => {
      const values = { regular: numberOrNull(regular), current: numberOrNull(current), promo: numberOrNull(promo), discount: numberOrNull(discount) };
      if (Object.values(values).some((v) => Number.isNaN(v))) throw new Error('Prices and discount must be numbers.');
      if (!listing) throw new Error('Choose the retailer listing this price belongs to.');
      if (values.current === null && values.promo === null && values.regular === null && availability !== 'out_of_stock') {
        throw new Error('Enter a selling price, or mark the product as out of stock.');
      }
      let evidenceId: number | null = null;
      let inlineEvidence: ManualObservationInput['evidence'] = null;
      if (evidenceMode === 'file') {
        if (!file) throw new Error('Choose the evidence file to attach, or switch evidence to "None".');
        const form = new FormData();
        form.append('kind', file.type.startsWith('image/') ? 'screenshot' : 'document');
        if (evidenceText.trim()) form.append('note', evidenceText.trim());
        form.append('file', file);
        evidenceId = (await apiUpload<EvidenceRecord>('/evidence', form)).id;
      } else if (evidenceMode !== 'none') {
        if (!evidenceText.trim()) throw new Error(evidenceMode === 'url' ? 'Enter the evidence URL.' : 'Describe the evidence.');
        inlineEvidence = { kind: evidenceMode, reference: evidenceText.trim() };
      }
      const body: ManualObservationInput = {
        listing_id: listing.id,
        observed_date: date || null,
        observed_time: date && time ? time : null,
        regular_price: values.regular,
        current_price: values.current,
        promo_price: values.promo,
        discount_pct: values.discount,
        promo_type: promoType || null,
        promo_description: promoDescription.trim() || null,
        promo_starts_on: promoStart || null,
        promo_ends_on: promoEnd || null,
        availability,
        confidence: Number(confidence),
        note: note.trim() || null,
        evidence_id: evidenceId,
        evidence: inlineEvidence,
      };
      return apiPost<ManualObservationResponse>('/observations', body);
    },
    onSuccess: async (res) => {
      toast.success('Observation recorded', res.superseded ? 'It superseded an earlier record for the same timestamp (kept in the ledger, marked void).' : 'Added to the price ledger as a manual entry.');
      await client.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'auth' && q.queryKey[0] !== 'reference' });
      onSaved?.();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError || err instanceof Error ? err.message : 'Could not save the observation'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    save.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add price observation"
      description="Manual entries are stored permanently with their timestamp and are labelled as manual in every view."
      size="lg"
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="manual-observation-form" loading={save.isPending}>
            Record observation
          </Button>
        </>
      }
    >
      <form id="manual-observation-form" onSubmit={submit} className="flex flex-col gap-4">
        {error ? <Notice tone="crit">{error}</Notice> : null}

        {listingId ? (
          <div className="rounded-lg border border-line bg-sunken px-3 py-2.5 text-[13px]">
            {fixed.isPending ? (
              'Loading listing…'
            ) : listing ? (
              <>
                <span className="font-medium text-ink">{listing.product_name ?? listing.title ?? listing.code}</span>
                <span className="text-ink-3">
                  {' '}
                  · {listing.retailer_name} · {listing.market_name} · {listing.pack_label || 'pack n/a'} · <span className="mono">{listing.code}</span>
                </span>
              </>
            ) : (
              'Listing not found'
            )}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Retailer" required={!productId} hint={productId ? 'Optional — narrows the listing choice.' : undefined}>
              <Select
                value={retailerId}
                onChange={(e) => {
                  setRetailerId(e.target.value);
                  setChosenListing('');
                }}
              >
                <option value="">{productId ? 'All retailers' : 'Choose a retailer…'}</option>
                {(ref?.retailers ?? [])
                  .filter((r) => r.is_active)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({ref?.markets.find((m) => m.id === r.market_id)?.code}){r.is_demo ? ' — demo' : ''}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Listing" required hint={choices.data && choices.data.rows.length === 0 ? 'No active listing found — add one in the product catalogue first.' : undefined}>
              <Select value={chosenListing} onChange={(e) => setChosenListing(e.target.value)} disabled={!choices.data}>
                <option value="">{choices.isFetching ? 'Loading…' : 'Choose a listing…'}</option>
                {(choices.data?.rows ?? []).map((l) => (
                  <option key={l.id} value={l.id}>
                    {(l.product_name ?? l.title ?? l.code) + (productId ? ` — ${l.retailer_name} (${l.market_code})` : '') + (l.variant_name ? ` · ${l.variant_name}` : '')}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={`Current selling price${currency ? ` (${currency})` : ''}`} required={availability !== 'out_of_stock'}>
            <Input inputMode="decimal" value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="0.00" className="num" />
          </Field>
          <Field label={`Regular listed price${currency ? ` (${currency})` : ''}`}>
            <Input inputMode="decimal" value={regular} onChange={(e) => setRegular(e.target.value)} placeholder="0.00" className="num" />
          </Field>
          <Field label="Availability">
            <Select value={availability} onChange={(e) => setAvailability(e.target.value as Availability)}>
              {AVAILABILITY.map((a) => (
                <option key={a} value={a}>
                  {AVAILABILITY_LABELS[a]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <fieldset className="rounded-lg border border-line p-3">
          <legend className="eyebrow px-1">Promotion (optional)</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Promotion type">
              <Select value={promoType} onChange={(e) => setPromoType(e.target.value as PromoType | '')}>
                <option value="">No promotion</option>
                {PROMO_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {PROMO_TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={`Promotional price${currency ? ` (${currency})` : ''}`}>
              <Input inputMode="decimal" value={promo} onChange={(e) => setPromo(e.target.value)} placeholder="0.00" className="num" />
            </Field>
            <Field label="Discount %" hint="Leave blank to calculate from the prices.">
              <Input inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="auto" className="num" />
            </Field>
            <Field label="Offer text" className="sm:col-span-3">
              <Input value={promoDescription} onChange={(e) => setPromoDescription(e.target.value)} placeholder='e.g. "Buy 2, save 20%"' maxLength={300} />
            </Field>
            {hasPromo ? (
              <>
                <Field label="Offer starts">
                  <Input type="date" value={promoStart} onChange={(e) => setPromoStart(e.target.value)} />
                </Field>
                <Field label="Offer ends">
                  <Input type="date" value={promoEnd} min={promoStart || undefined} onChange={(e) => setPromoEnd(e.target.value)} />
                </Field>
              </>
            ) : null}
          </div>
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Observation date" hint={listing ? `Blank = now. ${listing.market_name} local time (${tzLabel(listing.timezone)}).` : 'Blank = now.'}>
            <Input type="date" value={date} max={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Time" hint="Optional. Without it the entry is marked date-only.">
            <Input type="time" value={time} disabled={!date} onChange={(e) => setTime(e.target.value)} />
          </Field>
          <Field label="Confidence" hint="How sure are you of this reading?">
            <Select value={confidence} onChange={(e) => setConfidence(e.target.value)}>
              <option value="0.95">High — read directly</option>
              <option value="0.7">Medium — second-hand</option>
              <option value="0.4">Low — uncertain</option>
            </Select>
          </Field>
        </div>

        <fieldset className="rounded-lg border border-line p-3">
          <legend className="eyebrow px-1">Evidence (optional)</legend>
          <div className="flex flex-col gap-3">
            <Segmented
              size="sm"
              value={evidenceMode}
              onChange={setEvidenceMode}
              label="Evidence type"
              options={[
                { value: 'none', label: 'None' },
                { value: 'file', label: 'Screenshot / file' },
                { value: 'url', label: 'URL' },
                { value: 'note', label: 'Note' },
              ]}
            />
            {evidenceMode === 'file' ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="File" hint="PNG, JPEG, WebP, PDF, CSV or text, up to 15 MB.">
                  <label className="flex h-[34px] cursor-pointer items-center gap-2 rounded-lg border border-dashed border-line-strong px-3 text-[13px] text-ink-2 hover:border-ink-4">
                    <Upload className="size-3.5" aria-hidden />
                    <span className="truncate">{file ? file.name : 'Choose a file…'}</span>
                    <input type="file" className="sr-only" accept="image/png,image/jpeg,image/webp,application/pdf,text/csv,text/plain" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                  </label>
                </Field>
                <Field label="What it shows">
                  <Input value={evidenceText} onChange={(e) => setEvidenceText(e.target.value)} placeholder="e.g. shelf photo, store #12" maxLength={300} />
                </Field>
              </div>
            ) : evidenceMode !== 'none' ? (
              <Field label={evidenceMode === 'url' ? 'Evidence URL' : 'Evidence description'}>
                <Input value={evidenceText} onChange={(e) => setEvidenceText(e.target.value)} placeholder={evidenceMode === 'url' ? 'https://…' : 'e.g. price list e-mailed by the retailer on 12 Nov'} maxLength={500} />
              </Field>
            ) : null}
          </div>
        </fieldset>

        <Field label="Note">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
        </Field>
      </form>
    </Dialog>
  );
}
