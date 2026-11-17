/**
 * Competitor mappings tab: which competitor products each own product is compared against.
 * "Equivalent" is a claim of like-for-like; everything else is explicitly labelled non-equivalent.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ArrowLeftRight, Check, Ellipsis, Info, Pencil, Plus, Scale, Trash2, WandSparkles, X } from 'lucide-react';
import { apiDelete, apiPatch, apiPost, type Paged } from '@/lib/api.ts';
import { useCan } from '@/lib/auth.tsx';
import { fmtNumber, fmtPct } from '@/lib/format.ts';
import { fromList, toList, useApiQuery, useReference, useUrlState } from '@/lib/hooks.ts';
import { DataTable, Pagination, type Column } from '@/components/ui/data-table.tsx';
import { FilterBar, MultiSelect, ProductPicker, SearchInput } from '@/components/ui/filters.tsx';
import { ConfirmDialog, Dialog, Menu } from '@/components/ui/overlays.tsx';
import { Button, Card, cn, EmptyState, ErrorState, Field, IconButton, Notice, Segmented, Select, Textarea, Tip } from '@/components/ui/primitives.tsx';
import { ProductCell } from '@/components/domain/domain.tsx';
import type { MappingRow, MappingSuggestResponse, ProductOption } from '@shared/api/catalogue.ts';
import { CATALOGUE, EquivalenceBadge, errorMessage, MappingStatusBadge, RowActions, useCatalogueActions, useElementWidth } from './shared.tsx';

type MappingList = Paged<MappingRow> & { counts: { suggested: number; approved: number; rejected: number } };
type Equivalence = MappingRow['equivalence'];

function EquivalenceChoice({ value, onChange, unitsDiffer, name }: { value: Equivalence; onChange: (next: Equivalence) => void; unitsDiffer: boolean; name: string }) {
  const options: Array<{ value: Equivalence; title: string; text: string; disabled?: boolean }> = [
    {
      value: 'equivalent',
      title: 'Equivalent',
      text: unitsDiffer
        ? 'Not available: the two packs are measured in different units, so they cannot be like-for-like.'
        : 'Genuinely like-for-like: same need, format and comparable pack size. Shelf prices are compared directly when the packs hold the same content.',
      disabled: unitsDiffer,
    },
    {
      value: 'comparable',
      title: 'Non-equivalent',
      text: 'A relevant competitor, but not like-for-like. Compared on unit price only and labelled “non-equivalent” wherever it appears.',
    },
  ];
  return (
    <div role="radiogroup" aria-label="Equivalence" className="grid gap-2 sm:grid-cols-2">
      {options.map((o) => (
        <label
          key={o.value}
          className={cn(
            'flex gap-2.5 rounded-lg border px-3 py-2.5 text-[12.5px] leading-5',
            o.disabled ? 'cursor-not-allowed border-line bg-sunken text-ink-4' : value === o.value ? 'border-navy/70 bg-sunken text-ink-2' : 'border-line-strong text-ink-2 hover:border-ink-4',
          )}
        >
          <input type="radio" name={name} className="mt-1 size-3.5 shrink-0 accent-[var(--color-navy)]" checked={value === o.value} disabled={o.disabled} onChange={() => onChange(o.value)} />
          <span>
            <span className={cn('block font-semibold', o.disabled ? 'text-ink-4' : 'text-ink')}>{o.title}</span>
            {o.text}
          </span>
        </label>
      ))}
    </div>
  );
}

function PairSummary({ mapping }: { mapping: MappingRow }) {
  return (
    <div className="rounded-lg border border-line bg-sunken px-3 py-2.5">
      <div className="grid items-center gap-2 sm:grid-cols-[1fr_auto_1fr]">
        <ProductCell name={mapping.own.product_name} brand={mapping.own.brand_name} pack={mapping.own.pack_label} code={mapping.own.product_code} ownership="own" isDemo={mapping.own.is_demo} compact />
        <ArrowLeftRight className="hidden size-3.5 text-ink-4 sm:block" aria-hidden />
        <ProductCell name={mapping.competitor.product_name} brand={mapping.competitor.brand_name} pack={mapping.competitor.pack_label} code={mapping.competitor.product_code} ownership="competitor" isDemo={mapping.competitor.is_demo} compact />
      </div>
      <p className="mt-2 border-t border-line pt-2 text-[12px] leading-4 text-ink-3">{mapping.comparability.note}</p>
    </div>
  );
}

/** Approve a suggestion (or re-approve a rejected mapping): the reviewer states how the pair may be compared. */
function ApproveDialog({ mapping, onClose }: { mapping: MappingRow | null; onClose: () => void }) {
  const { run, busy } = useCatalogueActions();
  const [value, setValue] = useState<Equivalence>('comparable');
  const [error, setError] = useState<string | null>(null);
  const unitsDiffer = mapping?.comparability.same_dimension === false;
  useEffect(() => {
    if (mapping) {
      setValue(mapping.comparability.same_dimension === false ? 'comparable' : mapping.equivalence);
      setError(null);
    }
  }, [mapping]);
  async function submit() {
    if (!mapping) return;
    const outcome = await run('approve-mapping', () => apiPost<MappingRow>(`/mappings/${mapping.id}/approve`, { equivalence: value }), {
      success: `Mapping approved as ${value === 'equivalent' ? 'equivalent' : 'non-equivalent'}`,
      quietError: true,
    });
    if (outcome.ok) onClose();
    else setError(errorMessage(outcome.error, 'The mapping could not be approved.'));
  }
  return (
    <Dialog
      open={mapping !== null}
      onClose={onClose}
      title="Approve competitor mapping"
      description="Approved mappings are used in competitor comparisons, positioning and alerts."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={Check} onClick={() => void submit()} loading={busy === 'approve-mapping'}>
            Approve mapping
          </Button>
        </>
      }
    >
      {mapping ? (
        <div className="flex flex-col gap-4">
          {error ? <Notice tone="crit">{error}</Notice> : null}
          <PairSummary mapping={mapping} />
          <EquivalenceChoice name="approve-equivalence" value={value} onChange={setValue} unitsDiffer={unitsDiffer} />
        </div>
      ) : null}
    </Dialog>
  );
}

function EditDialog({ mapping, onClose }: { mapping: MappingRow | null; onClose: () => void }) {
  const { ref } = useReference();
  const { run, busy } = useCatalogueActions();
  const [value, setValue] = useState<Equivalence>('comparable');
  const [marketId, setMarketId] = useState('');
  const [rationale, setRationale] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (mapping) {
      setValue(mapping.equivalence);
      setMarketId(mapping.market_id ? String(mapping.market_id) : '');
      setRationale(mapping.rationale ?? '');
      setError(null);
    }
  }, [mapping]);
  async function submit() {
    if (!mapping) return;
    const outcome = await run(
      'edit-mapping',
      () => apiPatch<MappingRow>(`/mappings/${mapping.id}`, { equivalence: value, market_id: marketId ? Number(marketId) : null, rationale }),
      { success: 'Mapping updated', quietError: true },
    );
    if (outcome.ok) onClose();
    else setError(errorMessage(outcome.error, 'The mapping could not be updated.'));
  }
  return (
    <Dialog
      open={mapping !== null}
      onClose={onClose}
      title="Edit competitor mapping"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy === 'edit-mapping'}>
            Save changes
          </Button>
        </>
      }
    >
      {mapping ? (
        <div className="flex flex-col gap-4">
          {error ? <Notice tone="crit">{error}</Notice> : null}
          <PairSummary mapping={mapping} />
          <EquivalenceChoice name="edit-equivalence" value={value} onChange={setValue} unitsDiffer={mapping.comparability.same_dimension === false} />
          <Field label="Market scope" hint="A mapping without a market applies everywhere the two products are sold.">
            <Select value={marketId} onChange={(e) => setMarketId(e.target.value)}>
              <option value="">All markets</option>
              {(ref?.markets ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} only
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Rationale" hint="Why these two products are compared.">
            <Textarea value={rationale} onChange={(e) => setRationale(e.target.value)} maxLength={500} rows={2} />
          </Field>
        </div>
      ) : null}
    </Dialog>
  );
}

function AddDialog({ open, onClose, presetOwnId }: { open: boolean; onClose: () => void; presetOwnId?: string }) {
  const { ref } = useReference();
  const { run, busy } = useCatalogueActions();
  const [own, setOwn] = useState<string[]>([]);
  const [ownPicked, setOwnPicked] = useState<ProductOption | null>(null);
  const [competitor, setCompetitor] = useState<string[]>([]);
  const [competitorPicked, setCompetitorPicked] = useState<ProductOption | null>(null);
  const [mode, setMode] = useState<'auto' | Equivalence>('auto');
  const [marketId, setMarketId] = useState('');
  const [rationale, setRationale] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setOwn(presetOwnId ? [presetOwnId] : []);
      setOwnPicked(null);
      setCompetitor([]);
      setCompetitorPicked(null);
      setMode('auto');
      setMarketId('');
      setRationale('');
      setError(null);
    }
  }, [open, presetOwnId]);

  const unitsDiffer = !!ownPicked?.pack_unit && !!competitorPicked?.pack_unit && dimensionOf(ownPicked.pack_unit) !== dimensionOf(competitorPicked.pack_unit);

  async function submit() {
    if (own.length !== 1 || competitor.length !== 1) return setError('Choose one own product and one competitor product.');
    setError(null);
    const body: Record<string, unknown> = { own_product_id: Number(own[0]), competitor_product_id: Number(competitor[0]), market_id: marketId ? Number(marketId) : null, rationale };
    if (mode !== 'auto') body.equivalence = mode;
    const outcome = await run('add-mapping', () => apiPost<MappingRow>('/mappings', body), {
      success: (m) => `Mapping added as ${m.equivalence === 'equivalent' ? 'equivalent' : 'non-equivalent'}`,
      quietError: true,
    });
    if (outcome.ok) onClose();
    else setError(errorMessage(outcome.error, 'The mapping could not be added.'));
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add competitor mapping"
      description="Map one of your own products to a competitor product it should be compared with."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={Plus} onClick={() => void submit()} loading={busy === 'add-mapping'} disabled={own.length !== 1 || competitor.length !== 1}>
            Add mapping
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Notice tone="crit">{error}</Notice> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-[12px] font-medium text-ink-2">Own product</span>
            {/* leaves room for the picker's clear button, which sits outside its max-width */}
            <div className="max-w-[calc(100%-28px)]">
            <ProductPicker
              label="Own product"
              ownership="own"
              multiple={false}
              value={own}
              onChange={(next, picked) => {
                setOwn(next);
                setOwnPicked(next.length ? (picked ?? null) : null);
              }}
            />
            </div>
            {ownPicked ? <span className="text-[12px] text-ink-3">{ownPicked.brand_name} · {ownPicked.pack_label}</span> : null}
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-[12px] font-medium text-ink-2">Competitor product</span>
            <div className="max-w-[calc(100%-28px)]">
            <ProductPicker
              label="Competitor"
              ownership="competitor"
              multiple={false}
              value={competitor}
              onChange={(next, picked) => {
                setCompetitor(next);
                setCompetitorPicked(next.length ? (picked ?? null) : null);
              }}
            />
            </div>
            {competitorPicked ? <span className="text-[12px] text-ink-3">{competitorPicked.brand_name} · {competitorPicked.pack_label}</span> : null}
          </div>
        </div>
        {unitsDiffer ? (
          <Notice tone="warn" title="Units differ">
            {ownPicked?.pack_label} and {competitorPicked?.pack_label} are measured in different units. The pair can only be mapped as non-equivalent, and no unit-price gap will be calculated.
          </Notice>
        ) : null}
        <Field label="How may they be compared?">
          <Select value={unitsDiffer && mode === 'equivalent' ? 'comparable' : mode} onChange={(e) => setMode(e.target.value as 'auto' | Equivalence)}>
            <option value="auto">Decide from the pack sizes (equivalent only when sizes are within ±15%)</option>
            <option value="equivalent" disabled={unitsDiffer}>
              Equivalent — like-for-like
            </option>
            <option value="comparable">Non-equivalent — unit price only</option>
          </Select>
        </Field>
        <Field label="Market scope" hint="Leave on “All markets” unless the pairing only makes sense in one market.">
          <Select value={marketId} onChange={(e) => setMarketId(e.target.value)}>
            <option value="">All markets</option>
            {(ref?.markets ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} only
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Rationale">
          <Textarea value={rationale} onChange={(e) => setRationale(e.target.value)} maxLength={500} rows={2} placeholder="e.g. Same need and format, sold side by side" />
        </Field>
      </div>
    </Dialog>
  );
}

function dimensionOf(unit: string): 'volume' | 'mass' | 'count' {
  if (unit === 'ml' || unit === 'l') return 'volume';
  if (unit === 'g' || unit === 'kg') return 'mass';
  return 'count';
}

export function MappingsTab() {
  const canWrite = useCan('catalogue.write');
  const { ref } = useReference();
  const { run, busy } = useCatalogueActions();
  const { state, set, reset, activeCount } = useUrlState({ map_status: '', own_product_id: '', map_market: '', map_q: '', map_page: '1' });
  const [approve, setApprove] = useState<MappingRow | null>(null);
  const [edit, setEdit] = useState<MappingRow | null>(null);
  const [remove, setRemove] = useState<MappingRow | null>(null);
  const [adding, setAdding] = useState(false);
  const page = Math.max(1, Number(state.map_page) || 1);
  const ownIds = toList(state.own_product_id);
  // Layout follows the width of the list's card, not the viewport (the app shell's sidebar takes its share):
  // stacked cards when it is narrow, a table when there is room, with the product names given what is left.
  const [listRef, listWidth] = useElementWidth();
  const asCards = listWidth < 1060;
  const twoUp = listWidth >= 560;
  const statusInline = listWidth < 1240; // a Status column of its own only when both product names still get ~290 px
  const compareWidth = listWidth >= 1300 ? 256 : 208;
  const productWidth = Math.max(200, Math.min(304, Math.floor((listWidth - (compareWidth + 24) - (statusInline ? 0 : 132) - (canWrite ? 228 : 110) - 64) / 2)));

  const mappings = useApiQuery<MappingList>([CATALOGUE, 'mappings'], '/mappings', {
    status: state.map_status,
    own_product_id: state.own_product_id,
    market_id: state.map_market,
    q: state.map_q,
    page,
    page_size: 50,
  });
  const data = mappings.data;
  const counts = data?.counts;
  const totalAll = counts ? counts.suggested + counts.approved + counts.rejected : null;

  // Row actions, shared by the table and the stacked cards.
  const actions = useCallback(
    (m: MappingRow) => (
      <>
        {m.status === 'approved' ? (
          <Link to={`/competitors?product_id=${m.own.product_id}`} className="link inline-flex items-center gap-1 text-[12.5px]" title="Open the competitor comparison for the own product">
            <Scale className="size-3" aria-hidden /> Compare
          </Link>
        ) : null}
        {canWrite && m.status === 'suggested' ? (
          <>
            <Button size="sm" icon={X} onClick={() => void run(`reject-${m.id}`, () => apiPost(`/mappings/${m.id}/reject`), { success: 'Suggestion rejected' })} loading={busy === `reject-${m.id}`}>
              Reject
            </Button>
            <Button size="sm" variant="primary" icon={Check} onClick={() => setApprove(m)}>
              Approve
            </Button>
          </>
        ) : null}
        {canWrite ? (
          <Menu
            trigger={<IconButton icon={Ellipsis} label="More actions" size="sm" />}
            items={[
              { label: 'Approve…', icon: Check, hidden: m.status !== 'rejected', onSelect: () => setApprove(m) },
              { label: 'Edit', icon: Pencil, onSelect: () => setEdit(m) },
              {
                label: 'Reject',
                icon: X,
                hidden: m.status !== 'approved',
                onSelect: () => void run(`reject-${m.id}`, () => apiPost(`/mappings/${m.id}/reject`), { success: 'Mapping rejected — it is no longer used in comparisons' }),
              },
              { label: 'Delete…', icon: Trash2, danger: true, separatorBefore: true, onSelect: () => setRemove(m) },
            ]}
          />
        ) : null}
      </>
    ),
    [busy, canWrite, run],
  );

  const statusOf = useCallback(
    (m: MappingRow, withLabel = false) => (
      <>
        <MappingStatusBadge status={m.status} />
        {m.status === 'suggested' && m.score !== null ? (
          <span className="num text-[11.5px] text-ink-3" title="Suggestion score">
            {fmtPct(m.score * 100, 0)}
            {withLabel ? ' score' : ''}
          </span>
        ) : null}
      </>
    ),
    [],
  );

  const columns = useMemo<Array<Column<MappingRow>>>(() => {
    const cols: Array<Column<MappingRow>> = [
      {
        key: 'own',
        header: 'Own product',
        cell: (m) => (
          <div style={{ maxWidth: productWidth }}>
            <ProductCell name={m.own.product_name} brand={m.own.brand_name} pack={m.own.pack_label} code={m.own.product_code} ownership="own" productId={m.own.product_id} isDemo={m.own.is_demo} compact />
          </div>
        ),
      },
      {
        key: 'competitor',
        header: 'Competitor product',
        cell: (m) => (
          <div style={{ maxWidth: productWidth }}>
            <ProductCell name={m.competitor.product_name} brand={m.competitor.brand_name} pack={m.competitor.pack_label} code={m.competitor.product_code} ownership="competitor" productId={m.competitor.product_id} isDemo={m.competitor.is_demo} compact />
          </div>
        ),
      },
      {
        key: 'equivalence',
        header: statusInline ? 'How they compare · status' : 'How they compare',
        cell: (m) => (
          <div style={{ width: compareWidth }}>
            <span className="flex flex-wrap items-center gap-1.5">
              <EquivalenceBadge mapping={m} />
              {m.rationale ? (
                <Tip content={`Rationale: ${m.rationale}`}>
                  <span tabIndex={0} className="inline-flex text-ink-4 hover:text-ink-2" aria-label={`Rationale: ${m.rationale}`}>
                    <Info className="size-3.5" aria-hidden />
                  </span>
                </Tip>
              ) : null}
              {statusInline ? statusOf(m) : null}
            </span>
            <span className="mt-1 block text-[11.5px] leading-4 text-ink-3">{m.comparability.note}</span>
            <span className="mt-0.5 block text-[11.5px] leading-4 text-ink-4">{m.market_name ? `${m.market_name} only` : 'All markets'}</span>
          </div>
        ),
      },
    ];
    if (!statusInline) {
      cols.push({ key: 'status', header: 'Status', nowrap: true, cell: (m) => <span className="inline-flex items-center gap-1.5">{statusOf(m)}</span> });
    }
    cols.push({ key: 'actions', header: <span className="sr-only">Actions</span>, align: 'right', nowrap: true, cell: (m) => <RowActions>{actions(m)}</RowActions> });
    return cols;
  }, [actions, compareWidth, productWidth, statusInline, statusOf]);

  return (
    <div>
      <FilterBar
        onReset={reset}
        activeCount={activeCount}
        trailing={
          canWrite ? (
            <>
              <Button
                icon={WandSparkles}
                loading={busy === 'suggest-mappings'}
                title={ownIds.length === 1 ? 'Propose competitor products for the selected own product' : 'Propose competitor products for every own product'}
                onClick={async () => {
                  const outcome = await run(
                    'suggest-mappings',
                    () => apiPost<MappingSuggestResponse>('/mappings/suggest', ownIds.length === 1 ? { own_product_id: Number(ownIds[0]) } : {}),
                    {
                      success: (r) =>
                        r.created > 0
                          ? `${fmtNumber(r.created)} new suggestion${r.created === 1 ? '' : 's'} added for review (${fmtNumber(r.own_products_considered)} own products considered)`
                          : `No new suggestions — ${fmtNumber(r.own_products_considered)} own products considered, every candidate pair already exists`,
                      errorTitle: 'Could not generate suggestions',
                    },
                  );
                  if (outcome.ok && outcome.result.created > 0) set({ map_status: 'suggested', map_page: null });
                }}
              >
                Suggest mappings
              </Button>
              <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>
                Add mapping
              </Button>
            </>
          ) : undefined
        }
      >
        <Segmented
          label="Status"
          value={state.map_status ?? ''}
          onChange={(v) => set({ map_status: v, map_page: null })}
          options={[
            { value: '', label: `All${totalAll !== null ? ` (${fmtNumber(totalAll)})` : ''}` },
            { value: 'suggested', label: `Suggested${counts ? ` (${fmtNumber(counts.suggested)})` : ''}` },
            { value: 'approved', label: `Approved${counts ? ` (${fmtNumber(counts.approved)})` : ''}` },
            { value: 'rejected', label: `Rejected${counts ? ` (${fmtNumber(counts.rejected)})` : ''}` },
          ]}
        />
        <ProductPicker label="Own product" ownership="own" multiple={false} value={ownIds} onChange={(v) => set({ own_product_id: fromList(v), map_page: null })} />
        <MultiSelect
          label="Market"
          single
          value={toList(state.map_market)}
          onChange={(v) => set({ map_market: fromList(v), map_page: null })}
          options={(ref?.markets ?? []).map((m) => ({ value: String(m.id), label: m.name }))}
        />
        <SearchInput value={state.map_q ?? ''} onChange={(map_q) => set({ map_q, map_page: null })} placeholder="Search product or brand…" />
      </FilterBar>

      <div ref={listRef} className="min-w-0">
      <Card>
        {mappings.isError && !data ? (
          <ErrorState error={mappings.error} onRetry={() => void mappings.refetch()} />
        ) : (
          <>
            {asCards && data && data.rows.length > 0 ? (
              <ul className={cn('transition-opacity', mappings.isPlaceholderData && 'opacity-60')}>
                {data.rows.map((m) => (
                  <li key={m.id} className="flex flex-col gap-2.5 border-t border-line px-4 py-3 first:border-t-0">
                    <div className={cn('grid gap-x-6 gap-y-2.5', twoUp && 'grid-cols-2')}>
                      <div className="min-w-0">
                        <ProductCell name={m.own.product_name} brand={m.own.brand_name} pack={m.own.pack_label} code={m.own.product_code} ownership="own" productId={m.own.product_id} isDemo={m.own.is_demo} compact />
                      </div>
                      <div className="min-w-0">
                        <ProductCell name={m.competitor.product_name} brand={m.competitor.brand_name} pack={m.competitor.pack_label} code={m.competitor.product_code} ownership="competitor" productId={m.competitor.product_id} isDemo={m.competitor.is_demo} compact />
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <EquivalenceBadge mapping={m} />
                        {statusOf(m, true)}
                      </div>
                      {twoUp ? <div className="flex items-center gap-2">{actions(m)}</div> : null}
                    </div>
                    <p className="text-[11.5px] leading-4 text-ink-3">
                      {m.comparability.note} · {m.market_name ? `${m.market_name} only` : 'All markets'}
                      {m.rationale && m.rationale !== m.comparability.note ? ` · Rationale: ${m.rationale}` : ''}
                    </p>
                    {twoUp ? null : <div className="flex flex-wrap items-center justify-end gap-2">{actions(m)}</div>}
                  </li>
                ))}
              </ul>
            ) : (
            <DataTable
              columns={columns}
              rows={data?.rows}
              rowKey={(m) => m.id}
              loading={mappings.isPending}
              refetching={mappings.isPlaceholderData}
              empty={
                activeCount > 0 ? (
                  <EmptyState title="No mappings match these filters" action={<Button onClick={reset}>Reset filters</Button>} />
                ) : (
                  <EmptyState
                    icon={ArrowLeftRight}
                    title="No competitor mappings yet"
                    description="Mappings tell the system which competitor products each of your products is compared with. Generate suggestions from the catalogue or add one yourself."
                    action={
                      canWrite ? (
                        <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>
                          Add mapping
                        </Button>
                      ) : undefined
                    }
                  />
                )
              }
            />
            )}
            {data ? <Pagination page={data.page} pages={data.pages} total={data.total} pageSize={data.page_size} onPage={(p) => set({ map_page: String(p) })} noun="mappings" /> : null}
          </>
        )}
      </Card>
      </div>
      <p className="mt-2 text-[12px] leading-5 text-ink-3">
        Only approved mappings are used in comparisons. Suggestions are never approved automatically. Products measured in different units (for example grams and millilitres) can be mapped as non-equivalent, but no
        unit-price gap is calculated for them.
      </p>

      <ApproveDialog mapping={approve} onClose={() => setApprove(null)} />
      <EditDialog mapping={edit} onClose={() => setEdit(null)} />
      <AddDialog open={adding} onClose={() => setAdding(false)} presetOwnId={ownIds.length === 1 ? ownIds[0] : undefined} />
      <ConfirmDialog
        open={remove !== null}
        onClose={() => setRemove(null)}
        title="Delete this mapping?"
        confirmLabel="Delete mapping"
        danger
        loading={busy === 'delete-mapping'}
        onConfirm={async () => {
          if (!remove) return;
          const outcome = await run('delete-mapping', () => apiDelete(`/mappings/${remove.id}`), { success: 'Mapping deleted' });
          if (outcome.ok) setRemove(null);
        }}
      >
        <p>
          <strong className="font-semibold text-ink">{remove?.own.product_name}</strong> will no longer be compared with <strong className="font-semibold text-ink">{remove?.competitor.product_name}</strong>. Price history
          is not affected. To keep a record that the pair was reviewed and dismissed, reject the mapping instead.
        </p>
      </ConfirmDialog>
    </div>
  );
}
