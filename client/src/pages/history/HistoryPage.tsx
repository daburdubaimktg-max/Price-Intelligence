/**
 * Historical Price Explorer — retrieve any stored observation by brand, product, SKU, competitor, category,
 * retailer, market, date range, price range, promotion status and source, then read it as a timeline,
 * a period comparison, the records themselves, or a volatility ranking.
 */
import { useMemo } from 'react';
import { Page } from '@/app/AppShell.tsx';
import { useReference, toList, fromList } from '@/lib/hooks.ts';
import { PageHeader } from '@/components/ui/primitives.tsx';
import { DateRangePicker, FilterBar, matchPreset, MultiSelect, ProductPicker, SearchInput, type Option } from '@/components/ui/filters.tsx';
import { DemoNotice } from '@/components/domain/domain.tsx';
import { DATA_CLASSES, DATA_CLASS_LABELS } from '@shared/constants.ts';
import { CompareCard } from './CompareCard.tsx';
import { DEFAULT_PRESET, HISTORY_PRESETS, useHistoryFilters } from './filters.ts';
import { ObservationsCard } from './ObservationsCard.tsx';
import { CurrencySelect, PriceRangeFilter } from './parts.tsx';
import { SummaryStrip, useHistorySummary } from './SummaryStrip.tsx';
import { TimelineCard } from './TimelineCard.tsx';
import { ChangesCard } from './ChangesCard.tsx';
import { VolatilityCard } from './VolatilityCard.tsx';

export default function HistoryPage() {
  const filters = useHistoryFilters();
  const { state, setScope, set } = filters;
  const { ref } = useReference();
  const summary = useHistorySummary(filters);

  const selectedMarkets = useMemo(() => new Set(toList(state.market_id)), [state.market_id]);
  const options = useMemo(() => {
    const markets: Option[] = (ref?.markets ?? []).filter((m) => m.is_active).map((m) => ({ value: String(m.id), label: m.name, sublabel: `${m.country_name} · ${m.currency_code}` }));
    const marketName = new Map((ref?.markets ?? []).map((m) => [m.id, m.name]));
    const retailers: Option[] = (ref?.retailers ?? [])
      .filter((r) => r.is_active && (selectedMarkets.size === 0 || selectedMarkets.has(String(r.market_id))))
      .map((r) => ({ value: String(r.id), label: r.name, group: marketName.get(r.market_id) ?? 'Other' }));
    const brands: Option[] = [...(ref?.brands ?? [])]
      .sort((a, b) => (a.ownership === b.ownership ? a.name.localeCompare(b.name) : a.ownership === 'own' ? -1 : 1))
      .map((b) => ({ value: String(b.id), label: b.name, group: b.ownership === 'own' ? 'Own brands' : 'Competitor brands' }));
    const byId = new Map((ref?.categories ?? []).map((c) => [c.id, c]));
    const categories: Option[] = [
      ...(ref?.categories ?? []).filter((c) => c.parent_id === null).map((c) => ({ value: String(c.id), label: c.name, group: 'Categories' })),
      ...(ref?.categories ?? []).filter((c) => c.parent_id !== null).map((c) => ({ value: String(c.id), label: c.name, group: byId.get(c.parent_id!)?.name ?? 'Subcategories' })),
    ];
    return { markets, retailers, brands, categories };
  }, [ref, selectedMarkets]);

  const demo = summary.data
    ? { any_demo: summary.data.demo_observations > 0, all_demo: summary.data.observations > 0 && summary.data.demo_observations === summary.data.observations }
    : null;

  return (
    <Page>
      <PageHeader
        title="Historical Price Explorer"
        description="Every observation ever stored stays retrievable. Filter by brand, product, SKU, competitor, category, retailer, market, dates, price and promotion status — the charts, comparison, records and export below all use the same selection."
      />

      <FilterBar
        activeCount={filters.scopeCount}
        onReset={filters.resetScope}
        trailing={<CurrencySelect label="Compare in" value={filters.currency} reportingCurrency={filters.reportingCurrency} onChange={(v) => set({ currency: v })} />}
      >
        <DateRangePicker
          value={filters.range ?? {}}
          today={filters.today ?? ''}
          presets={HISTORY_PRESETS}
          min={filters.firstDate}
          onChange={(next) => {
            const preset = filters.today ? matchPreset(next, filters.today, HISTORY_PRESETS) : null;
            if (preset) setScope({ period: preset === DEFAULT_PRESET ? undefined : preset, from: undefined, to: undefined });
            else setScope({ from: next.from, to: next.to, period: undefined });
          }}
        />
        <MultiSelect label="Market" options={options.markets} value={toList(state.market_id)} onChange={(v) => setScope({ market_id: fromList(v) })} />
        <MultiSelect label="Retailer" options={options.retailers} value={toList(state.retailer_id)} onChange={(v) => setScope({ retailer_id: fromList(v) })} searchable />
        <MultiSelect label="Brand" options={options.brands} value={toList(state.brand_id)} onChange={(v) => setScope({ brand_id: fromList(v) })} searchable />
        <ProductPicker value={toList(state.product_id)} onChange={(v) => setScope({ product_id: fromList(v) })} />
        <MultiSelect label="Category" options={options.categories} value={toList(state.category_id)} onChange={(v) => setScope({ category_id: fromList(v) })} />
        <MultiSelect
          label="Ownership"
          single
          options={[
            { value: 'own', label: 'Own brands' },
            { value: 'competitor', label: 'Competitors' },
          ]}
          value={toList(state.ownership)}
          onChange={(v) => setScope({ ownership: v[0] })}
        />
        <MultiSelect
          label="Promotion"
          single
          options={[
            { value: 'true', label: 'On promotion' },
            { value: 'false', label: 'Not on promotion' },
          ]}
          value={toList(state.promo)}
          onChange={(v) => setScope({ promo: v[0] })}
        />
        <MultiSelect
          label="Source"
          options={DATA_CLASSES.map((dc) => ({ value: dc, label: DATA_CLASS_LABELS[dc] }))}
          value={toList(state.data_class)}
          onChange={(v) => setScope({ data_class: fromList(v) })}
        />
        <PriceRangeFilter min={state.price_min} max={state.price_max} onChange={(next) => setScope({ price_min: next.min, price_max: next.max })} />
        <SearchInput value={state.sku ?? ''} onChange={(v) => setScope({ sku: v || undefined })} placeholder="SKU, barcode or code" className="w-48" />
        <SearchInput value={state.q ?? ''} onChange={(v) => setScope({ q: v || undefined })} placeholder="Search product, brand, retailer" className="w-60" />
      </FilterBar>

      <DemoNotice demo={demo} className="mb-4" />
      <SummaryStrip query={summary} />
      <TimelineCard filters={filters} />
      <CompareCard filters={filters} />
      <ChangesCard filters={filters} />
      <ObservationsCard filters={filters} />
      <VolatilityCard filters={filters} />
    </Page>
  );
}
