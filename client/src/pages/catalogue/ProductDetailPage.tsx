/** Product detail: attributes, pack variants, market availability, retailer listings, mappings and price history. */
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ArrowLeft, ArrowLeftRight, Ellipsis, ImageOff, PackageSearch, Pencil, Scale, Trash2 } from 'lucide-react';
import { apiDelete, apiPost, ApiError } from '@/lib/api.ts';
import { useCan } from '@/lib/auth.tsx';
import { fmtDate, fmtNumber } from '@/lib/format.ts';
import { useApiQuery } from '@/lib/hooks.ts';
import { Page } from '@/app/AppShell.tsx';
import { ConfirmDialog, Menu, useToast } from '@/components/ui/overlays.tsx';
import { Badge, Button, Card, CardHeader, DescriptionList, EmptyState, ErrorState, IconButton, LoadingBlock, Notice, cn } from '@/components/ui/primitives.tsx';
import { DemoBadge, OwnershipBadge, ProductCell } from '@/components/domain/domain.tsx';
import type { MappingRow, ProductDetail } from '@shared/api/catalogue.ts';
import { ProductFormDialog } from './ProductFormDialog.tsx';
import { ProductObservations, ProductPriceHistory } from './ProductHistory.tsx';
import { ProductListings } from './ProductListings.tsx';
import { ProductMarkets, ProductVariants } from './ProductVariants.tsx';
import { CATALOGUE, EquivalenceBadge, errorMessage, LinkButton, MappingStatusBadge, ProductStatusBadge, useCatalogueActions } from './shared.tsx';

function ProductImage({ url, name }: { url: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) {
    return (
      <div className="flex h-28 items-center justify-center gap-2 rounded-lg border border-dashed border-line-strong bg-sunken text-[12px] text-ink-4">
        <ImageOff className="size-4" aria-hidden /> {url ? 'The image could not be loaded' : 'No product image'}
      </div>
    );
  }
  return <img src={url} alt={name} loading="lazy" onError={() => setFailed(true)} className="h-40 w-full rounded-lg border border-line bg-sunken object-contain" />;
}

function AttributesCard({ detail }: { detail: ProductDetail }) {
  const p = detail.product;
  const mono = (value: string | null) => (value ? <span className="mono">{value}</span> : <span className="font-normal text-ink-4">Not set</span>);
  return (
    <Card>
      <CardHeader title="Product attributes" subtitle={`Created ${fmtDate(p.created_at)} · updated ${fmtDate(p.updated_at)}`} />
      <div className="flex flex-col gap-4 px-4 py-4">
        <ProductImage url={p.image_url} name={p.name} />
        <DescriptionList
          items={[
            { label: 'Product ID', value: <span className="mono">{p.code}</span> },
            { label: 'Brand', value: p.brand_name },
            { label: 'Brand ownership', value: p.ownership === 'own' ? 'Own brand' : 'Competitor' },
            { label: 'Product line', value: p.product_line ?? <span className="font-normal text-ink-4">Not set</span> },
            { label: 'Category', value: p.category_name },
            { label: 'Subcategory', value: p.subcategory_name ?? <span className="font-normal text-ink-4">Not set</span> },
            { label: 'SKU', value: mono(p.sku) },
            { label: 'Barcode / GTIN', value: mono(p.gtin) },
            { label: 'Pack size', value: p.pack_size ? `${fmtNumber(p.pack_size, 3)} ${p.pack_unit ?? ''}` : <span className="font-normal text-ink-4">Not set</span> },
            { label: 'Units per pack', value: fmtNumber(p.units_per_pack) },
            { label: 'Retailer listings', value: `${fmtNumber(p.active_listing_count)} active of ${fmtNumber(p.listing_count)}` },
          ]}
        />
        {p.description ? (
          <div>
            <div className="eyebrow mb-1">Description</div>
            <p className="text-[13px] leading-5 break-words whitespace-pre-line text-ink-2">{p.description}</p>
          </div>
        ) : null}
        {!p.pack_size ? (
          <Notice tone="warn">Without a pack size, unit prices (per 100 ml / 100 g / unit) cannot be calculated for this product.</Notice>
        ) : null}
      </div>
    </Card>
  );
}

function MappingList({ rows, side, productId }: { rows: MappingRow[]; side: 'competitor' | 'own'; productId: number }) {
  return (
    <ul>
      {rows.map((m) => {
        const other = side === 'competitor' ? m.competitor : m.own;
        const ownId = m.own.product_id;
        return (
          <li key={m.id} className="flex flex-col gap-x-4 gap-y-2 border-t border-line px-4 py-2.5 first:border-t-0 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1">
              <ProductCell name={other.product_name} brand={other.brand_name} pack={other.pack_label} code={other.product_code} ownership={side === 'competitor' ? 'competitor' : 'own'} productId={other.product_id} isDemo={other.is_demo} compact />
              <p className="mt-1 pl-4 text-[11.5px] leading-4 text-ink-3">
                {m.comparability.note}
                {m.market_name ? ` · ${m.market_name} only` : ''}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <EquivalenceBadge mapping={m} />
              <MappingStatusBadge status={m.status} />
              {m.status === 'approved' ? (
                <Link to={`/competitors?product_id=${ownId}`} className="link inline-flex items-center gap-1 text-[12.5px]" title={ownId === productId ? 'Compare this product with its competitors' : 'Open the comparison of the own product'}>
                  <Scale className="size-3" aria-hidden /> Compare
                </Link>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function MappingsCard({ detail }: { detail: ProductDetail }) {
  const p = detail.product;
  const own = p.ownership === 'own';
  const rows = own ? detail.mappings.as_own : detail.mappings.as_competitor;
  const approved = rows.filter((m) => m.status === 'approved').length;
  return (
    <Card>
      <CardHeader
        title={own ? 'Mapped competitors' : 'Compared with own products'}
        subtitle={
          own
            ? 'Competitor products this product is compared against. Only approved mappings are used.'
            : 'Own products that are compared against this competitor product.'
        }
        actions={
          <>
            {own && approved > 0 ? (
              <LinkButton to={`/competitors?product_id=${p.id}`} variant="primary" icon={Scale}>
                Open comparison
              </LinkButton>
            ) : null}
            <LinkButton to={own ? `/catalogue?tab=mappings&own_product_id=${p.id}` : '/catalogue?tab=mappings'} icon={ArrowLeftRight}>
              Manage mappings
            </LinkButton>
          </>
        }
      />
      {rows.length ? (
        <MappingList rows={rows} side={own ? 'competitor' : 'own'} productId={p.id} />
      ) : (
        <EmptyState
          icon={ArrowLeftRight}
          title={own ? 'No competitor mapped yet' : 'Not mapped to any own product'}
          description={
            own
              ? 'Until a mapping is approved, this product does not appear in competitor comparisons, positioning or “own brand more expensive” alerts.'
              : 'Map it from one of your own products to include it in comparisons.'
          }
          className="py-8"
        />
      )}
      {detail.associated_brands.length ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-4 py-2.5 text-[12px] text-ink-3">
          <span>{own ? `${p.brand_name} is benchmarked against:` : `${p.brand_name} is a competitor brand of:`}</span>
          {detail.associated_brands.map((b) => (
            <Badge key={b.id} tone={b.ownership === 'own' ? 'own' : 'comp'}>
              {b.name}
            </Badge>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

export default function ProductDetailPage() {
  const params = useParams();
  const navigate = useNavigate();
  const id = Number(params.id);
  const valid = Number.isInteger(id) && id > 0;
  const canWrite = useCan('catalogue.write');
  const { run, busy, invalidate } = useCatalogueActions();
  const client = useQueryClient();
  const toast = useToast();
  const detail = useApiQuery<ProductDetail>([CATALOGUE, 'product', id], `/products/${id}`, undefined, { enabled: valid });
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const back = (
    <Link to="/catalogue" className="mb-3 inline-flex items-center gap-1.5 text-[12.5px] text-ink-3 hover:text-ink">
      <ArrowLeft className="size-3.5" aria-hidden /> Product Catalogue
    </Link>
  );

  if (!valid || (detail.isError && detail.error instanceof ApiError && detail.error.status === 404)) {
    return (
      <Page>
        {back}
        <Card>
          <EmptyState
            icon={PackageSearch}
            title="Product not found"
            description="It may have been deleted, or the link is incorrect."
            action={<LinkButton to="/catalogue">Back to the catalogue</LinkButton>}
          />
        </Card>
      </Page>
    );
  }
  if (detail.isError && !detail.data) {
    return (
      <Page>
        {back}
        <Card>
          <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
        </Card>
      </Page>
    );
  }
  if (!detail.data) {
    return (
      <Page>
        {back}
        <LoadingBlock className="min-h-64" label="Loading product…" />
      </Page>
    );
  }

  const data = detail.data;
  const p = data.product;
  const archived = p.status === 'archived';

  return (
    <Page>
      {back}
      <header className="mb-5 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="eyebrow mb-1 flex flex-wrap items-center gap-2">
            <span className="mono normal-case">{p.code}</span>
            <span aria-hidden>·</span>
            <span>
              {p.category_name}
              {p.subcategory_name ? ` › ${p.subcategory_name}` : ''}
            </span>
          </div>
          <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.01em] break-words text-ink">{p.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-[13px] text-ink-2">{p.brand_name}</span>
            <OwnershipBadge ownership={p.ownership} />
            <ProductStatusBadge status={p.status} />
            {p.pack_size ? <Badge tone="outline">{p.pack_label}</Badge> : null}
            {p.is_demo ? <DemoBadge /> : null}
          </div>
        </div>
        {canWrite ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button icon={Pencil} onClick={() => setEditing(true)}>
              Edit
            </Button>
            {archived ? (
              <Button
                icon={ArchiveRestore}
                loading={busy === 'restore'}
                onClick={() => void run('restore', () => apiPost<ProductDetail>(`/products/${p.id}/restore`), { success: `${p.name} restored` })}
              >
                Restore
              </Button>
            ) : (
              <Button
                icon={Archive}
                loading={busy === 'archive'}
                onClick={() => void run('archive', () => apiPost<ProductDetail>(`/products/${p.id}/archive`), { success: `${p.name} archived — its price history is kept` })}
              >
                Archive
              </Button>
            )}
            <Menu
              trigger={<IconButton icon={Ellipsis} label="More actions" variant="secondary" />}
              items={[
                {
                  label: 'Delete product…',
                  icon: Trash2,
                  danger: true,
                  onSelect: () => {
                    setRemoveError(null);
                    setRemoving(true);
                  },
                },
              ]}
            />
          </div>
        ) : null}
      </header>

      {archived ? (
        <Notice tone="warn" icon={Archive} className="mb-4" title="This product is archived">
          It is hidden from the catalogue and pickers. Its listings and every recorded price are kept, and it can be restored at any time.
        </Notice>
      ) : null}

      <div className={cn('mb-4', detail.isPlaceholderData && 'opacity-60')}>
        <ProductListings detail={data} />
      </div>
      <div className={cn('grid items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]', detail.isPlaceholderData && 'opacity-60')}>
        <div className="flex min-w-0 flex-col gap-4">
          <ProductPriceHistory productId={p.id} />
          <MappingsCard detail={data} />
          <ProductObservations productId={p.id} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <AttributesCard detail={data} />
          <ProductMarkets detail={data} />
          <ProductVariants detail={data} />
        </div>
      </div>

      <ProductFormDialog open={editing} productId={p.id} onClose={() => setEditing(false)} />
      <ConfirmDialog
        open={removing}
        onClose={() => setRemoving(false)}
        title="Delete this product?"
        confirmLabel="Delete product"
        danger
        loading={deleting}
        onConfirm={async () => {
          setDeleting(true);
          try {
            await apiDelete(`/products/${p.id}`);
            toast.success(`${p.name} deleted`);
            // Leave the page first, so the (now missing) product is not refetched, then refresh the lists.
            navigate('/catalogue', { replace: true });
            window.setTimeout(() => {
              client.removeQueries({ queryKey: [CATALOGUE, 'product', p.id] });
              void invalidate();
            }, 0);
          } catch (err) {
            setRemoveError(errorMessage(err, 'The product could not be deleted.'));
          } finally {
            setDeleting(false);
          }
        }}
      >
        <p>
          <strong className="font-semibold text-ink">{p.name}</strong> ({p.code}) will be removed from the catalogue. A product that has retailer listings cannot be deleted — archive it instead so its price history is
          preserved.
        </p>
        {removeError ? (
          <Notice
            tone="crit"
            className="mt-3"
            title="Not deleted"
            action={
              !archived ? (
                <Button
                  size="sm"
                  icon={Archive}
                  onClick={async () => {
                    const outcome = await run('archive', () => apiPost<ProductDetail>(`/products/${p.id}/archive`), { success: `${p.name} archived — its price history is kept` });
                    if (outcome.ok) setRemoving(false);
                  }}
                >
                  Archive instead
                </Button>
              ) : undefined
            }
          >
            {removeError}
          </Notice>
        ) : null}
      </ConfirmDialog>
    </Page>
  );
}
