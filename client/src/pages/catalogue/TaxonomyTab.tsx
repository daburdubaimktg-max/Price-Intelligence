/** Brands & categories tab: brand ownership, brand-level competitor associations and the two-level category tree. */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { CornerDownRight, Ellipsis, FolderTree, Pencil, Plus, Tags, Trash2, Users } from 'lucide-react';
import { apiDelete, apiPatch, apiPost, apiPut } from '@/lib/api.ts';
import { useCan } from '@/lib/auth.tsx';
import { fmtNumber } from '@/lib/format.ts';
import { useApiQuery } from '@/lib/hooks.ts';
import { DataTable } from '@/components/ui/data-table.tsx';
import { ConfirmDialog, Dialog, Menu } from '@/components/ui/overlays.tsx';
import { Badge, Button, Card, CardHeader, cn, EmptyState, ErrorState, Field, IconButton, Input, LoadingBlock, Notice, Select, Switch } from '@/components/ui/primitives.tsx';
import { DemoBadge, OwnershipBadge } from '@/components/domain/domain.tsx';
import type { BrandRow, CategoryRow } from '@shared/api/catalogue.ts';
import { CATALOGUE, CheckList, errorMessage, fitColumns, RowActions, useCatalogueActions, useElementWidth, type FitColumn } from './shared.tsx';

// ---------------------------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------------------------
function BrandDialog({ open, brand, onClose }: { open: boolean; brand: BrandRow | null; onClose: () => void }) {
  const { run, busy } = useCatalogueActions();
  const [name, setName] = useState('');
  const [ownership, setOwnership] = useState<'own' | 'competitor'>('competitor');
  const [manufacturer, setManufacturer] = useState('');
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setName(brand?.name ?? '');
    setOwnership(brand?.ownership ?? 'competitor');
    setManufacturer(brand?.manufacturer ?? '');
    setActive(brand ? brand.is_active === 1 : true);
    setError(null);
  }, [open, brand]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError('Enter the brand name.');
    setError(null);
    const body = { name: name.trim(), ownership, manufacturer, is_active: active };
    const outcome = await run('save-brand', () => (brand ? apiPatch<BrandRow>(`/brands/${brand.id}`, body) : apiPost<BrandRow>('/brands', body)), {
      success: (b) => (brand ? `${b.name} updated` : `${b.name} added`),
      quietError: true,
    });
    if (outcome.ok) onClose();
    else setError(errorMessage(outcome.error, 'The brand could not be saved.'));
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={brand ? 'Edit brand' : 'Add brand'}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="brand-form" loading={busy === 'save-brand'}>
            {brand ? 'Save changes' : 'Add brand'}
          </Button>
        </>
      }
    >
      <form id="brand-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {error ? <Notice tone="crit">{error}</Notice> : null}
        <Field label="Brand name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required autoFocus />
        </Field>
        <Field label="Ownership" required hint="Own brands are compared against competitor brands. Every product inherits this from its brand.">
          <Select value={ownership} onChange={(e) => setOwnership(e.target.value as 'own' | 'competitor')}>
            <option value="own">Own brand</option>
            <option value="competitor">Competitor brand</option>
          </Select>
        </Field>
        <Field label="Manufacturer / owner">
          <Input value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} maxLength={200} />
        </Field>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] text-ink-2">
            <span className="block font-medium text-ink">Active</span>
            Inactive brands stay in history but are hidden from pickers.
          </span>
          <Switch checked={active} onChange={setActive} label="Brand is active" />
        </div>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/** Which competitor brands an own brand is benchmarked against (brand-level association). */
function CompetitorBrandsDialog({ brand, brands, onClose }: { brand: BrandRow | null; brands: BrandRow[]; onClose: () => void }) {
  const { run, busy } = useCatalogueActions();
  const [selected, setSelected] = useState<number[]>([]);
  useEffect(() => {
    if (brand) setSelected(brand.competitor_brand_ids);
  }, [brand]);
  const competitors = brands.filter((b) => b.ownership === 'competitor');
  return (
    <Dialog
      open={brand !== null}
      onClose={onClose}
      title={`Competitor brands of ${brand?.name ?? ''}`}
      description="The competitor brands this brand is benchmarked against. Product-level comparisons still use the approved product mappings."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy === 'save-competitors'}
            onClick={async () => {
              if (!brand) return;
              const outcome = await run('save-competitors', () => apiPut<BrandRow>(`/brands/${brand.id}/competitors`, { competitor_brand_ids: selected }), {
                success: `${brand.name} is benchmarked against ${fmtNumber(selected.length)} competitor brand${selected.length === 1 ? '' : 's'}`,
              });
              if (outcome.ok) onClose();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      {competitors.length ? (
        <CheckList
          value={selected}
          onChange={setSelected}
          options={competitors.map((b) => ({ value: b.id, label: b.name, hint: [b.manufacturer, `${fmtNumber(b.product_count)} product${b.product_count === 1 ? '' : 's'}`].filter(Boolean).join(' · ') }))}
        />
      ) : (
        <EmptyState title="No competitor brands yet" description="Add a competitor brand first." />
      )}
    </Dialog>
  );
}

function BrandsCard() {
  const canWrite = useCan('catalogue.write');
  const { run, busy } = useCatalogueActions();
  const brands = useApiQuery<{ rows: BrandRow[] }>([CATALOGUE, 'brands'], '/brands');
  const [dialog, setDialog] = useState<{ open: boolean; brand: BrandRow | null }>({ open: false, brand: null });
  const [competitorsOf, setCompetitorsOf] = useState<BrandRow | null>(null);
  const [remove, setRemove] = useState<BrandRow | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const rows = brands.data?.rows ?? [];
  const nameOf = useMemo(() => new Map(rows.map((b) => [b.id, b.name])), [rows]);
  // columns follow the width of this card (it shares the row with the categories on wide screens)
  const [cardRef, cardWidth] = useElementWidth();

  const columns: Array<FitColumn<BrandRow>> = [
    {
      key: 'name',
      header: 'Brand',
      cell: (b) => (
        <span className="block whitespace-nowrap">
          <span className="flex items-center gap-1.5">
            <span className="font-medium text-ink">{b.name}</span>
            {b.is_demo ? <DemoBadge /> : null}
            {!b.is_active ? <Badge tone="neutral">Inactive</Badge> : null}
          </span>
          <span className="block text-[11.5px] leading-4 text-ink-3">{b.manufacturer ?? 'Manufacturer not set'}</span>
        </span>
      ),
    },
    { key: 'ownership', header: 'Ownership', nowrap: true, cell: (b) => <OwnershipBadge ownership={b.ownership} /> },
    { key: 'products', header: 'Products', align: 'right', minWidth: 430, cell: (b) => fmtNumber(b.product_count) },
    {
      key: 'benchmark',
      header: 'Benchmarked against',
      minWidth: 610,
      cell: (b) => {
        const ids = b.ownership === 'own' ? b.competitor_brand_ids : b.benchmarked_by_brand_ids;
        const names = ids.map((id) => nameOf.get(id)).filter(Boolean) as string[];
        if (b.ownership === 'competitor') {
          return names.length ? <span className="text-[12px] text-ink-3">Competitor of {names.join(', ')}</span> : <span className="text-ink-4">—</span>;
        }
        return names.length ? (
          <span className="flex max-w-96 flex-wrap gap-1">
            {names.map((n) => (
              <Badge key={n} tone="comp">
                {n}
              </Badge>
            ))}
          </span>
        ) : (
          <span className="text-[12px] text-ink-4">No competitor brands set</span>
        );
      },
    },
  ];
  if (canWrite) {
    columns.push({
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      width: '44px',
      cell: (b) => (
        <RowActions>
          <Menu
            trigger={<IconButton icon={Ellipsis} label={`Actions for ${b.name}`} size="sm" />}
            items={[
              { label: 'Edit', icon: Pencil, onSelect: () => setDialog({ open: true, brand: b }) },
              { label: 'Competitor brands…', icon: Users, hidden: b.ownership !== 'own', onSelect: () => setCompetitorsOf(b) },
              {
                label: 'Delete…',
                icon: Trash2,
                danger: true,
                separatorBefore: true,
                onSelect: () => {
                  setRemoveError(null);
                  setRemove(b);
                },
              },
            ]}
          />
        </RowActions>
      ),
    });
  }

  return (
    <div ref={cardRef} className="min-w-0">
    <Card>
      <CardHeader
        title="Brands"
        subtitle="Own brands and the competitor brands they are measured against."
        actions={
          canWrite ? (
            <Button size="sm" variant="primary" icon={Plus} onClick={() => setDialog({ open: true, brand: null })}>
              Add brand
            </Button>
          ) : undefined
        }
      />
      {brands.isError && !brands.data ? (
        <ErrorState error={brands.error} onRetry={() => void brands.refetch()} />
      ) : (
        <DataTable
          columns={fitColumns(columns, cardWidth)}
          rows={brands.data?.rows}
          rowKey={(b) => b.id}
          loading={brands.isPending}
          refetching={brands.isPlaceholderData}
          dense
          empty={<EmptyState icon={Tags} title="No brands yet" description="Add your own brands and the competitor brands you want to track." />}
        />
      )}
      <BrandDialog open={dialog.open} brand={dialog.brand} onClose={() => setDialog((d) => ({ ...d, open: false }))} />
      <CompetitorBrandsDialog brand={competitorsOf} brands={rows} onClose={() => setCompetitorsOf(null)} />
      <ConfirmDialog
        open={remove !== null}
        onClose={() => setRemove(null)}
        title="Delete this brand?"
        confirmLabel="Delete brand"
        danger
        loading={busy === 'delete-brand'}
        onConfirm={async () => {
          if (!remove) return;
          const outcome = await run('delete-brand', () => apiDelete(`/brands/${remove.id}`), { success: `${remove.name} deleted`, quietError: true });
          if (outcome.ok) setRemove(null);
          else setRemoveError(errorMessage(outcome.error, 'The brand could not be deleted.'));
        }}
      >
        <p>
          <strong className="font-semibold text-ink">{remove?.name}</strong> will be removed. A brand that has products cannot be deleted.
        </p>
        {removeError ? (
          <Notice tone="crit" className="mt-3" title="Not deleted">
            {removeError}
          </Notice>
        ) : null}
      </ConfirmDialog>
    </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------------------------
interface CategoryDialogState {
  open: boolean;
  /** Edit this row… */
  category: CategoryRow | null;
  /** …or create under this parent (null = top-level). */
  parentId: number | null;
}

function CategoryDialog({ state, topLevel, onClose }: { state: CategoryDialogState; topLevel: CategoryRow[]; onClose: () => void }) {
  const { run, busy } = useCatalogueActions();
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const editing = state.category;
  useEffect(() => {
    if (!state.open) return;
    setName(state.category?.name ?? '');
    setParentId(state.category ? (state.category.parent_id ? String(state.category.parent_id) : '') : state.parentId ? String(state.parentId) : '');
    setError(null);
  }, [state]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError('Enter a name.');
    setError(null);
    const outcome = await run(
      'save-category',
      () =>
        editing
          ? apiPatch<CategoryRow>(`/categories/${editing.id}`, { name: name.trim() })
          : apiPost<CategoryRow>('/categories', { name: name.trim(), parent_id: parentId ? Number(parentId) : null }),
      { success: (c) => (editing ? `Renamed to ${c.name}` : `${c.name} added${c.parent_name ? ` under ${c.parent_name}` : ''}`), quietError: true },
    );
    if (outcome.ok) onClose();
    else setError(errorMessage(outcome.error, 'The category could not be saved.'));
  }

  return (
    <Dialog
      open={state.open}
      onClose={onClose}
      title={editing ? `Rename ${editing.parent_id ? 'subcategory' : 'category'}` : parentId ? 'Add subcategory' : 'Add category'}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="category-form" loading={busy === 'save-category'}>
            {editing ? 'Rename' : 'Add'}
          </Button>
        </>
      }
    >
      <form id="category-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {error ? <Notice tone="crit">{error}</Notice> : null}
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required autoFocus />
        </Field>
        {!editing ? (
          <Field label="Parent category" hint="Categories have two levels: category → subcategory.">
            <Select value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">None — top-level category</option>
              {topLevel.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function CategoriesCard() {
  const canWrite = useCan('catalogue.write');
  const { run, busy } = useCatalogueActions();
  const categories = useApiQuery<{ rows: CategoryRow[] }>([CATALOGUE, 'categories'], '/categories');
  const [dialog, setDialog] = useState<CategoryDialogState>({ open: false, category: null, parentId: null });
  const [remove, setRemove] = useState<CategoryRow | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const rows = categories.data?.rows ?? [];
  const topLevel = useMemo(() => rows.filter((c) => c.parent_id === null).sort((a, b) => a.name.localeCompare(b.name)), [rows]);
  const childrenOf = (id: number) => rows.filter((c) => c.parent_id === id).sort((a, b) => a.name.localeCompare(b.name));

  const actions = (c: CategoryRow) =>
    canWrite ? (
      <Menu
        trigger={<IconButton icon={Ellipsis} label={`Actions for ${c.name}`} size="sm" />}
        items={[
          { label: 'Add subcategory', icon: Plus, hidden: c.parent_id !== null, onSelect: () => setDialog({ open: true, category: null, parentId: c.id }) },
          { label: 'Rename', icon: Pencil, onSelect: () => setDialog({ open: true, category: c, parentId: null }) },
          {
            label: 'Delete…',
            icon: Trash2,
            danger: true,
            separatorBefore: true,
            onSelect: () => {
              setRemoveError(null);
              setRemove(c);
            },
          },
        ]}
      />
    ) : null;

  const row = (c: CategoryRow, child: boolean) => (
    <li key={c.id} className={cn('flex items-center justify-between gap-3 border-t border-line px-4 first:border-t-0', child ? 'py-1.5 pl-6' : 'bg-sunken py-2')}>
      <span className="flex min-w-0 items-center gap-2">
        {child ? <CornerDownRight className="size-3.5 shrink-0 text-ink-4" aria-hidden /> : null}
        <span className={cn('truncate text-[13px]', child ? 'text-ink-2' : 'font-semibold text-ink')}>{c.name}</span>
        {c.is_demo ? <DemoBadge /> : null}
      </span>
      <span className="flex shrink-0 items-center gap-3">
        <span className="num text-[12px] text-ink-3" title="Products using this as their category or subcategory">
          {fmtNumber(c.product_count)} product{c.product_count === 1 ? '' : 's'}
        </span>
        {actions(c)}
      </span>
    </li>
  );

  return (
    <Card>
      <CardHeader
        title="Categories"
        subtitle="Two levels: category → subcategory."
        actions={
          canWrite ? (
            <Button size="sm" variant="primary" icon={Plus} onClick={() => setDialog({ open: true, category: null, parentId: null })}>
              Add category
            </Button>
          ) : undefined
        }
      />
      {categories.isError && !categories.data ? (
        <ErrorState error={categories.error} onRetry={() => void categories.refetch()} />
      ) : categories.isPending ? (
        <LoadingBlock />
      ) : topLevel.length === 0 ? (
        <EmptyState icon={FolderTree} title="No categories yet" description="Create a category such as “Hair Care”, then add subcategories like “Hair Oil”." />
      ) : (
        <ul className={cn('transition-opacity', categories.isPlaceholderData && 'opacity-60')}>
          {topLevel.flatMap((c) => [row(c, false), ...childrenOf(c.id).map((s) => row(s, true))])}
        </ul>
      )}
      <CategoryDialog state={dialog} topLevel={topLevel} onClose={() => setDialog((d) => ({ ...d, open: false }))} />
      <ConfirmDialog
        open={remove !== null}
        onClose={() => setRemove(null)}
        title={`Delete this ${remove?.parent_id ? 'subcategory' : 'category'}?`}
        confirmLabel="Delete"
        danger
        loading={busy === 'delete-category'}
        onConfirm={async () => {
          if (!remove) return;
          const outcome = await run('delete-category', () => apiDelete(`/categories/${remove.id}`), { success: `${remove.name} deleted`, quietError: true });
          if (outcome.ok) setRemove(null);
          else setRemoveError(errorMessage(outcome.error, 'The category could not be deleted.'));
        }}
      >
        <p>
          <strong className="font-semibold text-ink">{remove?.name}</strong> will be removed. A category that is used by products or still has subcategories cannot be deleted.
        </p>
        {removeError ? (
          <Notice tone="crit" className="mt-3" title="Not deleted">
            {removeError}
          </Notice>
        ) : null}
      </ConfirmDialog>
    </Card>
  );
}

export function TaxonomyTab() {
  // side by side only when the tab really has the room for both cards
  const [ref, width] = useElementWidth();
  return (
    <div ref={ref} className={cn('grid items-start gap-4', width >= 1100 && 'grid-cols-[minmax(0,3fr)_minmax(0,2fr)]')}>
      <BrandsCard />
      <CategoriesCard />
    </div>
  );
}
