/**
 * Report parameters. The form lives in the URL (so a report can be bookmarked or shared); a request body is
 * derived from it and is exactly what both POST /reports/generate and GET /reports/export receive.
 */
import { useCallback, useMemo } from 'react';
import { presetRange, type DatePreset } from '@/components/ui/filters.tsx';
import { addDays, diffDays, toList, useDates, useUrlState, type DateRange } from '@/lib/hooks.ts';
import type { ReportDefinition, ReportParamKey, ReportRun, ReportType } from '@shared/api/reports.ts';

export const PERIOD_PRESETS: DatePreset[] = ['7d', '30d', '90d', 'mtd'];
const PRESET_BY_DAYS: Record<number, DatePreset> = { 7: '7d', 30: '30d', 90: '90d' };

/** Filters that travel as id lists / single values, keyed by the parameter that enables them. */
const PARAM_FIELDS = {
  market: 'market_id',
  retailer: 'retailer_id',
  brand: 'brand_id',
  category: 'category_id',
  product: 'product_id',
  currency: 'currency',
} as const satisfies Partial<Record<ReportParamKey, string>>;
export type ParamField = (typeof PARAM_FIELDS)[keyof typeof PARAM_FIELDS];

export type ReportUrlState = {
  type: string | undefined;
  /** A relative period (preset key). Mutually exclusive with from / to. */
  period: string | undefined;
  from: string | undefined;
  to: string | undefined;
  market_id: string | undefined;
  retailer_id: string | undefined;
  brand_id: string | undefined;
  category_id: string | undefined;
  product_id: string | undefined;
  currency: string | undefined;
  /** "1" once the report has been generated: opening the link generates it again. */
  run: string | undefined;
};

const URL_DEFAULTS: ReportUrlState = {
  type: undefined,
  period: undefined,
  from: undefined,
  to: undefined,
  market_id: undefined,
  retailer_id: undefined,
  brand_id: undefined,
  category_id: undefined,
  product_id: undefined,
  currency: undefined,
  run: undefined,
};

/** What is sent to the server. Every value is a string so the same object serves as a query string. */
export interface ReportRequest {
  type: ReportType;
  from: string;
  to: string;
  market_id?: string;
  retailer_id?: string;
  brand_id?: string;
  category_id?: string;
  product_id?: string;
  currency?: string;
}

export const requestKey = (request: ReportRequest | null): string => (request ? JSON.stringify(Object.entries(request).sort(([a], [b]) => a.localeCompare(b))) : '');

export function defaultPreset(def: ReportDefinition): DatePreset | null {
  return PRESET_BY_DAYS[def.default_days] ?? null;
}

function resolvePeriod(def: ReportDefinition, state: ReportUrlState, today: string): { range: DateRange; preset: DatePreset | null } {
  if (state.from || state.to) {
    const to = state.to ?? today;
    const from = state.from ?? addDays(to, -(def.default_days - 1));
    return { range: { from, to }, preset: null };
  }
  const requested = PERIOD_PRESETS.find((p) => p === state.period) ?? null;
  const preset = requested ?? defaultPreset(def);
  if (preset) {
    const r = presetRange(preset, today);
    return { range: { from: r.from ?? today, to: r.to ?? today }, preset };
  }
  return { range: { from: addDays(today, -(def.default_days - 1)), to: today }, preset: null };
}

export interface ReportForm {
  /** False until the report types and the server's "today" have loaded. */
  ready: boolean;
  definition: ReportDefinition | null;
  state: ReportUrlState;
  today: string | null;
  firstDate: string | null;
  reportingCurrency: string;
  range: DateRange | null;
  days: number | null;
  /** Required filters that have not been chosen yet. */
  missing: ReportParamKey[];
  /** The request for the current form, or null while it is incomplete. */
  request: ReportRequest | null;
  /** True when the link asks for the report to be generated on opening. */
  autoRun: boolean;
  setType: (type: ReportType) => void;
  setPeriod: (next: Partial<DateRange>) => void;
  /** Sets one or more filters in a single URL update. */
  setParams: (patch: Partial<Record<ParamField, string | undefined>>) => void;
  markRun: () => void;
  loadRun: (run: ReportRun) => ReportRequest;
}

export function useReportForm(definitions: ReportDefinition[] | undefined): ReportForm {
  const { state, set } = useUrlState<ReportUrlState>(URL_DEFAULTS);
  const dates = useDates();
  const today = dates.data?.today ?? null;
  const reportingCurrency = dates.data?.reporting_currency ?? '';
  const definition = useMemo(() => definitions?.find((d) => d.type === state.type) ?? definitions?.[0] ?? null, [definitions, state.type]);

  const resolved = useMemo(() => (definition && today ? resolvePeriod(definition, state, today) : null), [definition, state, today]);

  const missing = useMemo<ReportParamKey[]>(() => {
    if (!definition) return [];
    return definition.required.filter((key) => {
      const field = PARAM_FIELDS[key as keyof typeof PARAM_FIELDS];
      return field ? !state[field] : false;
    });
  }, [definition, state]);

  const request = useMemo<ReportRequest | null>(() => {
    if (!definition || !resolved || missing.length) return null;
    const out: ReportRequest = { type: definition.type, from: resolved.range.from, to: resolved.range.to };
    // only the filters this report understands are ever sent
    for (const key of definition.params) {
      const field = PARAM_FIELDS[key as keyof typeof PARAM_FIELDS];
      const value = field ? state[field] : undefined;
      if (field && value) out[field] = value;
    }
    return out;
  }, [definition, resolved, missing, state]);

  const setType = useCallback(
    (type: ReportType) => {
      const next = definitions?.find((d) => d.type === type);
      if (!next) return;
      const patch: Partial<Record<keyof ReportUrlState, string | null>> = { type, run: null };
      // filters the new report does not understand must not linger invisibly in the link
      for (const [key, field] of Object.entries(PARAM_FIELDS) as Array<[ReportParamKey, ParamField]>) {
        if (!next.params.includes(key)) patch[field] = null;
      }
      // a report about one brand keeps only the first of several selected brands
      if (next.required.includes('brand') && state.brand_id) patch.brand_id = toList(state.brand_id)[0] ?? null;
      set(patch, { replace: false });
    },
    [definitions, set, state.brand_id],
  );

  const setPeriod = useCallback(
    (next: Partial<DateRange>) => {
      if (!definition || !today) return;
      const preset = PERIOD_PRESETS.find((p) => {
        const r = presetRange(p, today);
        return r.from === next.from && r.to === next.to;
      });
      if (preset) set({ period: preset === defaultPreset(definition) ? null : preset, from: null, to: null, run: null });
      else set({ period: null, from: next.from ?? null, to: next.to ?? null, run: null });
    },
    [definition, today, set],
  );

  const setParams = useCallback(
    (patch: Partial<Record<ParamField, string | undefined>>) => {
      const next: Partial<Record<keyof ReportUrlState, string | null>> = { run: null };
      for (const [field, value] of Object.entries(patch) as Array<[ParamField, string | undefined]>) next[field] = value ?? null;
      set(next);
    },
    [set],
  );
  const markRun = useCallback(() => set({ run: '1' }), [set]);

  const loadRun = useCallback(
    (run: ReportRun): ReportRequest => {
      const p = run.params;
      const currency = p.currency && p.currency !== reportingCurrency ? p.currency : undefined;
      set(
        {
          type: run.type,
          period: null,
          from: p.from ?? null,
          to: p.to ?? null,
          market_id: p.market_id ?? null,
          retailer_id: p.retailer_id ?? null,
          brand_id: p.brand_id ?? null,
          category_id: p.category_id ?? null,
          product_id: p.product_id ?? null,
          currency: currency ?? null,
          run: '1',
        },
        { replace: false },
      );
      const out: ReportRequest = { type: run.type, from: p.from ?? '', to: p.to ?? '' };
      for (const field of Object.values(PARAM_FIELDS)) {
        const value = field === 'currency' ? currency : p[field];
        if (value) out[field] = value;
      }
      return out;
    },
    [set, reportingCurrency],
  );

  return {
    ready: !!definition && !!today,
    definition,
    state,
    today,
    firstDate: dates.data?.first_observation_date ?? null,
    reportingCurrency,
    range: resolved?.range ?? null,
    days: resolved ? diffDays(resolved.range.from, resolved.range.to) + 1 : null,
    missing,
    request,
    autoRun: state.run === '1',
    setType,
    setPeriod,
    setParams,
    markRun,
    loadRun,
  };
}

export const PARAM_LABELS: Record<ReportParamKey, string> = {
  period: 'Period',
  market: 'Market',
  retailer: 'Retailer',
  brand: 'Brand',
  product: 'Product',
  category: 'Category',
  currency: 'Currency',
};
