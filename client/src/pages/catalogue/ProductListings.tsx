/** Product detail → retailer listings mapped to the product, with add / edit / deactivate / delete. */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Ellipsis, Eye, EyeOff, Pencil, Plus, Store, Trash2, CirclePlus } from 'lucide-react';
import { apiDelete, apiPatch, apiPost } from '@/lib/api.ts';
import { useCan } from '@/lib/auth.tsx';
import { useReference } from '@/lib/hooks.ts';
import { DataTable, type Column } from '@/components/ui/data-table.tsx';
import { ConfirmDialog, Dialog, Menu } from '@/components/ui/overlays.tsx';
import { Badge, Button, Card, CardHeader, cn, EmptyState, Field, IconButton, Input, Notice, Select, Switch } from '@/components/ui/primitives.tsx';
import { AvailabilityBadge, ChangeCell, DataClassBadge, DemoBadge, FreshnessCell, PriceCell, PromoBadge } from '@/components/domain/domain.tsx';
import { ListingDrawer, ManualObservationDialog } from '@/components/domain/observations.tsx';
import type { ListingRow, ProductDetail, VariantRow } from '@shared/api/catalogue.ts';
import { errorMessage, ExternalUrl, fitColumns, isHttpUrl, listingIsStale, pctChange, RowActions, useCatalogueActions, useElementWidth, type FitColumn } from './shared.tsx';

function ListingDialog({
  open,
  onClose,
  productId,
  variants,
  standardPack,
  listing,
}: {
  open: boolean;
  onClose: () => void;
  productId: number;
  variants: VariantRow[];
  standardPack: string;
  /** Edit this listing; omit to add a new one. */
  listing: ListingRow | null;
}) {
  const { ref } = useReference();
  const { run, busy } = useCatalogueActions();
  const [retailerId, setRetailerId] = useState('');
  const [url, setUrl] = useState('');
  const [externalId, setExternalId] = useState('');
  const [title, setTitle] = useState('');
  const [variantId, setVariantId] = useState('');
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRetailerId(listing ? String(listing.retailer_id) : '');
    setUrl(listing?.url ?? '');
    setExternalId(listing?.external_id ?? '');
    setTitle(listing?.title ?? '');
    setVariantId(listing?.variant_id ? String(listing.variant_id) : '');
    setActive(listing ? listing.is_active === 1 : true);
    setError(null);
  }, [open, listing]);

  // retailers grouped by market for the picker
  const groups = useMemo(() => {
    const markets = ref?.markets ?? [];
    return markets
      .map((m) => ({ market: m, retailers: (ref?.retailers ?? []).filter((r) => r.market_id === m.id && r.is_active) }))
      .filter((g) => g.retailers.length > 0);
  }, [ref]);
  const usable = variants.filter((v) => v.is_active || String(v.id) === variantId);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!listing && !retailerId) return setError('Choose the retailer that lists the product.');
    if (!url.trim()) return setError('Enter the URL of the product page at the retailer.');
    if (!isHttpUrl(url.trim())) return setError('The listing URL must be a full address starting with http:// or https://.');
    setError(null);
    const common = { url: url.trim(), external_id: externalId, title, variant_id: variantId ? Number(variantId) : null };
    const outcome = await run(
      'save-listing',
      () =>
        listing
          ? apiPatch<ListingRow>(`/listings/${listing.id}`, { ...common, is_active: active })
          : apiPost<ListingRow>('/listings', { ...common, retailer_id: Number(retailerId), product_id: productId }),
      { success: (l) => (listing ? `Listing ${l.code} updated` : `Listing ${l.code} added at ${l.retailer_name}`), quietError: true },
    );
    if (outcome.ok) onClose();
    else setError(errorMessage(outcome.error, 'The listing could not be saved.'));
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={listing ? 'Edit retailer listing' : 'Add retailer listing'}
      description={listing ? `${listing.retailer_name} · ${listing.market_name} · ${listing.code}` : 'Where this product is sold. Each listing has its own identifier and URL, and keeps its own price history.'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="listing-form" loading={busy === 'save-listing'}>
            {listing ? 'Save changes' : 'Add listing'}
          </Button>
        </>
      }
    >
      <form id="listing-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {error ? <Notice tone="crit">{error}</Notice> : null}
        {!listing ? (
          <Field label="Retailer" required hint={groups.length === 0 ? 'No retailers are configured yet. Add one in Administration → Retailers.' : 'A listing belongs to one retailer for life.'}>
            <Select value={retailerId} onChange={(e) => setRetailerId(e.target.value)} required>
              <option value="">Choose a retailer…</option>
              {groups.map((g) => (
                <optgroup key={g.market.id} label={`${g.market.name} (${g.market.currency_code})`}>
                  {g.retailers.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                      {r.is_demo ? ' — DEMO' : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field label="Listing URL" required hint="The product page at the retailer.">
          <Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.retailer.com/product/…" maxLength={2000} required />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Retailer item id" hint="The retailer's own SKU or article number.">
            <Input value={externalId} onChange={(e) => setExternalId(e.target.value)} maxLength={200} className="mono" />
          </Field>
          <Field label="Pack sold" hint="Unit prices use the pack chosen here.">
            <Select value={variantId} onChange={(e) => setVariantId(e.target.value)}>
              <option value="">Standard pack ({standardPack})</option>
              {usable.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} ({v.pack_label})
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Title shown by the retailer">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={500} />
        </Field>
        {listing ? (
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] text-ink-2">
              <span className="block font-medium text-ink">Active</span>
              Inactive listings are no longer collected or monitored; their history is kept.
            </span>
            <Switch checked={active} onChange={setActive} label="Listing is active" />
          </div>
        ) : null}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

export function ProductListings({ detail }: { detail: ProductDetail }) {
  const canWrite = useCan('catalogue.write');
  const canObserve = useCan('observations.write');
  const { run, busy, invalidate } = useCatalogueActions();
  const [dialog, setDialog] = useState<{ open: boolean; listing: ListingRow | null }>({ open: false, listing: null });
  const [openListing, setOpenListing] = useState<number | null>(null);
  const [observe, setObserve] = useState<{ open: boolean; listingId: number | null }>({ open: false, listingId: null });
  const [remove, setRemove] = useState<ListingRow | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const { product, listings, variants } = detail;
  // columns follow the width of the card (`minWidth`), so the price and the row menu are always on screen
  const [cardRef, cardWidth] = useElementWidth();

  const columns = useMemo<Array<Column<ListingRow>>>(() => {
    const compact = cardWidth < 560;
    const cols: Array<FitColumn<ListingRow>> = [
      {
        key: 'retailer',
        header: 'Retailer',
        cell: (l) => (
          // narrow: the name may wrap, and freshness moves here because there is no Last observed column
          <span className={cn('block', compact ? 'max-w-[10.5rem]' : 'whitespace-nowrap')}>
            <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <span className="font-medium text-ink">{l.retailer_name}</span>
              {l.is_demo ? <DemoBadge /> : null}
              {!l.is_active ? <Badge tone="neutral">Inactive</Badge> : null}
            </span>
            <span className="block truncate text-[11.5px] leading-4 text-ink-3">
              {l.market_name} · <span className="mono">{l.code}</span>
            </span>
            {compact ? (
              <span className="mt-1 block">
                <FreshnessCell iso={l.last_observed_at} stale={listingIsStale(l)} timeZone={l.timezone} />
              </span>
            ) : null}
          </span>
        ),
      },
      {
        key: 'pack',
        header: 'Pack',
        minWidth: 820,
        cell: (l) => (
          <span className="block max-w-44">
            <span className="block truncate text-ink-2" title={l.variant_name ?? undefined}>{l.variant_name ?? 'Standard pack'}</span>
            <span className="num block text-[11.5px] leading-4 text-ink-3">{l.pack_label}</span>
          </span>
        ),
      },
      {
        key: 'link',
        header: 'Listing',
        minWidth: 985,
        cell: (l) => (
          <span className="block max-w-40">
            <ExternalUrl url={l.url} />
            <span className="mono block truncate text-ink-3">{l.external_id ?? 'no item id'}</span>
          </span>
        ),
      },
      {
        key: 'price',
        header: 'Latest price',
        align: 'right',
        cell: (l) =>
          l.latest ? (
            <span className="inline-flex flex-col items-end gap-0.5">
              <PriceCell price={l.latest.current_price} regular={l.latest.regular_price} currency={l.currency_code} isPromo={l.latest.is_promo} />
              {l.latest.is_promo ? <PromoBadge type={l.latest.promo_type ?? 'other'} discount={l.latest.discount_pct} /> : null}
            </span>
          ) : (
            <span className="text-ink-4">No price yet</span>
          ),
      },
      {
        key: 'change',
        header: 'vs previous',
        align: 'right',
        minWidth: 670,
        headerTitle: 'Change against the previous observation',
        cell: (l) => <ChangeCell pct={pctChange(l.previous_price, l.latest?.current_price)} />,
      },
      { key: 'availability', header: 'Availability', minWidth: 1100, nowrap: true, cell: (l) => <AvailabilityBadge value={l.latest?.availability} /> },
      {
        key: 'observed',
        header: 'Last observed',
        minWidth: 560,
        nowrap: true,
        cell: (l) => (
          <span className="inline-flex flex-col items-start gap-1">
            <FreshnessCell iso={l.last_observed_at} stale={listingIsStale(l)} timeZone={l.timezone} />
            {l.latest ? <DataClassBadge value={l.latest.data_class} short /> : null}
          </span>
        ),
      },
    ];
    if (canWrite || canObserve) {
      cols.push({
        key: 'actions',
        header: <span className="sr-only">Actions</span>,
        align: 'right',
        width: '44px',
        cell: (l) => (
          <RowActions>
            <Menu
              trigger={<IconButton icon={Ellipsis} label={`Actions for the listing at ${l.retailer_name}`} size="sm" />}
              items={[
                { label: 'Add observation', icon: CirclePlus, hidden: !canObserve, onSelect: () => setObserve({ open: true, listingId: l.id }) },
                { label: 'Edit listing', icon: Pencil, hidden: !canWrite, onSelect: () => setDialog({ open: true, listing: l }) },
                {
                  label: l.is_active ? 'Deactivate' : 'Activate',
                  icon: l.is_active ? EyeOff : Eye,
                  hidden: !canWrite,
                  onSelect: () =>
                    void run(`toggle-${l.id}`, () => apiPatch<ListingRow>(`/listings/${l.id}`, { is_active: !l.is_active }), {
                      success: l.is_active ? `Listing ${l.code} deactivated — its history is kept` : `Listing ${l.code} activated`,
                    }),
                },
                {
                  label: 'Delete…',
                  icon: Trash2,
                  danger: true,
                  separatorBefore: true,
                  hidden: !canWrite,
                  onSelect: () => {
                    setRemoveError(null);
                    setRemove(l);
                  },
                },
              ]}
            />
          </RowActions>
        ),
      });
    }
    return fitColumns(cols, cardWidth);
  }, [canObserve, canWrite, cardWidth, run]);

  return (
    <div ref={cardRef} className="min-w-0">
    <Card>
      <CardHeader
        title="Retailer listings"
        subtitle={`${listings.length} listing${listings.length === 1 ? '' : 's'} mapped to this product. Each keeps its own price history.`}
        actions={
          <>
            {canObserve && listings.length > 0 ? (
              <Button size="sm" icon={CirclePlus} onClick={() => setObserve({ open: true, listingId: null })}>
                Add observation
              </Button>
            ) : null}
            {canWrite ? (
              <Button size="sm" variant="primary" icon={Plus} onClick={() => setDialog({ open: true, listing: null })}>
                Add listing
              </Button>
            ) : null}
          </>
        }
      />
      <DataTable
        columns={columns}
        rows={listings}
        rowKey={(l) => l.id}
        onRowClick={(l) => setOpenListing(l.id)}
        maxHeight={listings.length > 9 ? 468 : undefined}
        dense
        empty={
          <EmptyState
            icon={Store}
            title="Not listed at any retailer yet"
            description="Add the retailer pages where this product is sold. Prices are then recorded against each listing."
            action={
              canWrite ? (
                <Button variant="primary" icon={Plus} onClick={() => setDialog({ open: true, listing: null })}>
                  Add listing
                </Button>
              ) : undefined
            }
          />
        }
      />

      <ListingDialog open={dialog.open} listing={dialog.listing} onClose={() => setDialog((d) => ({ ...d, open: false }))} productId={product.id} variants={variants} standardPack={product.pack_label} />
      <ListingDrawer listingId={openListing} onClose={() => setOpenListing(null)} />
      <ManualObservationDialog
        open={observe.open}
        onClose={() => setObserve({ open: false, listingId: null })}
        listingId={observe.listingId}
        productId={observe.listingId ? undefined : product.id}
        onSaved={() => void invalidate()}
      />
      <ConfirmDialog
        open={remove !== null}
        onClose={() => setRemove(null)}
        title="Delete this listing?"
        confirmLabel="Delete listing"
        danger
        loading={busy === 'delete-listing'}
        onConfirm={async () => {
          if (!remove) return;
          const outcome = await run('delete-listing', () => apiDelete(`/listings/${remove.id}`), { success: `Listing ${remove.code} deleted`, quietError: true });
          if (outcome.ok) setRemove(null);
          else setRemoveError(errorMessage(outcome.error, 'The listing could not be deleted.'));
        }}
      >
        <p>
          The listing at <strong className="font-semibold text-ink">{remove?.retailer_name}</strong> ({remove?.code}) will be removed. A listing that already has price observations cannot be deleted — deactivate it
          instead so the history is preserved.
        </p>
        {removeError ? (
          <Notice
            tone="crit"
            className="mt-3"
            title="Not deleted"
            action={
              remove?.is_active ? (
                <Button
                  size="sm"
                  icon={EyeOff}
                  onClick={async () => {
                    const target = remove;
                    const outcome = await run(`toggle-${target.id}`, () => apiPatch<ListingRow>(`/listings/${target.id}`, { is_active: false }), { success: `Listing ${target.code} deactivated — its history is kept` });
                    if (outcome.ok) setRemove(null);
                  }}
                >
                  Deactivate instead
                </Button>
              ) : undefined
            }
          >
            {removeError}
          </Notice>
        ) : null}
      </ConfirmDialog>
    </Card>
    </div>
  );
}
