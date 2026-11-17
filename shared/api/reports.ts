/** API types of the reporting section. Types only. */
import type { Conversion, DateRange, DemoNote } from './analytics.ts';

export type ReportType =
  | 'weekly_competitor_pricing'
  | 'monthly_market_pricing'
  | 'brand_report'
  | 'product_report'
  | 'promotion_analysis'
  | 'competitor_price_movement';

export type ReportParamKey = 'period' | 'market' | 'retailer' | 'brand' | 'product' | 'category' | 'currency';

export interface ReportDefinition {
  type: ReportType;
  title: string;
  description: string;
  /** Default length of the reporting period in days. */
  default_days: number;
  /** Filters this report understands, in display order. */
  params: ReportParamKey[];
  /** Filters that must be supplied before the report can be generated. */
  required: ReportParamKey[];
}

export type ReportColumnType = 'text' | 'integer' | 'number' | 'money' | 'percent' | 'signed_percent' | 'date' | 'datetime' | 'index';

export interface ReportColumn {
  key: string;
  label: string;
  type: ReportColumnType;
  /** For money columns: the row field that holds the currency code. */
  currency_key?: string;
}

export interface ReportTable {
  columns: ReportColumn[];
  rows: Array<Record<string, string | number | null>>;
  /** Shown under the table (e.g. "showing the 50 largest of 212"). */
  note?: string | null;
}

export type ReportChart =
  | {
      kind: 'line';
      /** A currency code, 'index' or '%'. */
      unit: string;
      reference?: { value: number; label: string } | null;
      series: Array<{ key: string; label: string; sublabel?: string | null; role?: 'own' | 'competitor' | null; points: Array<{ date: string; value: number }> }>;
    }
  | { kind: 'diverging'; positive_label: string; negative_label: string; data: Array<{ date: string; positive: number; negative: number }> }
  | { kind: 'bars'; unit: string; data: Array<{ key: string; label: string; sublabel?: string | null; value: number }> };

export interface ReportSection {
  id: string;
  title: string;
  description?: string | null;
  chart?: ReportChart | null;
  table?: ReportTable | null;
  notes?: string[];
}

export interface ReportResult {
  type: ReportType;
  title: string;
  subtitle: string;
  generated_at: string;
  generated_by: string | null;
  organisation: string;
  period: DateRange;
  /** Human-readable description of the filters applied. */
  scope: string[];
  summary: Array<{ label: string; value: string; detail?: string | null }>;
  sections: ReportSection[];
  notes: string[];
  conversions: Conversion[];
  demo: DemoNote;
  run_id: number | null;
}

export interface ReportRun {
  id: number;
  type: ReportType;
  title: string;
  params: Record<string, string>;
  row_count: number;
  generated_by: string | null;
  generated_at: string;
}
