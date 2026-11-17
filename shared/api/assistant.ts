/** API types of the intelligence assistant (natural-language questions answered from stored records). */
import type { DemoNote } from './analytics.ts';

export type AssistantIntent =
  | 'price_history'
  | 'current_prices'
  | 'lowest_price'
  | 'price_changes'
  | 'discount_ranking'
  | 'promotion_frequency'
  | 'positioning'
  | 'volatility'
  | 'cross_market'
  | 'unsupported';

export type PeriodPreset =
  | 'today' | 'yesterday' | 'last_7_days' | 'last_30_days' | 'last_90_days' | 'this_week' | 'this_month' | 'last_month' | 'custom' | 'default';

/** The structured interpretation of a question. Both engines produce exactly this; one executor runs it. */
export interface QueryPlan {
  intent: AssistantIntent;
  products: string[];
  brands: string[];
  retailers: string[];
  markets: string[];
  categories: string[];
  ownership: 'own' | 'competitor' | 'any';
  period: { preset: PeriodPreset; from: string | null; to: string | null };
  direction: 'up' | 'down' | 'any';
  limit: number | null;
  /** For `unsupported`: what the question asks for that stored records cannot answer. */
  reason: string | null;
}

export interface AssistantTable {
  title: string;
  columns: Array<{ key: string; label: string; align?: 'left' | 'right' }>;
  rows: Array<Record<string, string | number | null>>;
  note?: string | null;
}

export interface AssistantChart {
  title: string;
  subtitle: string | null;
  /** How values are formatted: a currency code, 'index' or '%'. */
  unit: string;
  series: Array<{ key: string; label: string; sublabel?: string | null; points: Array<{ date: string; value: number }> }>;
}

export interface AssistantEvidence {
  /** Stored observations the answer was computed from. */
  observations: number;
  first_observed_at: string | null;
  last_observed_at: string | null;
  retailers: string[];
  markets: string[];
  /** Observation counts by how the data entered the system. */
  sources: Array<{ data_class: string; observations: number }>;
  /** Up to 25 of the underlying observation ids (open them in the Historical Price Explorer). */
  observation_ids: number[];
  /** Deep links into the product that show the same records. */
  links: Array<{ label: string; href: string }>;
}

export interface AssistantAnswer {
  id: number | null;
  question: string;
  asked_at: string;
  /** Which engine interpreted the question. */
  engine: 'builtin' | 'claude';
  engine_label: string;
  model: string | null;
  /** Set when Claude was selected but the built-in engine answered instead (with the real reason). */
  fallback_reason: string | null;
  status: 'answered' | 'no_data' | 'needs_clarification' | 'unsupported';
  interpretation: { intent: AssistantIntent; summary: string; plan: QueryPlan; unresolved: string[] };
  /** Plain-text answer; paragraphs separated by blank lines. Every figure comes from stored records. */
  answer: string;
  highlights: Array<{ label: string; value: string; detail?: string | null }>;
  tables: AssistantTable[];
  chart: AssistantChart | null;
  evidence: AssistantEvidence | null;
  notes: string[];
  demo: DemoNote | null;
}

export interface AssistantStatus {
  /** Engine that will interpret the next question. */
  engine: 'builtin' | 'claude';
  engine_label: string;
  provider_setting: 'builtin' | 'anthropic';
  model: string | null;
  api_key_configured: boolean;
  explanation: string;
  example_questions: string[];
}

export interface AssistantHistoryItem {
  id: number;
  question: string;
  engine: string;
  status: string;
  answer: string;
  created_at: string;
}
