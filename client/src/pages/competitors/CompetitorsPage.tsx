/**
 * Competitor Intelligence. Without a product: positioning of all own products against their mapped
 * competitors. With `?product_id=`: one own product compared with its mapped competitor products.
 */
import { useMemo } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Page } from '@/app/AppShell.tsx';
import { fromList, toList, useDates, useReference, useUrlState } from '@/lib/hooks.ts';
import { Button, Checkbox, PageHeader, Segmented } from '@/components/ui/primitives.tsx';
import { FilterBar, MultiSelect, ProductPicker, type Option } from '@/components/ui/filters.tsx';
import { deriveCurrencyMode } from '../history/filters.ts';
import { CurrencySelect } from '../history/parts.tsx';
import { CompareView } from './CompareView.tsx';
import { OverviewView } from './OverviewView.tsx';

const DEFAULTS = {
  product_id: undefined as string | undefined,
  market_id: undefined as string | undefined,
  retailer_id: undefined as string | undefined,
  brand_id: undefined as string | undefined,
  category_id: undefined as string | undefined,
  days: '30' as string | undefined,
  /** 'native', 'reporting' or an ISO code. Absent = derived from the scope (native for a single currency). */
  currency: undefined as string | undefined,
  include_suggested: undefined as string | undefined,
};

export default function CompetitorsPage() {
  const { state, set } = useUrlState(DEFAULTS);
  const { ref } = useReference();
  const dates = useDates();
  const reportingCurrency = dates.data?.reporting_currency ?? 'USD';
  const productId = state.product_id && /^\d+$/.test(state.product_id) ? state.product_id : undefined;

  const selectedMarkets = useMemo(() => new Set(toList(state.market_id)), [state.market_id]);
  const options = useMemo(() => {
    const marketName = new Map((ref?.markets ?? []).map((m) => [m.id, m.name]));
    const markets: Option[] = (ref?.markets ?? []).filter((m) => m.is_active).map((m) => ({ value: String(m.id), label: m.name, sublabel: `${m.country_name} · ${m.currency_code}` }));
    const retailers: Option[] = (ref?.retailers ?? [])
      .filter((r) => r.is_active && (selectedMarkets.size === 0 || selectedMarkets.has(String(r.market_id))))
      .map((r) => ({ value: String(r.id), label: r.name, group: marketName.get(r.market_id) ?? 'Other' }));
    const brands: Option[] = (ref?.brands ?? []).filter((b) => b.ownership === 'own').map((b) => ({ value: String(b.id), label: b.name }));
    const byId = new Map((ref?.categories ?? []).map((c) => [c.id, c]));
    const categories: Option[] = [
      ...(ref?.categories ?? []).filter((c) => c.parent_id === null).map((c) => ({ value: String(c.id), label: c.name, group: 'Categories' })),
      ...(ref?.categories ?? []).filter((c) => c.parent_id !== null).map((c) => ({ value: String(c.id), label: c.name, group: byId.get(c.parent_id!)?.name ?? 'Subcategories' })),
    ];
    return { markets, retailers, brands, categories };
  }, [ref, selectedMarkets]);

  const days = ['30', '90', '180'].includes(state.days ?? '') ? state.days! : '30';
  const currency = state.currency ?? deriveCurrencyMode(ref, state.market_id, state.retailer_id);
  const includeSuggested = state.include_suggested === 'true';
  const activeCount = productId
    ? [state.market_id, state.retailer_id, state.include_suggested, state.currency].filter(Boolean).length + (days !== '30' ? 1 : 0)
    : [state.market_id, state.brand_id, state.category_id].filter(Boolean).length;

  const backToOverview = () => set({ product_id: undefined, retailer_id: undefined, include_suggested: undefined }, { replace: false });

  return (
    <Page>
      <PageHeader
        title="Competitor Intelligence"
        description={
          productId
            ? 'One own product against its mapped competitor products: price, pack, unit price, gap, and the lowest, highest and average prices observed.'
            : 'How own-brand products are priced against the competitor products they are mapped to. Only approved, like-for-like mappings are compared; anything else is labelled.'
        }
        actions={
          productId ? (
            <Button icon={ArrowLeft} onClick={backToOverview}>
              All own products
            </Button>
          ) : undefined
        }
      />

      {productId ? (
        <>
          <FilterBar
            activeCount={activeCount}
            onReset={() => set({ market_id: undefined, retailer_id: undefined, days: undefined, currency: undefined, include_suggested: undefined })}
            trailing={<CurrencySelect label="Compare in" value={currency} reportingCurrency={reportingCurrency} onChange={(v) => set({ currency: v })} />}
          >
            <Segmented
              label="Period"
              value={days}
              onChange={(v) => set({ days: v })}
              options={[
                { value: '30', label: '30 days' },
                { value: '90', label: '90 days' },
                { value: '180', label: '180 days' },
              ]}
            />
            <ProductPicker label="Own product" ownership="own" multiple={false} value={[productId]} onChange={(v) => (v[0] ? set({ product_id: v[0] }, { replace: false }) : backToOverview())} />
            <MultiSelect label="Market" options={options.markets} value={toList(state.market_id)} onChange={(v) => set({ market_id: fromList(v), retailer_id: undefined })} />
            <MultiSelect label="Retailer" options={options.retailers} value={toList(state.retailer_id)} onChange={(v) => set({ retailer_id: fromList(v) })} searchable />
            <Checkbox label="Include suggested mappings" checked={includeSuggested} onChange={(e) => set({ include_suggested: e.target.checked ? 'true' : undefined })} className="px-1" />
          </FilterBar>
          <CompareView
            query={{ product_id: productId, market_id: state.market_id, retailer_id: state.retailer_id, days, currency, include_suggested: includeSuggested ? 'true' : undefined }}
            ready={!!ref}
            onBack={backToOverview}
          />
        </>
      ) : (
        <>
          <FilterBar activeCount={activeCount} onReset={() => set({ market_id: undefined, brand_id: undefined, category_id: undefined })}>
            <MultiSelect label="Market" options={options.markets} value={toList(state.market_id)} onChange={(v) => set({ market_id: fromList(v) })} />
            <MultiSelect label="Own brand" options={options.brands} value={toList(state.brand_id)} onChange={(v) => set({ brand_id: fromList(v) })} />
            <MultiSelect label="Category" options={options.categories} value={toList(state.category_id)} onChange={(v) => set({ category_id: fromList(v) })} />
          </FilterBar>
          <OverviewView query={{ market_id: state.market_id, brand_id: state.brand_id, category_id: state.category_id }} onSelect={(id) => set({ product_id: String(id) }, { replace: false })} />
        </>
      )}
    </Page>
  );
}
