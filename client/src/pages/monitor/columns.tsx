/**
 * Columns of the live price monitor. The set adapts to the available width so the product name always
 * stays readable: narrow screens fold secondary facts into the product and price cells instead of
 * pushing them off-screen.
 */
import { useMemo } from 'react';
import type { MonitorRow } from '@shared/api/analytics.ts';
import {
  AvailabilityBadge, ChangeCell, DataClassBadge, DemoBadge, FreshnessCell, MarketTime, packText, PriceCell, ProductCell, PromoBadge, UnitPriceCell,
} from '@/components/domain/domain.tsx';
import type { Column } from '@/components/ui/data-table.tsx';
import { Badge } from '@/components/ui/primitives.tsx';
import { DASH, fmtPrice, fmtRelative } from '@/lib/format.ts';
import { useIsNarrow } from '@/lib/hooks.ts';

function productName(r: MonitorRow): string {
  return r.product_name ?? r.listing_title ?? r.listing_code;
}

/** Availability is only worth a line when the product is not simply in stock. */
function notInStock(r: MonitorRow): boolean {
  return r.availability === 'out_of_stock' || r.availability === 'limited';
}

function LastChange({ row }: { row: MonitorRow }) {
  if (row.changed_at === null || row.change_new_price === null) {
    return <span className="text-[12px] text-ink-4">{row.observation_id ? 'No change recorded' : DASH}</span>;
  }
  return (
    <span className="block">
      <span className="flex items-center gap-2 whitespace-nowrap">
        <span className="num">
          <span className="text-ink-3">{fmtPrice(row.change_old_price, row.currency_code)}</span>
          <span className="px-1 text-ink-4" aria-hidden>
            →
          </span>
          <span className="sr-only">to</span>
          <span className="text-ink">{fmtPrice(row.change_new_price, row.currency_code)}</span>
        </span>
        <ChangeCell pct={row.change_pct} />
      </span>
      <span className="block text-[11.5px] leading-4">
        <MarketTime iso={row.changed_at} timeZone={row.timezone} relative />
      </span>
    </span>
  );
}

/**
 * @param priceSortable false when the rows span several currencies: ordering raw prices in different
 *   currencies would be a meaningless comparison, so price sorting is only offered within one currency.
 */
export function useMonitorColumns(priceSortable: boolean): Array<Column<MonitorRow>> {
  // Width bands (viewport px). Each step adds a column only once the product name keeps ~280 px.
  const phone = useIsNarrow(639);
  const compact = useIsNarrow(1279);
  const showRetailer = !useIsNarrow(1385);
  const showUnitPrice = !useIsNarrow(1495);
  const showAvailability = !useIsNarrow(1595);
  /** Retailer and market are folded into the product cell when they have no column of their own. */
  const retailerInProduct = !showRetailer;

  return useMemo(() => {
    const product: Column<MonitorRow> = {
      key: 'product',
      header: retailerInProduct ? 'Product · retailer' : 'Product',
      sortKey: 'product',
      // takes the remaining width and truncates rather than widening the table
      className: 'w-full max-w-0',
      cell: (r) => {
        const unmatched = r.product_id === null;
        // From 1280 px the Source column carries the demo marker for simulated rows.
        const demoHere = !!r.is_demo && (compact || r.data_class !== 'simulated');
        return (
          <span className="block min-w-0">
            <ProductCell
              name={productName(r)}
              brand={retailerInProduct ? `${r.retailer_name} · ${r.market_name}` : unmatched ? 'Not matched to a product yet' : r.brand_name}
              pack={r.pack_size ? packText(r) : null}
              variant={r.variant_name}
              ownership={r.ownership}
              isDemo={demoHere && !phone}
              compact
            />
            {unmatched && retailerInProduct ? (
              <span className="mt-0.5 block pl-4">
                <Badge tone="outline">Unmatched</Badge>
              </span>
            ) : null}
            {phone ? (
              <span className="mt-0.5 flex flex-wrap items-center gap-1.5 pl-4 text-[11.5px] leading-4">
                <FreshnessCell iso={r.observed_at} stale={r.is_stale} timeZone={r.timezone} />
                {r.is_demo ? <DemoBadge /> : null}
              </span>
            ) : null}
          </span>
        );
      },
    };

    const retailer: Column<MonitorRow> = {
      key: 'retailer',
      header: 'Retailer',
      sortKey: 'retailer',
      cell: (r) => (
        <span className="block max-w-44 min-w-0">
          <span className="block truncate text-ink">{r.retailer_name}</span>
          <span className="block truncate text-[11.5px] leading-4 text-ink-3">{r.market_name}</span>
        </span>
      ),
    };

    const price: Column<MonitorRow> = {
      key: 'price',
      header: 'Price',
      align: 'right',
      sortKey: priceSortable ? 'price' : undefined,
      headerTitle: priceSortable ? undefined : 'Prices are in different currencies. Filter to markets with one currency to sort by price.',
      cell: (r) => (
        <span className="block">
          <PriceCell price={r.current_price} regular={r.regular_price} currency={r.currency_code} isPromo={r.is_promo} />
          {/* folded-in facts for layouts without their own columns */}
          {!showUnitPrice && !phone && r.unit_price !== null ? (
            <span className="block text-[11.5px] leading-4">
              <UnitPriceCell value={r.unit_price} currency={r.currency_code} dimension={r.content_dimension} />
            </span>
          ) : null}
          {compact && r.promo_type ? (
            <span className="mt-0.5 flex justify-end">
              <PromoBadge type={r.promo_type} discount={r.discount_pct} description={r.promo_description} />
            </span>
          ) : null}
          {!showAvailability && notInStock(r) ? (
            <span className="mt-0.5 flex justify-end">
              <AvailabilityBadge value={r.availability} />
            </span>
          ) : null}
          {phone && r.changed_at ? (
            <span className="mt-0.5 flex items-center justify-end gap-1 text-[11.5px] leading-4 text-ink-3">
              <ChangeCell pct={r.change_pct} />
              <span className="whitespace-nowrap">{fmtRelative(r.changed_at)}</span>
            </span>
          ) : null}
        </span>
      ),
    };

    const unit: Column<MonitorRow> = {
      key: 'unit',
      header: 'Unit price',
      align: 'right',
      sortKey: priceSortable ? 'unit_price' : undefined,
      headerTitle: priceSortable
        ? 'Price per 100 ml, per 100 g or per unit, from the pack actually sold'
        : 'Price per 100 ml, per 100 g or per unit. Filter to markets with one currency to sort by it.',
      cell: (r) => <UnitPriceCell value={r.unit_price} currency={r.currency_code} dimension={r.content_dimension} />,
    };

    const offer: Column<MonitorRow> = {
      key: 'offer',
      header: 'Offer',
      sortKey: 'discount',
      cell: (r) => (r.promo_type ? <PromoBadge type={r.promo_type} discount={r.discount_pct} description={r.promo_description} /> : <span className="text-ink-4">{DASH}</span>),
    };

    const change: Column<MonitorRow> = {
      key: 'change',
      header: 'Last price change',
      sortKey: 'changed_at',
      headerTitle: 'Most recent change of the selling price (previous → new). Sort to see the latest changes first.',
      cell: (r) => <LastChange row={r} />,
    };

    const availability: Column<MonitorRow> = {
      key: 'availability',
      header: 'Availability',
      nowrap: true,
      cell: (r) => <AvailabilityBadge value={r.availability} />,
    };

    const observed: Column<MonitorRow> = {
      key: 'observed',
      header: 'Last observed',
      sortKey: 'observed_at',
      nowrap: true,
      cell: (r) => <FreshnessCell iso={r.observed_at} stale={r.is_stale} timeZone={r.timezone} />,
    };

    const source: Column<MonitorRow> = {
      key: 'source',
      header: 'Source',
      nowrap: true,
      cell: (r) =>
        r.data_class ? (
          <span className="inline-flex items-center gap-1">
            <DataClassBadge value={r.data_class} short />
            {r.is_demo && r.data_class !== 'simulated' ? <DemoBadge /> : null}
          </span>
        ) : (
          <span className="text-ink-4">{DASH}</span>
        ),
    };

    if (phone) return [product, price];
    if (compact) return [product, price, change, observed];
    return [
      product,
      ...(showRetailer ? [retailer] : []),
      price,
      ...(showUnitPrice ? [unit] : []),
      offer,
      change,
      ...(showAvailability ? [availability] : []),
      observed,
      source,
    ];
  }, [phone, compact, showRetailer, retailerInProduct, showUnitPrice, showAvailability, priceSortable]);
}
