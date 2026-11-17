/** Product listings configured at one retailer: each has its own identifier and URL, and maps to a canonical product. */
import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Ellipsis, ExternalLink, Pencil, Plus, Trash2 } from 'lucide-react';
import { apiDelete, apiGet, apiPatch, apiPost, type Paged } from '@/lib/api.ts';
import { useCan } from '@/lib/auth.tsx';
import { fmtNumber } from '@/lib/format.ts';
import { useApiQuery } from '@/lib/hooks.ts';
import { ConfirmDialog, Dialog, Menu, useToast } from '@/components/ui/overlays.tsx';
import { Badge, Button, EmptyState, ErrorState, Field, IconButton, Input, Notice, Select, Switch } from '@/components/ui/primitives.tsx';
import { DataTable, Pagination, type Column } from '@/components/ui/data-table.tsx';
import { ProductPicker, SearchInput } from '@/components/ui/filters.tsx';
import { DemoBadge, FreshnessCell, PriceCell } from '@/components/domain/domain.tsx';
import type { ListingRow, ProductDetail, RetailerRow } from '@shared/api/catalogue.ts';
import { errorText, useRefresh } from './shared.tsx';

interface ListingForm {
  url: string;
  external_id: string;
  title: string;
  gtin: string;
  product_id: string[];
  variant_id: string;
  is_active: boolean;
}

const EMPTY: ListingForm = { url: '', external_id: '', title: '', gtin: '', product_id: [], variant_id: '', is_active: true };

function ListingDialog({ retailer, listing, open, onClose }: { retailer: RetailerRow; listing: ListingRow | null; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const [form, setForm] = useState<ListingForm>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm(
      listing
        ? {
            url: listing.url ?? '',
            external_id: listing.external_id ?? '',
            title: listing.title ?? '',
            gtin: listing.gtin ?? '',
            product_id: listing.product_id ? [String(listing.product_id)] : [],
            variant_id: listing.variant_id ? String(listing.variant_id) : '',
            is_active: listing.is_active === 1,
          }
        : EMPTY,
    );
  }, [open, listing]);

  const productId = form.product_id[0];
  const product = useQuery({
    queryKey: ['products', 'detail', productId],
    queryFn: () => apiGet<ProductDetail>(`/products/${productId}`),
    enabled: open && !!productId,
    staleTime: 60_000,
  });
  const variants = product.data?.variants.filter((v) => v.is_active || String(v.id) === form.variant_id) ?? [];
  const update = (changes: Partial<ListingForm>) => setForm((prev) => ({ ...prev, ...changes }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const body = {
      url: form.url.trim(),
      external_id: form.external_id.trim() || null,
      title: form.title.trim() || null,
      gtin: form.gtin.trim() || null,
      product_id: productId ? Number(productId) : null,
      variant_id: productId && form.variant_id ? Number(form.variant_id) : null,
      is_active: form.is_active,
    };
    try {
      if (listing) await apiPatch(`/listings/${listing.id}`, body);
      else await apiPost('/listings', { ...body, retailer_id: retailer.id });
      toast.success(listing ? 'Listing updated' : 'Listing added', form.title || form.url);
      await refresh(['listings'], ['retailers'], ['matching'], ['collection'], ['products']);
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={listing ? `Edit listing ${listing.code}` : `Add listing at ${retailer.name}`}
      description="A listing is one product page at this retailer. Identical names do not prove identical products — map it to the canonical product deliberately."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="listing-form" loading={busy}>
            {listing ? 'Save changes' : 'Add listing'}
          </Button>
        </>
      }
    >
      <form id="listing-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        {error ? (
          <Notice tone="crit" className="sm:col-span-2">
            {error}
          </Notice>
        ) : null}
        <Field label="Product page URL" required className="sm:col-span-2" hint="Must be unique at this retailer.">
          <Input type="url" value={form.url} onChange={(e) => update({ url: e.target.value })} required maxLength={2000} placeholder="https://www.retailer.example/p/…" />
        </Field>
        <Field label="Retailer item id" hint="The retailer's own SKU / id. Used to match feed and API items.">
          <Input value={form.external_id} onChange={(e) => update({ external_id: e.target.value })} maxLength={200} className="mono" />
        </Field>
        <Field label="Barcode (GTIN) shown by the retailer">
          <Input value={form.gtin} onChange={(e) => update({ gtin: e.target.value })} maxLength={40} inputMode="numeric" className="mono" />
        </Field>
        <Field label="Title as shown by the retailer" className="sm:col-span-2">
          <Input value={form.title} onChange={(e) => update({ title: e.target.value })} maxLength={500} />
        </Field>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[12px] font-medium text-ink-2">Canonical product</span>
          <ProductPicker label="Product" multiple={false} value={form.product_id} onChange={(next) => update({ product_id: next, variant_id: '' })} />
          <span className="text-[12px] text-ink-3">Leave empty to keep the listing unmatched; it can be matched later under Product Catalogue → Matching.</span>
        </div>
        <Field label="Pack variant" hint={productId ? 'Choose a variant when this listing sells a different pack (twin pack, bonus pack). Unit prices then use that pack.' : 'Choose a product first.'}>
          <Select value={form.variant_id} onChange={(e) => update({ variant_id: e.target.value })} disabled={!productId || variants.length === 0}>
            <option value="">{productId && variants.length === 0 && !product.isPending ? 'Standard pack (no variants defined)' : 'Standard pack'}</option>
            {variants.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} ({v.pack_label})
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex items-center justify-between gap-4 rounded-lg border border-line px-3.5 py-2.5 sm:col-span-2">
          <div>
            <div className="text-[13px] font-medium text-ink">Active</div>
            <div className="text-[12px] text-ink-3">Inactive listings are no longer collected. Their price history is kept.</div>
          </div>
          <Switch checked={form.is_active} onChange={(next) => update({ is_active: next })} label="Listing active" />
        </div>
      </form>
    </Dialog>
  );
}

export function RetailerListings({ retailer }: { retailer: RetailerRow }) {
  const canWrite = useCan('catalogue.write');
  const toast = useToast();
  const refresh = useRefresh();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<ListingRow | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<ListingRow | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setPage(1), [q, retailer.id]);
  const listings = useApiQuery<Paged<ListingRow>>(['listings', 'retailer', retailer.id], '/listings', { retailer_id: retailer.id, q: q || undefined, page, page_size: 25, sort: 'product' });

  async function setActive(listing: ListingRow, active: boolean) {
    try {
      await apiPatch(`/listings/${listing.id}`, { is_active: active });
      toast.success(active ? 'Listing activated' : 'Listing deactivated', listing.code);
      await refresh(['listings'], ['retailers'], ['collection']);
    } catch (err) {
      toast.error('The listing was not changed', errorText(err));
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try {
      await apiDelete(`/listings/${deleting.id}`);
      toast.success('Listing deleted', deleting.code);
      await refresh(['listings'], ['retailers'], ['collection'], ['matching']);
    } catch (err) {
      toast.error('The listing was not deleted', errorText(err));
    } finally {
      setBusy(false);
      setDeleting(null);
    }
  }

  const columns: Array<Column<ListingRow>> = [
    {
      key: 'listing',
      header: 'Listing',
      cell: (l) => (
        <div className="min-w-[12rem]">
          <div className="flex items-center gap-1.5">
            <span className="line-clamp-1 font-medium text-ink">{l.title ?? l.product_name ?? 'Untitled listing'}</span>
            {l.is_demo ? <DemoBadge /> : null}
            {!l.is_active ? <Badge tone="outline">Inactive</Badge> : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 text-[11.5px] text-ink-3">
            <span className="mono">{l.code}</span>
            {l.external_id ? <span className="mono">{l.external_id}</span> : null}
            {l.url ? (
              <a href={l.url} target="_blank" rel="noreferrer noopener" className="link inline-flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                page <ExternalLink className="size-3" aria-hidden />
              </a>
            ) : (
              <span>no URL</span>
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'product',
      header: 'Canonical product',
      hideBelow: 'sm',
      cell: (l) =>
        l.product_id ? (
          <div className="min-w-[9rem]">
            <div className="line-clamp-1 text-ink-2">{l.product_name}</div>
            <div className="text-[11.5px] text-ink-3">{[l.variant_name ?? l.pack_label, l.product_code].filter(Boolean).join(' · ')}</div>
          </div>
        ) : (
          <Badge tone={l.match_status === 'ignored' ? 'outline' : 'warn'}>{l.match_status === 'ignored' ? 'Ignored' : 'Unmatched'}</Badge>
        ),
    },
    {
      key: 'price',
      header: 'Latest price',
      align: 'right',
      cell: (l) => (l.latest ? <PriceCell price={l.latest.current_price} regular={l.latest.regular_price} currency={l.currency_code} isPromo={l.latest.is_promo} /> : <span className="text-ink-4">—</span>),
    },
    { key: 'observed', header: 'Last observed', hideBelow: 'md', cell: (l) => <FreshnessCell iso={l.last_observed_at} timeZone={l.timezone} /> },
    { key: 'obs', header: 'Obs.', align: 'right', hideBelow: 'lg', headerTitle: 'Observations on record', cell: (l) => fmtNumber(l.obs_count) },
    ...(canWrite
      ? [
          {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            align: 'right' as const,
            width: '48px',
            cell: (l: ListingRow) => (
              <Menu
                trigger={<IconButton icon={Ellipsis} label={`Actions for ${l.code}`} size="sm" />}
                items={[
                  {
                    label: 'Edit',
                    icon: Pencil,
                    onSelect: () => {
                      setEditing(l);
                      setDialogOpen(true);
                    },
                  },
                  { label: l.is_active ? 'Deactivate' : 'Activate', onSelect: () => void setActive(l, !l.is_active) },
                  { label: 'Delete', icon: Trash2, danger: true, separatorBefore: true, onSelect: () => setDeleting(l) },
                ]}
              />
            ),
          } satisfies Column<ListingRow>,
        ]
      : []),
  ];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchInput value={q} onChange={setQ} placeholder="Search listings…" className="w-64" />
        <span className="num text-[12.5px] text-ink-3">
          {fmtNumber(retailer.active_listing_count)} active · {fmtNumber(retailer.unmatched_listing_count)} unmatched
        </span>
        {canWrite ? (
          <Button
            variant="primary"
            icon={Plus}
            className="ml-auto"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            Add listing
          </Button>
        ) : null}
      </div>
      <div className="rounded-lg border border-line">
        {listings.isError ? (
          <ErrorState error={listings.error} onRetry={() => void listings.refetch()} />
        ) : (
          <DataTable
            columns={columns}
            rows={listings.data?.rows}
            rowKey={(l) => l.id}
            dense
            loading={listings.isPending}
            refetching={listings.isPlaceholderData || (listings.isFetching && !listings.isPending)}
            empty={
              <EmptyState
                title={q ? 'No listings match the search' : 'No listings configured yet'}
                description={q ? undefined : 'Add the product pages you want to monitor at this retailer. Feed and API sources can also discover listings automatically.'}
              />
            }
          />
        )}
        {listings.data ? <Pagination page={listings.data.page} pages={listings.data.pages} total={listings.data.total} pageSize={listings.data.page_size} noun="listings" onPage={setPage} /> : null}
      </div>

      <ListingDialog retailer={retailer} listing={editing} open={dialogOpen} onClose={() => setDialogOpen(false)} />
      <ConfirmDialog open={deleting !== null} onClose={() => setDeleting(null)} onConfirm={() => void remove()} title="Delete this listing?" confirmLabel="Delete listing" danger loading={busy}>
        <p>
          <strong className="font-semibold text-ink">{deleting?.title ?? deleting?.code}</strong> can only be deleted while it has no price observations. A listing with
          history is deactivated instead, so the ledger stays complete.
        </p>
      </ConfirmDialog>
    </div>
  );
}
