/** Parameter form of the selected report: only the filters that report understands, required ones marked. */
import { useMemo, type ReactNode } from 'react';
import { FileText } from 'lucide-react';
import { fmtDate } from '@/lib/format.ts';
import { fromList, toList, useReference } from '@/lib/hooks.ts';
import { Button, Card, CardHeader, Select } from '@/components/ui/primitives.tsx';
import { DateRangePicker, MultiSelect, ProductPicker, type Option } from '@/components/ui/filters.tsx';
import type { ReportParamKey } from '@shared/api/reports.ts';
import { PARAM_LABELS, PERIOD_PRESETS, type ReportForm } from './params.ts';

function Required({ children, missing }: { children: ReactNode; missing: boolean }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      {children}
      <span className={missing ? 'text-[13px] font-semibold text-crit-ink' : 'text-[13px] text-ink-4'} title="Required for this report">
        <span aria-hidden>*</span>
        <span className="sr-only">required</span>
      </span>
    </span>
  );
}

export function ReportParams({
  form,
  canGenerate,
  generating,
  onGenerate,
}: {
  form: ReportForm;
  canGenerate: boolean;
  generating: boolean;
  onGenerate: () => void;
}) {
  const { definition: def, state } = form;
  const { ref } = useReference();

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

  if (!def) return null;
  const isMissing = (key: ReportParamKey) => form.missing.includes(key);
  const mark = (key: ReportParamKey, control: ReactNode) =>
    def.required.includes(key) ? (
      <Required key={key} missing={isMissing(key)}>
        {control}
      </Required>
    ) : (
      control
    );

  const controls: Record<ReportParamKey, () => ReactNode> = {
    period: () =>
      form.today ? (
        <DateRangePicker key="period" label="Period" value={form.range ?? {}} today={form.today} presets={PERIOD_PRESETS} min={form.firstDate} onChange={form.setPeriod} />
      ) : null,
    market: () => (
      <MultiSelect
        key="market"
        label="Market"
        options={options.markets}
        value={toList(state.market_id)}
        onChange={(v) => {
          // retailers outside the chosen markets would silently empty the report, so they are dropped with the market
          const allowed = new Set((ref?.retailers ?? []).filter((r) => v.length === 0 || v.includes(String(r.market_id))).map((r) => String(r.id)));
          const kept = toList(state.retailer_id).filter((id) => allowed.has(id));
          form.setParams({ market_id: fromList(v), retailer_id: fromList(kept) });
        }}
      />
    ),
    retailer: () => <MultiSelect key="retailer" label="Retailer" options={options.retailers} value={toList(state.retailer_id)} onChange={(v) => form.setParams({ retailer_id: fromList(v) })} searchable />,
    brand: () => (
      <MultiSelect
        key="brand"
        label="Brand"
        options={options.brands}
        value={toList(state.brand_id)}
        onChange={(v) => form.setParams({ brand_id: fromList(v) })}
        single={def.required.includes('brand')}
        searchable
      />
    ),
    product: () => <ProductPicker key="product" value={toList(state.product_id)} multiple={false} onChange={(v) => form.setParams({ product_id: fromList(v) })} />,
    category: () => <MultiSelect key="category" label="Category" options={options.categories} value={toList(state.category_id)} onChange={(v) => form.setParams({ category_id: fromList(v) })} />,
    currency: () => (
      <label key="currency" className="inline-flex max-w-full items-center gap-1.5 text-[13px] text-ink-3">
        <span className="shrink-0">Convert to</span>
        <span className="inline-block w-56 max-w-full">
          <Select value={state.currency ?? 'reporting'} onChange={(e) => form.setParams({ currency: e.target.value === 'reporting' ? undefined : e.target.value })} aria-label="Currency for converted figures">
            <option value="reporting">{form.reportingCurrency ? `${form.reportingCurrency} — reporting currency` : 'Reporting currency'}</option>
            {(ref?.currencies ?? [])
              .filter((c) => c.code !== form.reportingCurrency)
              .map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.name}
                </option>
              ))}
          </Select>
        </span>
      </label>
    ),
  };

  const missingText = form.missing.length ? `Choose a ${form.missing.map((k) => PARAM_LABELS[k].toLowerCase()).join(' and a ')} to generate this report.` : null;

  return (
    <Card>
      <CardHeader title={def.title} subtitle={def.description} />
      <div className="flex flex-wrap items-center gap-2 px-4 py-3" role="group" aria-label="Report parameters">
        {def.params.map((key) => mark(key, controls[key]()))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-b-[10px] border-t border-line bg-sunken px-4 py-2.5">
        <p className="min-w-0 text-[12.5px] leading-5 text-ink-3">
          {missingText ? (
            <span className="font-medium text-warn-ink">{missingText}</span>
          ) : !canGenerate ? (
            'Your role cannot generate reports. Ask an administrator for access.'
          ) : form.range ? (
            <>
              Covers <span className="num font-medium text-ink-2">{fmtDate(form.range.from)} – {fmtDate(form.range.to)}</span>
              <span className="num"> · {form.days} {form.days === 1 ? 'day' : 'days'}</span>. Leave a filter empty to include everything.
            </>
          ) : (
            'Loading…'
          )}
        </p>
        {canGenerate ? (
          <Button variant="primary" icon={FileText} loading={generating} disabled={!form.request} onClick={onGenerate}>
            Generate report
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
