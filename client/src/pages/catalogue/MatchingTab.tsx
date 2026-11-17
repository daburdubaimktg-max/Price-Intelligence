/**
 * Matching tab: retailer listings that are not linked to a canonical product.
 * Suggestions are only ever suggestions — a person approves or rejects each one.
 */
import { useState } from 'react';
import { Check, CircleCheck, EyeOff, Info, Link2, RefreshCw, Undo2, X } from 'lucide-react';
import { apiPost } from '@/lib/api.ts';
import { useCan } from '@/lib/auth.tsx';
import { fmtNumber, fmtPct } from '@/lib/format.ts';
import { useApiQuery, useReference, useUrlState, toList, fromList } from '@/lib/hooks.ts';
import { Pagination } from '@/components/ui/data-table.tsx';
import { FilterBar, MultiSelect, ProductPicker, SearchInput } from '@/components/ui/filters.tsx';
import { Dialog } from '@/components/ui/overlays.tsx';
import { Badge, Button, Card, cn, EmptyState, ErrorState, Field, LoadingBlock, Notice, Segmented, Select } from '@/components/ui/primitives.tsx';
import { DataClassBadge, DemoBadge, FreshnessCell, OwnershipDot, PriceCell } from '@/components/domain/domain.tsx';
import { ListingDrawer } from '@/components/domain/observations.tsx';
import type { MatchingListing, MatchingListResponse, MatchSuggestion, ProductDetail, ProductOption } from '@shared/api/catalogue.ts';
import { CATALOGUE, errorMessage, ExternalUrl, listingIsStale, useCatalogueActions } from './shared.tsx';

function ScoreMeter({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  return (
    <span className="inline-flex items-center gap-2" title={score >= 0.999 ? 'Exact barcode match' : 'Similarity of the listing to this product'}>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-wash" aria-hidden>
        <span className="block h-full rounded-full bg-s1" style={{ width: `${pct}%` }} />
      </span>
      <span className="num text-[12.5px] font-semibold text-ink">{fmtPct(pct, 0)}</span>
    </span>
  );
}

function SuggestionRow({ suggestion, canWrite, busy, onApprove, onReject }: { suggestion: MatchSuggestion; canWrite: boolean; busy: string | null; onApprove: () => void; onReject: () => void }) {
  return (
    <li className="flex flex-col gap-x-4 gap-y-2.5 border-t border-line px-4 py-3 first:border-t-0 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex min-w-0 items-center gap-2">
            <OwnershipDot ownership={suggestion.ownership} />
            <span className="truncate text-[13px] font-medium text-ink">{suggestion.product_name}</span>
            {suggestion.product_is_demo ? <DemoBadge /> : null}
          </span>
          <ScoreMeter score={suggestion.score} />
        </div>
        <p className="mt-0.5 text-[11.5px] leading-4 text-ink-3">
          {[suggestion.brand_name, suggestion.pack_label, suggestion.product_code, suggestion.product_gtin ? `barcode ${suggestion.product_gtin}` : null].filter(Boolean).join(' · ')}
        </p>
        {suggestion.reasons.length ? (
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {suggestion.reasons.map((reason, i) => (
              <li key={i} className={cn('rounded-md px-1.5 py-0.5 text-[11.5px] leading-4', /differ|mismatch|not /i.test(reason) ? 'bg-warn-soft text-warn-ink' : 'bg-wash text-ink-2')}>
                {reason}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {canWrite ? (
        <div className="flex shrink-0 items-center justify-end gap-2">
          <Button size="sm" icon={X} onClick={onReject} loading={busy === `reject-${suggestion.id}`}>
            Reject
          </Button>
          <Button size="sm" variant="primary" icon={Check} onClick={onApprove} loading={busy === `approve-${suggestion.id}`}>
            Approve match
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** Manual match: pick the product, then (optionally) the pack variant the retailer is selling. */
function ManualMatchDialog({ listing, onClose }: { listing: MatchingListing | null; onClose: () => void }) {
  const { run, busy } = useCatalogueActions();
  const [productId, setProductId] = useState<string[]>([]);
  const [picked, setPicked] = useState<ProductOption | null>(null);
  const [variantId, setVariantId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const detail = useApiQuery<ProductDetail>([CATALOGUE, 'product', Number(productId[0] ?? 0)], `/products/${productId[0]}`, undefined, { enabled: productId.length === 1 });
  const variants = (detail.data?.variants ?? []).filter((v) => v.is_active);

  const close = () => {
    setProductId([]);
    setPicked(null);
    setVariantId('');
    setError(null);
    onClose();
  };

  async function submit() {
    if (!listing || productId.length !== 1) return setError('Choose the product this listing is selling.');
    setError(null);
    const outcome = await run(
      'manual-match',
      () => apiPost(`/matching/listings/${listing.id}/match`, { product_id: Number(productId[0]), variant_id: variantId ? Number(variantId) : null }),
      { success: `Listing ${listing.code} matched${picked ? ` to ${picked.name}` : ''}`, quietError: true },
    );
    if (outcome.ok) close();
    else setError(errorMessage(outcome.error, 'The listing could not be matched.'));
  }

  return (
    <Dialog
      open={listing !== null}
      onClose={close}
      title="Match listing to a product"
      description={listing ? `${listing.retailer_name} · ${listing.market_name} · ${listing.code}` : undefined}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" icon={Link2} onClick={() => void submit()} loading={busy === 'manual-match'} disabled={productId.length !== 1}>
            Match listing
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Notice tone="crit">{error}</Notice> : null}
        <div className="rounded-lg border border-line bg-sunken px-3 py-2.5">
          <div className="eyebrow mb-1">Title shown by the retailer</div>
          <p className="text-[13px] font-medium break-words text-ink">{listing?.title ?? 'No title captured'}</p>
          <p className="mt-1 text-[12px] text-ink-3">
            {[listing?.external_id ? `Item id ${listing.external_id}` : null, listing?.gtin ? `Barcode ${listing.gtin}` : null].filter(Boolean).join(' · ') || 'No retailer item id or barcode'}
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-ink-2">Canonical product</span>
          {/* leaves room for the picker's clear button, which sits outside its max-width */}
          <div className="max-w-[calc(100%-28px)]">
          <ProductPicker
            label="Product"
            multiple={false}
            value={productId}
            onChange={(next, option) => {
              setProductId(next);
              setPicked(next.length ? (option ?? null) : null);
              setVariantId('');
            }}
          />
          </div>
          {picked ? (
            <span className="text-[12px] text-ink-3">
              {picked.brand_name} · {picked.pack_label} · {picked.code}
            </span>
          ) : (
            <span className="text-[12px] text-ink-3">Check brand, format and pack size — a similar name does not make it the same SKU.</span>
          )}
        </div>
        {productId.length === 1 ? (
          <Field label="Pack sold by the retailer" hint="Choose a pack variant when the retailer sells a twin pack, bonus pack or other size of this product. Unit prices use the chosen pack.">
            <Select value={variantId} onChange={(e) => setVariantId(e.target.value)} disabled={detail.isPending}>
              <option value="">Standard pack{detail.data ? ` (${detail.data.product.pack_label})` : ''}</option>
              {variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} ({v.pack_label})
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
      </div>
    </Dialog>
  );
}

function ListingCard({
  listing,
  canWrite,
  busy,
  status,
  onApprove,
  onReject,
  onManual,
  onIgnore,
  onUnignore,
  onOpen,
}: {
  listing: MatchingListing;
  canWrite: boolean;
  busy: string | null;
  status: 'unmatched' | 'ignored';
  onApprove: (s: MatchSuggestion) => void;
  onReject: (s: MatchSuggestion) => void;
  onManual: () => void;
  onIgnore: () => void;
  onUnignore: () => void;
  onOpen: () => void;
}) {
  const latest = listing.latest;
  return (
    <Card>
      <div className="flex flex-col gap-x-6 gap-y-3 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-3">
            <span className="font-medium text-ink-2">{listing.retailer_name}</span>
            <Badge tone="outline">{listing.market_name}</Badge>
            <span className="mono">{listing.code}</span>
            {listing.is_demo ? <DemoBadge /> : null}
            {!listing.is_active ? <Badge tone="neutral">Inactive</Badge> : null}
          </div>
          <button type="button" onClick={onOpen} className="mt-1 block max-w-full text-left text-[14px] leading-5 font-semibold break-words text-ink hover:underline" title="Open listing">
            {listing.title ?? 'No title captured'}
          </button>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-3">
            <ExternalUrl url={listing.url} />
            <span>
              Retailer item id: <span className="mono text-ink-2">{listing.external_id ?? '—'}</span>
            </span>
            <span>
              Barcode: <span className="mono text-ink-2">{listing.gtin ?? '—'}</span>
            </span>
          </div>
        </div>
        <div className="shrink-0 sm:text-right">
          <div className="eyebrow mb-0.5">Latest price</div>
          {latest ? (
            <>
              <PriceCell price={latest.current_price} regular={latest.regular_price} currency={listing.currency_code} isPromo={latest.is_promo} />
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] sm:justify-end">
                <FreshnessCell iso={listing.last_observed_at} stale={listingIsStale(listing)} timeZone={listing.timezone} />
                <DataClassBadge value={latest.data_class} short />
              </div>
              <div className="num mt-0.5 text-[11.5px] text-ink-3">{fmtNumber(listing.obs_count)} observations kept</div>
            </>
          ) : (
            <span className="text-[12.5px] text-ink-4">No price observed yet</span>
          )}
        </div>
      </div>

      {status === 'unmatched' ? (
        <div className="border-t border-line">
          <div className="flex items-center justify-between gap-3 bg-sunken px-4 py-1.5">
            <span className="eyebrow">Suggested products</span>
            <span className="text-[11.5px] text-ink-3">{listing.suggestions.length ? `${listing.suggestions.length} to review` : 'none'}</span>
          </div>
          {listing.suggestions.length ? (
            <ul>
              {listing.suggestions.map((s) => (
                <SuggestionRow key={s.id} suggestion={s} canWrite={canWrite} busy={busy} onApprove={() => onApprove(s)} onReject={() => onReject(s)} />
              ))}
            </ul>
          ) : (
            <p className="px-4 py-3 text-[12.5px] text-ink-3">No product in the catalogue is similar enough to suggest. Match it manually, add the product to the catalogue first, or ignore the listing.</p>
          )}
        </div>
      ) : null}

      {canWrite ? (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-2.5">
          {status === 'unmatched' ? (
            <>
              <Button size="sm" variant="ghost" icon={EyeOff} onClick={onIgnore} loading={busy === `ignore-${listing.id}`} title="Not a product we track: keeps the listing and its prices, but removes it from this queue">
                Ignore
              </Button>
              <Button size="sm" icon={Link2} onClick={onManual}>
                Match manually
              </Button>
            </>
          ) : (
            <Button size="sm" icon={Undo2} onClick={onUnignore} loading={busy === `unignore-${listing.id}`}>
              Return to review queue
            </Button>
          )}
        </div>
      ) : null}
    </Card>
  );
}

export function MatchingTab() {
  const canWrite = useCan('catalogue.write');
  const { ref } = useReference();
  const { run, busy } = useCatalogueActions();
  const { state, set, reset, activeCount } = useUrlState({ queue: '', mq: '', m_retailer: '', m_market: '', mpage: '1' });
  const status: 'unmatched' | 'ignored' = state.queue === 'ignored' ? 'ignored' : 'unmatched';
  const page = Math.max(1, Number(state.mpage) || 1);
  const [manual, setManual] = useState<MatchingListing | null>(null);
  const [openListing, setOpenListing] = useState<number | null>(null);

  const listings = useApiQuery<MatchingListResponse>([CATALOGUE, 'matching'], '/matching/listings', {
    status,
    q: state.mq,
    retailer_id: state.m_retailer,
    market_id: state.m_market,
    page,
    page_size: 20,
  });
  const data = listings.data;
  const counts = data?.counts;

  return (
    <div>
      <Notice tone="info" icon={Info} className="mb-4" title="Nothing is matched automatically">
        Identical or similar names do not mean identical SKUs — pack size, format and variant can differ. Each suggestion below shows why it was proposed; a listing is only linked to a product when someone approves it.
        Prices of unmatched listings are still recorded and appear in the product's history once matched.
      </Notice>

      <FilterBar
        onReset={reset}
        activeCount={activeCount}
        trailing={
          canWrite ? (
            <Button
              icon={RefreshCw}
              loading={busy === 'refresh-suggestions'}
              onClick={() =>
                void run('refresh-suggestions', () => apiPost<{ listings: number; pending_suggestions: number }>('/matching/refresh', {}), {
                  success: (r) => `${fmtNumber(r.listings)} unmatched listings checked — ${fmtNumber(r.pending_suggestions)} suggestions to review`,
                })
              }
            >
              Refresh suggestions
            </Button>
          ) : undefined
        }
      >
        <Segmented
          label="Queue"
          value={status}
          onChange={(v) => set({ queue: v === 'ignored' ? 'ignored' : '', mpage: null })}
          options={[
            { value: 'unmatched', label: `Unmatched${counts ? ` (${fmtNumber(counts.unmatched)})` : ''}` },
            { value: 'ignored', label: `Ignored${counts ? ` (${fmtNumber(counts.ignored)})` : ''}` },
          ]}
        />
        <SearchInput value={state.mq ?? ''} onChange={(mq) => set({ mq, mpage: null })} placeholder="Search title, URL, item id…" className="w-64" />
        <MultiSelect
          label="Retailer"
          value={toList(state.m_retailer)}
          onChange={(v) => set({ m_retailer: fromList(v), mpage: null })}
          options={(ref?.retailers ?? []).map((r) => ({ value: String(r.id), label: r.name, sublabel: ref?.markets.find((m) => m.id === r.market_id)?.name }))}
        />
        <MultiSelect
          label="Market"
          value={toList(state.m_market)}
          onChange={(v) => set({ m_market: fromList(v), mpage: null })}
          options={(ref?.markets ?? []).map((m) => ({ value: String(m.id), label: m.name }))}
        />
      </FilterBar>

      {listings.isError && !data ? (
        <Card>
          <ErrorState error={listings.error} onRetry={() => void listings.refetch()} />
        </Card>
      ) : listings.isPending ? (
        <Card>
          <LoadingBlock />
        </Card>
      ) : data && data.rows.length === 0 ? (
        <Card>
          {activeCount > (state.queue ? 1 : 0) ? (
            <EmptyState title="No listings match these filters" action={<Button onClick={reset}>Reset filters</Button>} />
          ) : status === 'unmatched' ? (
            <EmptyState
              icon={CircleCheck}
              title="Every retailer listing is matched"
              description="New listings discovered by a feed or added without a product will appear here for review."
            />
          ) : (
            <EmptyState icon={EyeOff} title="No ignored listings" description="Listings you mark as “not a product we track” are kept here, with their prices, and can be returned to the review queue." />
          )}
        </Card>
      ) : (
        <div className={cn('flex flex-col gap-3 transition-opacity', listings.isPlaceholderData && 'opacity-60')}>
          {data?.rows.map((listing) => (
            <ListingCard
              key={listing.id}
              listing={listing}
              canWrite={canWrite}
              busy={busy}
              status={status}
              onOpen={() => setOpenListing(listing.id)}
              onManual={() => setManual(listing)}
              onApprove={(s) =>
                void run(`approve-${s.id}`, () => apiPost(`/matching/suggestions/${s.id}/approve`), {
                  success: `${listing.code} matched to ${s.product_name}`,
                  errorTitle: 'Could not approve the match',
                })
              }
              onReject={(s) =>
                void run(`reject-${s.id}`, () => apiPost(`/matching/suggestions/${s.id}/reject`), {
                  success: `Suggestion rejected — ${s.product_name} will not be proposed for this listing again`,
                  errorTitle: 'Could not reject the suggestion',
                })
              }
              onIgnore={() => void run(`ignore-${listing.id}`, () => apiPost(`/matching/listings/${listing.id}/ignore`), { success: `${listing.code} ignored — its prices are kept` })}
              onUnignore={() => void run(`unignore-${listing.id}`, () => apiPost(`/matching/listings/${listing.id}/unmatch`), { success: `${listing.code} returned to the review queue` })}
            />
          ))}
          {data ? (
            <Card>
              <Pagination page={data.page} pages={data.pages} total={data.total} pageSize={data.page_size} onPage={(p) => set({ mpage: String(p) })} noun="listings" className="border-t-0" />
            </Card>
          ) : null}
        </div>
      )}

      <ManualMatchDialog listing={manual} onClose={() => setManual(null)} />
      <ListingDrawer listingId={openListing} onClose={() => setOpenListing(null)} />
    </div>
  );
}
