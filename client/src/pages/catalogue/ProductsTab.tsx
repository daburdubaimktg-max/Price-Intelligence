/** Products tab: the master product database with filters, grouping, add / edit / archive / delete and import. */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Archive, ArchiveRestore, Ellipsis, PackagePlus, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { apiDelete, apiPost, type Paged } from '@/lib/api.ts';
import { useCan } from '@/lib/auth.tsx';
import { fmtNumber } from '@/lib/format.ts';
import { fromList, toList, useApiQuery, useReference, useUrlState } from '@/lib/hooks.ts';
import { DataTable, Pagination, type Column } from '@/components/ui/data-table.tsx';
import { FilterBar, MultiSelect, SearchInput, type Option } from '@/components/ui/filters.tsx';
import { ConfirmDialog, Menu } from '@/components/ui/overlays.tsx';
import { Button, Card, cn, EmptyState, ErrorState, IconButton, Notice, Segmented } from '@/components/ui/primitives.tsx';
import { DemoBadge, MarketTime, OwnershipDot, ProductCell } from '@/components/domain/domain.tsx';
import { ImportWizard } from '@/components/domain/import-wizard.tsx';
import type { ProductDetail, ProductRow, ProductSummary } from '@shared/api/catalogue.ts';
import { ProductFormDialog } from './ProductFormDialog.tsx';
import { CATALOGUE, categoryTree, errorMessage, fitColumns, ProductStatusBadge, RowActions, useCatalogueActions, useElementWidth, type FitColumn } from './shared.tsx';

type GroupBy = '' | 'brand' | 'category' | 'market';
const GROUP_FILTER: Record<Exclude<GroupBy, ''>, 'brand_id' | 'category_id' | 'market_id'> = { brand: 'brand_id', category: 'category_id', market: 'market_id' };

export function ProductsTab() {
  const navigate = useNavigate();
  const canWrite = useCan('catalogue.write');
  const { ref } = useReference();
  const { run, busy } = useCatalogueActions();
  const { state, set, reset, activeCount } = useUrlState({
    q: '', brand_id: '', category_id: '', ownership: '', market_id: '', status: '', group: '', sort: '', page: '1',
  });
  const [form, setForm] = useState<{ open: boolean; productId: number | null }>({ open: false, productId: null });
  const [importOpen, setImportOpen] = useState(false);
  const [toDelete, setToDelete] = useState<ProductRow | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [tableRef, tableWidth] = useElementWidth();

  const filters = {
    q: state.q,
    brand_id: state.brand_id,
    category_id: state.category_id,
    ownership: state.ownership,
    market_id: state.market_id,
    status: state.status,
  };
  const page = Math.max(1, Number(state.page) || 1);
  const products = useApiQuery<Paged<ProductRow>>([CATALOGUE, 'products'], '/products', { ...filters, sort: state.sort, page, page_size: 50 });
  const groupBy = (['brand', 'category', 'market'].includes(state.group ?? '') ? state.group : '') as GroupBy;
  const summary = useApiQuery<ProductSummary>([CATALOGUE, 'products-summary'], '/products/summary', { ...filters, group_by: groupBy || 'brand' }, { enabled: groupBy !== '' });

  const brandOptions = useMemo<Option[]>(
    () =>
      (ref?.brands ?? []).map((b) => ({
        value: String(b.id),
        label: b.name,
        group: b.ownership === 'own' ? 'Own brands' : 'Competitors',
        tag: b.is_demo ? <span className="text-[10px] font-medium text-warn-ink">DEMO</span> : undefined,
      })),
    [ref?.brands],
  );
  const categoryOptions = useMemo<Option[]>(
    () =>
      categoryTree(ref?.categories).flatMap((c) => [
        { value: String(c.id), label: c.name, sublabel: c.children.length ? 'Whole category' : undefined, group: c.name },
        ...c.children.map((s) => ({ value: String(s.id), label: s.name, group: c.name })),
      ]),
    [ref?.categories],
  );
  const marketOptions = useMemo<Option[]>(() => (ref?.markets ?? []).map((m) => ({ value: String(m.id), label: m.name, sublabel: m.currency_code })), [ref?.markets]);

  // any filter change returns to the first page
  const setFilter = (patch: Parameters<typeof set>[0]) => set({ ...patch, page: null });

  // Columns are chosen from the width of the table's card (`minWidth`), so the table never has to scroll
  // sideways to reach the row menu. The product name gets what is left, up to a readable maximum.
  const columns = useMemo<Array<Column<ProductRow>>>(() => {
    const statusInline = tableWidth < 520;
    const cols: Array<FitColumn<ProductRow>> = [
      {
        key: 'product',
        header: 'Product',
        sortKey: 'name',
        cell: (p) => (
          <div style={{ maxWidth: tableWidth >= 1260 ? '26rem' : tableWidth >= 520 ? '19rem' : '17rem' }}>
            <ProductCell name={p.name} brand={p.brand_name} pack={p.pack_label} code={p.code} ownership={p.ownership} isDemo={p.is_demo} imageUrl={p.image_url} />
            {/* without a Status column (phones), a product that is not active says so here */}
            {statusInline && p.status !== 'active' ? (
              <span className="mt-1 block pl-[38px]">
                <ProductStatusBadge status={p.status} />
              </span>
            ) : null}
          </div>
        ),
      },
      {
        key: 'category',
        header: 'Category',
        sortKey: 'category',
        minWidth: 700,
        cell: (p) => (
          <span className="block leading-4 whitespace-nowrap">
            <span className="block text-ink-2">{p.category_name}</span>
            {p.subcategory_name ? <span className="block text-[11.5px] text-ink-3">› {p.subcategory_name}</span> : null}
          </span>
        ),
      },
      { key: 'pack', header: 'Pack', sortKey: 'pack_size', minWidth: 1010, nowrap: true, cell: (p) => <span className="num text-ink-2">{p.pack_label}</span> },
      {
        key: 'identifiers',
        header: 'SKU / barcode',
        minWidth: 1140,
        nowrap: true,
        cell: (p) =>
          p.sku || p.gtin ? (
            <span className="block leading-4">
              <span className="mono block text-ink-2" title="SKU">{p.sku ?? '—'}</span>
              <span className="mono block text-ink-3" title="Barcode / GTIN">{p.gtin ?? '—'}</span>
            </span>
          ) : (
            <span className="text-ink-4">—</span>
          ),
      },
      {
        key: 'listings',
        header: 'Listings',
        align: 'right',
        sortKey: 'listing_count',
        minWidth: 520,
        headerTitle: 'Retailer listings mapped to the product',
        cell: (p) => (p.listing_count ? fmtNumber(p.listing_count) : <span className="text-ink-4">0</span>),
      },
      {
        key: 'markets',
        header: 'Markets',
        align: 'right',
        sortKey: 'market_count',
        minWidth: 790,
        headerTitle: 'Markets the product is available in',
        cell: (p) => (p.market_count ? fmtNumber(p.market_count) : <span className="text-ink-4">0</span>),
      },
      {
        key: 'observed',
        header: 'Last observed',
        sortKey: 'last_observed_at',
        minWidth: 930,
        nowrap: true,
        cell: (p) => (p.last_observed_at ? <MarketTime iso={p.last_observed_at} relative /> : <span className="text-ink-4">No price yet</span>),
      },
      { key: 'status', header: 'Status', sortKey: 'status', minWidth: 520, nowrap: true, cell: (p) => <ProductStatusBadge status={p.status} /> },
    ];
    if (canWrite) {
      cols.push({
        key: 'actions',
        header: <span className="sr-only">Actions</span>,
        align: 'right',
        width: '44px',
        cell: (p) => (
          <RowActions>
            <Menu
              trigger={<IconButton icon={Ellipsis} label={`Actions for ${p.name}`} size="sm" />}
              items={[
                { label: 'Edit', icon: Pencil, onSelect: () => setForm({ open: true, productId: p.id }) },
                {
                  label: 'Archive',
                  icon: Archive,
                  hidden: p.status === 'archived',
                  onSelect: () => void run(`archive-${p.id}`, () => apiPost<ProductDetail>(`/products/${p.id}/archive`), { success: `${p.name} archived — its price history is kept` }),
                },
                {
                  label: 'Restore',
                  icon: ArchiveRestore,
                  hidden: p.status !== 'archived',
                  onSelect: () => void run(`restore-${p.id}`, () => apiPost<ProductDetail>(`/products/${p.id}/restore`), { success: `${p.name} restored` }),
                },
                {
                  label: 'Delete…',
                  icon: Trash2,
                  danger: true,
                  separatorBefore: true,
                  onSelect: () => {
                    setDeleteError(null);
                    setToDelete(p);
                  },
                },
              ]}
            />
          </RowActions>
        ),
      });
    }
    return fitColumns(cols, tableWidth);
  }, [canWrite, run, tableWidth]);

  async function confirmDelete() {
    if (!toDelete) return;
    const outcome = await run('delete-product', () => apiDelete(`/products/${toDelete.id}`), { success: `${toDelete.name} deleted`, quietError: true });
    if (outcome.ok) setToDelete(null);
    else setDeleteError(errorMessage(outcome.error, 'The product could not be deleted.'));
  }

  const data = products.data;
  const groupFilterKey = groupBy ? GROUP_FILTER[groupBy] : null;
  const activeGroupIds = groupFilterKey ? toList(state[groupFilterKey]) : [];

  return (
    <div>
      <FilterBar
        onReset={reset}
        activeCount={activeCount}
        trailing={
          <>
            <Segmented<GroupBy>
              label="Group by"
              value={groupBy}
              onChange={(v) => set({ group: v })}
              options={[
                { value: '', label: 'No grouping' },
                { value: 'brand', label: 'Brand' },
                { value: 'category', label: 'Category' },
                { value: 'market', label: 'Market' },
              ]}
            />
            {canWrite ? (
              <>
                <Button icon={Upload} onClick={() => setImportOpen(true)}>
                  Import
                </Button>
                <Button variant="primary" icon={Plus} onClick={() => setForm({ open: true, productId: null })}>
                  Add product
                </Button>
              </>
            ) : null}
          </>
        }
      >
        <SearchInput value={state.q ?? ''} onChange={(q) => setFilter({ q })} placeholder="Search name, code, SKU, barcode…" className="w-64" />
        <MultiSelect label="Brand" options={brandOptions} value={toList(state.brand_id)} onChange={(v) => setFilter({ brand_id: fromList(v) })} />
        <MultiSelect label="Category" options={categoryOptions} value={toList(state.category_id)} onChange={(v) => setFilter({ category_id: fromList(v) })} />
        <Segmented
          label="Ownership"
          value={state.ownership ?? ''}
          onChange={(v) => setFilter({ ownership: v })}
          options={[
            { value: '', label: 'All' },
            { value: 'own', label: 'Own' },
            { value: 'competitor', label: 'Competitor' },
          ]}
        />
        <MultiSelect label="Market" options={marketOptions} value={toList(state.market_id)} onChange={(v) => setFilter({ market_id: fromList(v) })} />
        <MultiSelect
          label="Status"
          single
          searchable={false}
          value={state.status ? [state.status] : []}
          onChange={(v) => setFilter({ status: v[0] ?? '' })}
          options={[
            { value: 'active', label: 'Active' },
            { value: 'inactive', label: 'Inactive' },
            { value: 'archived', label: 'Archived' },
            { value: 'all', label: 'All, including archived' },
          ]}
        />
      </FilterBar>

      {groupBy ? (
        <section aria-label={`Products by ${groupBy}`} className={cn('mb-4 transition-opacity', summary.isPlaceholderData && 'opacity-60')}>
          {summary.isError ? (
            <Notice tone="crit">{errorMessage(summary.error, 'The grouping could not be loaded.')}</Notice>
          ) : summary.data && summary.data.groups.length === 0 ? null : (
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
              {(summary.data?.groups ?? []).map((g) => {
                const selected = g.id !== null && activeGroupIds.includes(String(g.id));
                const body = (
                  <>
                    <span className="flex min-w-0 items-center gap-1.5">
                      {g.ownership ? <OwnershipDot ownership={g.ownership} /> : null}
                      <span className="truncate text-[12.5px] font-medium text-ink">{g.label}</span>
                    </span>
                    <span className="num shrink-0 text-[13px] font-semibold text-ink">{fmtNumber(g.count)}</span>
                  </>
                );
                return (
                  <li key={g.id ?? 'none'}>
                    {g.id === null || !groupFilterKey ? (
                      <div className="sheet flex items-center justify-between gap-3 px-3 py-2">{body}</div>
                    ) : (
                      <button
                        type="button"
                        aria-pressed={selected}
                        title={selected ? 'Remove this filter' : `Show only ${g.label}`}
                        onClick={() => {
                          const id = String(g.id);
                          setFilter({ [groupFilterKey]: fromList(selected ? activeGroupIds.filter((x) => x !== id) : [...activeGroupIds, id]) });
                        }}
                        className={cn('sheet flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:border-ink-4', selected && 'border-navy/70 bg-sunken')}
                      >
                        {body}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}

      <div ref={tableRef} className="min-w-0">
      <Card>
        {products.isError && !data ? (
          <ErrorState error={products.error} onRetry={() => void products.refetch()} />
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={data?.rows}
              rowKey={(p) => p.id}
              sort={state.sort || undefined}
              onSort={(sort) => set({ sort, page: null })}
              onRowClick={(p) => navigate(`/catalogue/products/${p.id}`)}
              loading={products.isPending}
              refetching={products.isPlaceholderData}
              empty={
                activeCount > 0 ? (
                  <EmptyState title="No products match these filters" description="Remove a filter or search for something else." action={<Button onClick={reset}>Reset filters</Button>} />
                ) : (
                  <EmptyState
                    icon={PackagePlus}
                    title="The catalogue is empty"
                    description="Add your own and competitor products, or import them from a CSV or Excel file."
                    action={
                      canWrite ? (
                        <span className="flex gap-2">
                          <Button icon={Upload} onClick={() => setImportOpen(true)}>
                            Import products
                          </Button>
                          <Button variant="primary" icon={Plus} onClick={() => setForm({ open: true, productId: null })}>
                            Add product
                          </Button>
                        </span>
                      ) : undefined
                    }
                  />
                )
              }
            />
            {data ? <Pagination page={data.page} pages={data.pages} total={data.total} pageSize={data.page_size} onPage={(p) => set({ page: String(p) })} noun="products" /> : null}
          </>
        )}
      </Card>
      </div>
      {data?.rows.some((p) => p.is_demo) ? (
        <p className="mt-2 flex items-center gap-1.5 text-[12px] text-ink-3">
          <DemoBadge /> marks illustrative demo products. They can be removed in Administration.
        </p>
      ) : null}

      <ProductFormDialog
        open={form.open}
        productId={form.productId}
        onClose={() => setForm((f) => ({ ...f, open: false }))}
        onSaved={(detail) => {
          if (!form.productId) navigate(`/catalogue/products/${detail.product.id}`);
        }}
      />
      <ImportWizard open={importOpen} kind="products" onClose={() => setImportOpen(false)} onCommitted={() => void products.refetch()} />
      <ConfirmDialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        onConfirm={() => void confirmDelete()}
        title="Delete this product?"
        confirmLabel="Delete product"
        danger
        loading={busy === 'delete-product'}
      >
        <p>
          <strong className="font-semibold text-ink">{toDelete?.name}</strong> ({toDelete?.code}) will be removed from the catalogue. A product that has retailer listings cannot be deleted — archive it instead so its
          price history is preserved.
        </p>
        {deleteError ? (
          <Notice
            tone="crit"
            className="mt-3"
            title="Not deleted"
            action={
              toDelete && toDelete.status !== 'archived' ? (
                <Button
                  size="sm"
                  icon={Archive}
                  onClick={async () => {
                    const target = toDelete;
                    const outcome = await run(`archive-${target.id}`, () => apiPost<ProductDetail>(`/products/${target.id}/archive`), { success: `${target.name} archived — its price history is kept` });
                    if (outcome.ok) setToDelete(null);
                  }}
                >
                  Archive instead
                </Button>
              ) : undefined
            }
          >
            {deleteError}
          </Notice>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
