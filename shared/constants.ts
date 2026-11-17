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
    description: 'A selling price increases by at least the threshold (a price returning to its regular level when a promotion ends is ignored).',
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

// ---------------------------------------------------------------------------------------------
// Deal tags: the badges a retailer shows next to a price ("Limited time deal", "Yellow Friday Deal",
// coupons, best-seller flags …). They are stored with every observation, like the price itself.
// ---------------------------------------------------------------------------------------------
export const DEAL_TAGS = [
  'limited_time_deal', 'event_deal', 'lowest_price', 'deal', 'coupon', 'multi_buy', 'best_seller', 'retailer_choice', 'selling_fast', 'other',
] as const;
export type DealTag = (typeof DEAL_TAGS)[number];

export const DEAL_TAG_LABELS: Record<DealTag, string> = {
  limited_time_deal: 'Limited-time deal',
  event_deal: 'Sale-event deal',
  lowest_price: 'Lowest price in N days',
  deal: 'Deal',
  coupon: 'Coupon / extra discount',
  multi_buy: 'Multi-buy offer',
  best_seller: 'Best seller',
  retailer_choice: "Retailer's choice",
  selling_fast: 'Selling fast',
  other: 'Other tag',
};

export const DEAL_TAG_DESCRIPTIONS: Record<DealTag, string> = {
  limited_time_deal: 'The retailer marks the price as a time-limited, lightning or flash deal.',
  event_deal: 'The offer belongs to a named sale event such as Yellow Friday, White Friday, Ramadan, Eid, Prime Day or 11.11.',
  lowest_price: 'The retailer itself states that this is its lowest price of a period, for example "Lowest price in 30 days".',
  deal: 'The retailer shows a general deal badge, for example "Deal" or "Deal of the day".',
  coupon: 'A coupon or an extra discount applies on top of the price shown.',
  multi_buy: 'The offer needs several units, for example "Buy 2 get 1 free" or "3 for 27".',
  best_seller: 'The retailer flags the listing as a best seller.',
  retailer_choice: "The retailer's own recommendation badge, for example Amazon's Choice.",
  selling_fast: 'The retailer signals strong demand or little stock left, for example "Selling out fast" or "Only 3 left in stock".',
  other: "A badge whose wording was not recognised; the retailer's wording is kept as the tag text.",
};

/**
 * Tags that say the listing is on offer. The remaining tags (best seller, retailer's choice, selling fast,
 * other) are badges: they are stored and shown, but a badge alone does not make a listing a deal.
 */
export const DEAL_OFFER_TAGS: readonly DealTag[] = ['limited_time_deal', 'event_deal', 'lowest_price', 'deal', 'coupon', 'multi_buy'];
export const DEAL_BADGE_TAGS: readonly DealTag[] = ['best_seller', 'retailer_choice', 'selling_fast', 'other'];

export function isDealTag(value: unknown): value is DealTag {
  return typeof value === 'string' && (DEAL_TAGS as readonly string[]).includes(value);
}

/** De-duplicates tag keys and returns them in the canonical DEAL_TAGS order. */
export function sortDealTags(tags: Iterable<DealTag>): DealTag[] {
  const present = new Set(tags);
  return DEAL_TAGS.filter((tag) => present.has(tag));
}

/** Reads the stored form of the tags (a JSON array of keys). Anything unreadable counts as "no tags". */
export function parseDealTags(stored: unknown): DealTag[] {
  if (Array.isArray(stored)) return sortDealTags(stored.filter(isDealTag));
  if (typeof stored !== 'string' || stored === '' || stored === '[]') return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? sortDealTags(parsed.filter(isDealTag)) : [];
  } catch {
    return [];
  }
}

/** Lower-cases a retailer's wording and folds the spelling variants that would otherwise hide a match. */
function foldTagWording(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '') // Arabic vowel marks and tatweel
    .replace(/[\u0622\u0623\u0625]/g, '\u0627') // alef with madda / hamza → bare alef
    .replace(/\u0649/g, '\u064A') // alef maksura → ya
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660)) // Arabic-Indic digits
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u2018\u2019\u02BC`\u00B4]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// "AR" below is an Arabic letter; JavaScript's \b does not know Arabic word boundaries.
const AR = '\u0621-\u064A';
const arWord = (pattern: string) => new RegExp(`(?:^|[^${AR}])(?:${pattern})(?![${AR}])`);

/**
 * Wording patterns per tag. They are matched against the folded wording (see foldTagWording), so Arabic is
 * written here without vowel marks, with a bare alef for أ / إ / آ and with ي for ى.
 */
const TAG_PATTERNS: Array<{ tag: DealTag; patterns: RegExp[] }> = [
  {
    tag: 'limited_time_deal',
    patterns: [
      /limited[\s-]*(time|period)/,
      /lightning\s*deal/,
      /flash\s*(sale|deal|offer)/,
      /deal\s+ends|ends\s+in\s+\d/,
      /ل(?:فتر|مد)[\u0629\u0647]\s+محدود/, // عرض لفترة محدودة / عرض لمدة محدودة
      /لوقت\s+محدود/,
      /(?:عرض|عروض|صفق[\u0629\u0647])\s+(?:خاطف|البرق)/, // lightning deal
    ],
  },
  {
    tag: 'event_deal',
    patterns: [
      /(yellow|white|black|blue|green)\s*friday/,
      /cyber\s*monday/,
      /\bramadan\b|\bramazan\b/,
      /\beid\b/,
      /prime\s*(big\s*deal\s*)?days?\b/,
      /singles'?\s*day/,
      /back[\s-]*to[\s-]*school/,
      /(national|founding|flag)\s+day/,
      /dubai\s+(shopping\s+festival|summer\s+surprises)|\bdsf\b|\bdss\b/,
      /\b(mega|super|big)\s+(sale|sales|festival)\b/,
      /\b(summer|winter|spring|autumn|payday|pay\s+day|anniversary|birthday|new\s+year|year[\s-]*end|end[\s-]*of[\s-]*(season|year))\s+(sale|sales|deal|deals|offer|offers|savers?|festival)\b/,
      /الجمع[\u0629\u0647]\s+(?:الصفراء|البيضاء|السوداء)/, // Yellow / White / Black Friday
      /رمضان/,
      arWord('(?:ال)?عيد'),
      /يوم\s+برايم|برايم\s+داي/,
      /اليوم\s+الوطني|يوم\s+التاسيس/,
    ],
  },
  {
    tag: 'lowest_price',
    patterns: [
      /lowest\s+(price\s+)?(in|this|of|for|since|over|within)\s+(the\s+)?(last\s+|past\s+)?(\d+|a|an|one|two|three|six|twelve|the)?\s*(days?|weeks?|months?|years?)/, // "Lowest price in 30 days", "lowest in a year"
      /lowest\s+(price\s+)?(this|of\s+the)\s+(week|month|year|season)/,
      /lowest\s+(price\s+ever|ever\s+price)|all[\s-]*time\s+low/,
      /\b\d+[\s-]*(day|week|month|year)s?\s+low(est)?\b/, // "30-day low"
      /(?:اقل|ادني)\s+سعر\s+(?:خلال|في|منذ|لهذا|هذا)/, // أقل سعر خلال 30 يوم / أقل سعر في …
    ],
  },
  {
    tag: 'coupon',
    patterns: [
      /coupon|voucher/,
      /promo(tion)?\s*code|discount\s*code|\buse\s+code\b|\bwith\s+code\b/,
      /\bextra\b.*\boff\b/, // "Extra 10% off", "Extra AED 2 Off!"
      /\b(additional|further)\s+\d/,
      /cash\s*back/,
      /قسيم[\u0629\u0647]|قسائم|كوبون/,
      /(?:خصم|تخفيض)\s+اضافي/,
      /اضافي[\u0629\u0647]?\s+\d|\d+\s*%\s+اضافي/,
      /استرداد\s+نقدي/,
    ],
  },
  {
    tag: 'multi_buy',
    patterns: [
      /\bbuy\s+(\d+|one|two|three|four|any)\b/,
      /\b\d+\s+for\s*($|[\d.,]|(aed|sar|kwd|qar|bhd|omr|usd|egp|only|just|the\s+price)\b)/, // "2 for", "3 for 2", "2 for AED 15"
      /\bget\s+(\d+|one)\s+(free|more)\b/,
      /\bbogo\b|\bb\dg\d\b|\b[1-9]\s*\+\s*[1-9]\b(?!\s*(ml|g|kg|l|pcs?)\b)/,
      /multi[\s-]*buy|bundle\s+(and|&)\s+save/,
      /\b(2nd|second|3rd|third)\s+(one|item|unit|piece)?\s*(at|for|is)?\s*(half|free|\d+\s*%)/,
      /اشتر[ي]?\s+(?:\d|واحد|اثنين|قطعتين|ثلاث)/,
      /واحصل\s+علي.*مجان/,
    ],
  },
  {
    tag: 'best_seller',
    patterns: [/best[\s-]*sell(er|ers|ing)/, /top[\s-]*sell(er|ers|ing)/, /(?:الاكثر|الافضل|الاعلي)\s+مبيع/],
  },
  {
    tag: 'retailer_choice',
    patterns: [
      /\b(amazon|noon|carrefour|lulu|nahdi|danube|panda|jumia|retailer|store|shop|seller|editor|expert|staff)(s'|'s|s)?[\s-]+choice\b/, // "Amazon's Choice", "amazons-choice"
      /\b[a-z]+('s|s')\s+choice\b/,
      /\b(editor'?s?|our|top|staff)\s+picks?\b/,
      /(?:خيار|اختيار)\s+(?:امازون|نون|المتجر|كارفور|لولو|العملاء)/,
    ],
  },
  {
    tag: 'selling_fast',
    patterns: [
      /sell(s|ing)?\s+(out\s+)?(fast|quickly)|going\s+fast/, // "Selling out fast"
      /almost\s+(gone|sold\s+out)|nearly\s+(gone|sold\s+out)/,
      /\b(few|last)\s+(items?\s+|units?\s+|pieces?\s+)?left\b|\blast\s+few\b/,
      /\bonly\s+\d+\s+(items?\s+|units?\s+|pieces?\s+)?(left|remaining)\b/, // "Only 3 left in stock"
      /\b\d+\s+(items?\s+|units?\s+|pieces?\s+)?(left|remaining)\s+in\s+stock\b|^\d+\s+(items?\s+|units?\s+|pieces?\s+)?(left|remaining)\W*$/,
      /\blow\s+(in\s+)?stock\b|\blimited\s+(stock|quantity|quantities)\b/,
      /يباع\s+بسرع|ينفد\s+بسرع/, // يباع بسرعة
      /(?:ال)?كمي(?:[\u0629\u0647]|ات)\s+(?:ال)?محدود|(?:ال)?مخزون\s+(?:ال)?محدود/, // الكمية محدودة
      /وشك\s+(?:علي\s+)?(?:النفاذ|الانتهاء|النفاد)|(?:بقي|تبقي|متبقي|باقي)\s+\d+/,
    ],
  },
];

/** Numeric sale events ("11.11", "12.12"). Checked apart from the other patterns because a price can look the same. */
const NUMERIC_EVENT = /(^|[^\d.])1[12][.\/-]1[12]($|[^\d.])/;

const GENERIC_DEAL_PATTERNS: RegExp[] = [
  /\bdeals?\b/,
  /\bsale\b|\bclearance\b/,
  /\b(special|hot|great|super|exclusive|online|app|bundle|combo|gift|today'?s)\s+offers?\b/,
  /\b(hot|special|best|low|lowest|super|crazy)\s+prices?\b|\bprice\s+drop\b|\bfree\s+gift\b/,
  /^(on\s+)?offers?$/,
  /صفق[\u0629\u0647]|صفقات/,
  arWord('عرض|عروض'),
  /تخفيضات|تنزيلات|تصفي[\u0629\u0647]/,
];

/** Words that only describe a price cut ("Save 30%", "وفر 28%", "Was 25 now 20"): a lower price, not a tag. */
const PRICE_CUT_WORDS = new Set([
  'save', 'saved', 'saving', 'savings', 'you', 'off', 'discount', 'discounted', 'was', 'now', 'price', 'prices', 'cut', 'reduced', 'reduction',
  'markdown', 'down', 'less', 'up', 'to', 'upto', 'only', 'from', 'by', 'percent', 'pct', 'rrp', 'mrp', 'list', 'regular', 'original', 'incl', 'vat',
  'aed', 'sar', 'kwd', 'qar', 'bhd', 'omr', 'usd', 'egp', 'iqd', 'kes', 'ugx', 'ghs', 'dhs', 'dh', 'sr', 'kd', 'qr', 'bd', 'rs',
  'وفر', 'وفري', 'توفير', 'خصم', 'بخصم', 'خصومات', 'تخفيض', 'السعر', 'سعر', 'قبل', 'بعد', 'كان', 'الان', 'فقط', 'حتي', 'الي', 'من',
  'ريال', 'درهم', 'دينار', 'جنيه', 'س', 'ر', 'د', 'ا',
]);

/** True when the wording is nothing but a price cut (or carries no words at all), i.e. it is not a tag. */
export function isPriceCutWording(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return true;
  const words = foldTagWording(text).match(/\p{L}+/gu) ?? [];
  return words.every((word) => PRICE_CUT_WORDS.has(word));
}

/** Tag key for a text that is exactly a key or its label ("limited_time_deal", "Limited-time deal"), else null. */
export function dealTagFromLabel(text: string | null | undefined): DealTag | null {
  if (typeof text !== 'string') return null;
  const folded = text.trim().toLowerCase();
  if (!folded) return null;
  const asKey = folded.replace(/[\s-]+/g, '_');
  for (const tag of DEAL_TAGS) {
    if (asKey === tag || folded === DEAL_TAG_LABELS[tag].toLowerCase()) return tag;
  }
  return null;
}

/**
 * Maps a retailer's own wording (English or Arabic) to tag keys.
 *
 *   "Limited time deal", "عرض لفترة محدودة", "Lightning deal"   → limited_time_deal
 *   "Early Yellow Friday Deal", "Ramadan offer", "Prime Day"    → event_deal
 *   "Lowest price in 30 days", "أقل سعر خلال 30 يوم"             → lowest_price
 *   "Deal", "Deal of the day"                                   → deal
 *   "Extra 10% off", "coupon", "قسيمة"                           → coupon
 *   "Buy 2 get 1 free", "Buy 3 For 27.38 AED"                   → multi_buy
 *   "#1 Best Seller", "الأكثر مبيعاً"                             → best_seller
 *   "Amazon's Choice", "amazons-choice", "خيار أمازون"           → retailer_choice
 *   "Selling out fast", "Only 3 left in stock", "يباع بسرعة"     → selling_fast
 *
 * A plain price cut ("Save 30%", "وفر 28%") is a lower price, not a tag, and yields nothing. Wording that is
 * neither recognised nor a price cut yields `other`, but only when nothing else was recognised. The general
 * `deal` key is dropped when a more specific offer tag was found.
 */
export function normaliseDealTags(texts: ReadonlyArray<string | null | undefined>): DealTag[] {
  const found = new Set<DealTag>();
  let unrecognised = false;
  for (const raw of texts) {
    if (typeof raw !== 'string') continue;
    const exact = dealTagFromLabel(raw);
    if (exact) {
      found.add(exact);
      continue;
    }
    const text = foldTagWording(raw);
    if (!text) continue;
    let matched = false;
    let offer = false;
    for (const { tag, patterns } of TAG_PATTERNS) {
      if (patterns.some((pattern) => pattern.test(text))) {
        found.add(tag);
        matched = true;
        if (DEAL_OFFER_TAGS.includes(tag)) offer = true;
      }
    }
    // "11.11" names the sale event, "Was 11.11" names a price.
    if (NUMERIC_EVENT.test(text) && (!/\p{L}/u.test(text) || !isPriceCutWording(text))) {
      found.add('event_deal');
      matched = true;
      offer = true;
    }
    // The general deal badge is the fallback for offer wording that names nothing more specific.
    if (!offer && GENERIC_DEAL_PATTERNS.some((pattern) => pattern.test(text))) {
      found.add('deal');
      matched = true;
    }
    if (!matched && !isPriceCutWording(text)) unrecognised = true;
  }
  if (DEAL_OFFER_TAGS.some((tag) => tag !== 'deal' && found.has(tag))) found.delete('deal');
  if (unrecognised && found.size === 0) found.add('other');
  if (found.size > 1) found.delete('other');
  return sortDealTags(found);
}
