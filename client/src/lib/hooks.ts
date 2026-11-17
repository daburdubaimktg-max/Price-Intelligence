/** Shared data hooks: reference lists, date presets, URL-synchronised filter state. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { apiGet, type Query } from './api.ts';
import { registerCurrencies } from './format.ts';
import type { ReferenceData } from '@shared/api/catalogue.ts';

export interface DateRange {
  from: string;
  to: string;
}

export interface DatesInfo {
  today: string;
  presets: Record<'today_vs_yesterday' | 'last_7_days' | 'last_30_days' | 'last_90_days', { a: DateRange; b: DateRange }>;
  reporting_currency: string;
  first_observation_date: string | null;
}

/** Markets, retailers, brands, categories and currencies for filter controls (cached for the session). */
export function useReference() {
  const query = useQuery({
    queryKey: ['reference'],
    queryFn: async () => {
      const data = await apiGet<ReferenceData>('/reference');
      registerCurrencies(data.currencies);
      return data;
    },
    staleTime: 5 * 60_000,
  });
  const data = query.data;
  const maps = useMemo(
    () => ({
      market: new Map((data?.markets ?? []).map((m) => [m.id, m])),
      retailer: new Map((data?.retailers ?? []).map((r) => [r.id, r])),
      brand: new Map((data?.brands ?? []).map((b) => [b.id, b])),
      category: new Map((data?.categories ?? []).map((c) => [c.id, c])),
    }),
    [data],
  );
  return { ...query, ref: data, maps };
}

/** The server's notion of "today" and the standard comparison presets. */
export function useDates() {
  return useQuery({ queryKey: ['analytics', 'dates'], queryFn: () => apiGet<DatesInfo>('/analytics/dates'), staleTime: 5 * 60_000 });
}

/**
 * GET query that keeps showing the previous result while new filters load
 * (charts and tables dim instead of flashing a skeleton).
 */
export function useApiQuery<T>(key: unknown[], path: string, query?: Query, options?: Partial<UseQueryOptions<T>>) {
  return useQuery<T>({
    queryKey: [...key, query ?? {}],
    queryFn: ({ signal }) => apiGet<T>(path, query, signal),
    placeholderData: keepPreviousData,
    ...options,
  });
}

type ParamValue = string | undefined;

/**
 * Filter state stored in the URL so views are shareable and survive reloads.
 * Values are strings; lists are comma-separated ("1,2,3"). Keys equal to their default are omitted.
 */
export function useUrlState<T extends Record<string, ParamValue>>(defaults: T) {
  const [params, setParams] = useSearchParams();
  const defaultsRef = useRef(defaults);
  const state = useMemo(() => {
    const out: Record<string, ParamValue> = { ...defaultsRef.current };
    for (const key of Object.keys(defaultsRef.current)) {
      const value = params.get(key);
      if (value !== null) out[key] = value;
    }
    return out as T;
  }, [params]);

  const set = useCallback(
    (patch: Partial<Record<keyof T, ParamValue | null>>, options: { replace?: boolean } = {}) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(patch)) {
            if (value === undefined || value === null || value === '' || value === defaultsRef.current[key]) next.delete(key);
            else next.set(key, String(value));
          }
          return next;
        },
        { replace: options.replace ?? true },
      );
    },
    [setParams],
  );

  const reset = useCallback(() => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const key of Object.keys(defaultsRef.current)) next.delete(key);
        return next;
      },
      { replace: true },
    );
  }, [setParams]);

  const activeCount = useMemo(
    () => Object.keys(defaultsRef.current).filter((key) => params.get(key) !== null && params.get(key) !== defaultsRef.current[key]).length,
    [params],
  );

  return { state, set, reset, activeCount };
}

export const toList = (value: string | undefined): string[] => (value ? value.split(',').filter(Boolean) : []);
export const fromList = (values: Array<string | number>): string | undefined => (values.length ? values.join(',') : undefined);

export function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

/** True below the given width (default: phone/tablet breakpoint). */
export function useIsNarrow(maxWidth = 767): boolean {
  const [narrow, setNarrow] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(`(max-width: ${maxWidth}px)`).matches : false));
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [maxWidth]);
  return narrow;
}

/** Calendar helpers on ISO dates (YYYY-MM-DD). */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function diffDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
