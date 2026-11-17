/** Constants and small pure helpers shared by the server and the web client. */

export const COLLECTION_METHODS = [
  'official_api',
  'product_feed',
  'web_extraction',
  'third_party',
  'csv_import',
  'manual',
  'simulated',
] as const;
export type CollectionMethod = (typeof COLLECTION_METHODS)[number];

export const COLLECTION_METHOD_LABELS: Record<CollectionMethod, string> = {
  official_api: 'Official API',
  product_feed: 'Product feed',
  web_extraction: 'Permitted website extraction',
  third_party: 'Third-party data integration',
  csv_import: 'Manual CSV import',
  manual: 'Manual price entry',
  simulated: 'Simulated demo source',
};

/** Methods the scheduler can run automatically (the others are driven by people). */
export const AUTOMATED_METHODS: CollectionMethod[] = [
  'official_api',
  'product_feed',
  'web_extraction',
  'third_party',
  'simulated',
];

export const FREQUENCIES = ['6h', '12h', 'daily', 'weekly', 'manual'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export const FREQUENCY_LABELS: Record<Frequency, string> = {
  '6h': 'Every 6 hours',
  '12h': 'Every 12 hours',
  daily: 'Daily',
  weekly: 'Weekly',
  manual: 'Manual collection',
};

export const FREQUENCY_HOURS: Record<Frequency, number | null> = {
  '6h': 6,
  '12h': 12,
  daily: 24,
  weekly: 168,
  manual: null,
};

/** How an observation entered the system. Derived from the source method; never mixed up in the UI. */
export const DATA_CLASSES = ['collected', 'imported', 'manual', 'simulated'] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

export const DATA_CLASS_LABELS: Record<DataClass, string> = {
  collected: 'Collected (real)',
  imported: 'Imported history',
  manual: 'Manual entry',
  simulated: 'Simulated demo',
};

export function dataClassOf(method: CollectionMethod): DataClass {
  if (method === 'csv_import') return 'imported';
  if (method === 'manual') return 'manual';
  if (method === 'simulated') return 'simulated';
  return 'collected';
}

export const AVAILABILITY = ['in_stock', 'limited', 'out_of_stock', 'unknown'] as const;
export type Availability = (typeof AVAILABILITY)[number];
export const AVAILABILITY_LABELS: Record<Availability, string> = {
  in_stock: 'In stock',
  limited: 'Limited stock',
  out_of_stock: 'Out of stock',
  unknown: 'Unknown',
};

export const PROMO_TYPES = ['price_cut', 'multi_buy', 'bundle', 'coupon', 'other'] as const;
export type PromoType = (typeof PROMO_TYPES)[number];
export const PROMO_TYPE_LABELS: Record<PromoType, string> = {
  price_cut: 'Price cut',
  multi_buy: 'Multi-buy',
  bundle: 'Bundle',
  coupon: 'Coupon',
  other: 'Other offer',
};

export const PACK_UNITS = ['ml', 'l', 'g', 'kg', 'unit'] as const;
export type PackUnit = (typeof PACK_UNITS)[number];
export type ContentDimension = 'volume' | 'mass' | 'count';

export const OWNERSHIP = ['own', 'competitor'] as const;
export type Ownership = (typeof OWNERSHIP)[number];

export const ROLE_KEYS = ['admin', 'analyst', 'viewer'] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export const PERMISSIONS = {
  'catalogue.write': ['admin', 'analyst'],
  'observations.write': ['admin', 'analyst'],
  'observations.void': ['admin'],
  'collection.run': ['admin', 'analyst'],
  'sources.manage': ['admin'],
  'alerts.manage': ['admin', 'analyst'],
  'reports.generate': ['admin', 'analyst', 'viewer'],
  'database.export': ['admin', 'analyst'],
  'assistant.use': ['admin', 'analyst', 'viewer'],
  'admin.users': ['admin'],
  'admin.settings': ['admin'],
  'admin.integrations': ['admin'],
  'admin.demo': ['admin'],
  'admin.audit': ['admin'],
} as const satisfies Record<string, readonly RoleKey[]>;
export type Permission = keyof typeof PERMISSIONS;

export function roleCan(role: RoleKey | undefined | null, permission: Permission): boolean {
  if (!role) return false;
  return (PERMISSIONS[permission] as readonly RoleKey[]).includes(role);
}

export const ALERT_TYPES = [
  'competitor_price_drop',
  'own_more_expensive',
  'competitor_promotion',
  'product_unavailable',
  'price_change',
  'price_increase',
  'collection_failed',
  'stale_observation',
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export const ALERT_TYPE_INFO: Record<AlertType, { label: string; description: string; threshold: 'pct' | 'count' | 'hours' | 'none'; thresholdLabel?: string; defaultThreshold?: number }> = {
  competitor_price_drop: {
    label: 'Competitor price drop',
    description: 'A competitor product lowers its selling price by at least the threshold.',
    threshold: 'pct',
    thresholdLabel: 'Minimum decrease (%)',
    defaultThreshold: 10,
  },
  own_more_expensive: {
    label: 'Own brand more expensive than competitor',
    description: 'An own product is priced above a mapped competitor at the same retailer by at least the threshold (unit price for non-identical packs).',
    threshold: 'pct',
    thresholdLabel: 'Minimum price premium (%)',
    defaultThreshold: 0,
  },
  competitor_promotion: {
    label: 'Competitor promotion launched',
    description: 'A competitor listing starts a promotion with a discount of at least the threshold.',
    threshold: 'pct',
    thresholdLabel: 'Minimum discount (%)',
    defaultThreshold: 15,
  },
  product_unavailable: {
    label: 'Product becomes unavailable',
    description: 'A listing moves from available to out of stock.',
    threshold: 'none',
  },
  price_change: {
    label: 'Retailer changes selling price',
    description: 'Any change in the selling price of a listing of at least the threshold, in either direction.',
    threshold: 'pct',
    thresholdLabel: 'Minimum change (%)',
    defaultThreshold: 1,
  },
  price_increase: {
    label: 'Unexpected price increase',
    description: 'A selling price increases by at least the threshold.',
    threshold: 'pct',
    thresholdLabel: 'Minimum increase (%)',
    defaultThreshold: 5,
  },
  collection_failed: {
    label: 'Collection failing repeatedly',
    description: 'A source has failed the given number of consecutive collection runs.',
    threshold: 'count',
    thresholdLabel: 'Consecutive failures',
    defaultThreshold: 3,
  },
  stale_observation: {
    label: 'No fresh observation',
    description: 'A listing has no observation within the expected timeframe (derived from the source frequency unless an explicit number of hours is set).',
    threshold: 'hours',
    thresholdLabel: 'Maximum age (hours, optional)',
  },
};

export const SEVERITIES = ['info', 'warning', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Confidence bands used across the product for the evidence / extraction confidence indicator. */
export function confidenceBand(confidence: number | null | undefined): 'high' | 'medium' | 'low' | 'unknown' {
  if (confidence === null || confidence === undefined) return 'unknown';
  if (confidence >= 0.85) return 'high';
  if (confidence >= 0.6) return 'medium';
  return 'low';
}

/** A listing is stale when its last observation is older than this multiple of the collection interval. */
export const STALE_MULTIPLIER = 2;
/** Sources without an automatic schedule (manual / CSV) are considered stale after this many hours. */
export const MANUAL_STALE_HOURS = 24 * 7;

export function staleAfterHours(frequency: Frequency | null | undefined): number {
  const hours = frequency ? FREQUENCY_HOURS[frequency] : null;
  return hours ? hours * STALE_MULTIPLIER : MANUAL_STALE_HOURS;
}
