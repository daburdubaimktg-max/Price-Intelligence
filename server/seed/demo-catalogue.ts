/**
 * Definition of the illustrative DEMO dataset.
 *
 * Brand and retailer names are used purely so the demo looks familiar to an FMCG team.
 * EVERY PRICE IS FICTIONAL. Nothing here was collected from, or represents, any retailer or brand.
 * All records created from this file are flagged is_demo = 1 and shown as DEMO DATA throughout the product.
 */
import type { PromoType } from '../../shared/constants.ts';

export interface DemoBrand {
  name: string;
  ownership: 'own' | 'competitor';
  manufacturer: string;
  /** Typical share of days on promotion for this brand. */
  promo: number;
}

export const DEMO_BRANDS: DemoBrand[] = [
  { name: 'Dabur Amla', ownership: 'own', manufacturer: 'Dabur', promo: 0.2 },
  { name: 'Vatika', ownership: 'own', manufacturer: 'Dabur', promo: 0.22 },
  { name: 'Dabur Herbal', ownership: 'own', manufacturer: 'Dabur', promo: 0.18 },
  { name: 'Parachute', ownership: 'competitor', manufacturer: 'Marico', promo: 0.24 },
  { name: 'Emami', ownership: 'competitor', manufacturer: 'Emami', promo: 0.16 },
  { name: 'Bajaj', ownership: 'competitor', manufacturer: 'Bajaj Consumer Care', promo: 0.14 },
  { name: 'Himalaya', ownership: 'competitor', manufacturer: 'Himalaya Wellness', promo: 0.12 },
  { name: 'Pantene', ownership: 'competitor', manufacturer: 'Procter & Gamble', promo: 0.32 },
  { name: 'Sunsilk', ownership: 'competitor', manufacturer: 'Unilever', promo: 0.3 },
  { name: 'Head & Shoulders', ownership: 'competitor', manufacturer: 'Procter & Gamble', promo: 0.3 },
  { name: 'Brylcreem', ownership: 'competitor', manufacturer: 'Unilever', promo: 0.15 },
  { name: 'Colgate', ownership: 'competitor', manufacturer: 'Colgate-Palmolive', promo: 0.28 },
  { name: 'Sensodyne', ownership: 'competitor', manufacturer: 'Haleon', promo: 0.18 },
];

/** own brand → competitor brands it is benchmarked against */
export const DEMO_BRAND_COMPETITORS: Record<string, string[]> = {
  'Dabur Amla': ['Parachute', 'Emami', 'Bajaj', 'Himalaya'],
  Vatika: ['Parachute', 'Pantene', 'Sunsilk', 'Head & Shoulders', 'Himalaya', 'Brylcreem'],
  'Dabur Herbal': ['Colgate', 'Sensodyne', 'Himalaya'],
};

export const DEMO_CATEGORIES: Record<string, string[]> = {
  'Hair Care': ['Hair Oil', 'Shampoo', 'Hair Cream', 'Hair Treatment'],
  'Oral Care': ['Toothpaste'],
};

export interface DemoProduct {
  key: string;
  brand: string;
  name: string;
  line: string;
  category: string;
  subcategory: string;
  size: number;
  unit: 'ml' | 'g';
  /** Fictional regular shelf price in AED used as the base of the price model. */
  baseAed: number;
  /** Markets where the product is sold; 'ALL' or a list of market codes. */
  markets: 'ALL' | string[];
}

const GCC = ['AE', 'SA', 'KW', 'QA', 'BH', 'OM'];
const GCC_IQ = [...GCC, 'IQ'];
const AFRICA = ['KE', 'UG', 'GH'];

export const DEMO_PRODUCTS: DemoProduct[] = [
  // ---- own brands ----------------------------------------------------------------------------
  { key: 'amla100', brand: 'Dabur Amla', name: 'Dabur Amla Hair Oil 100ml', line: 'Dabur Amla Hair Oil', category: 'Hair Care', subcategory: 'Hair Oil', size: 100, unit: 'ml', baseAed: 6.5, markets: 'ALL' },
  { key: 'amla200', brand: 'Dabur Amla', name: 'Dabur Amla Hair Oil 200ml', line: 'Dabur Amla Hair Oil', category: 'Hair Care', subcategory: 'Hair Oil', size: 200, unit: 'ml', baseAed: 11.5, markets: 'ALL' },
  { key: 'amla300', brand: 'Dabur Amla', name: 'Dabur Amla Hair Oil 300ml', line: 'Dabur Amla Hair Oil', category: 'Hair Care', subcategory: 'Hair Oil', size: 300, unit: 'ml', baseAed: 15.75, markets: GCC_IQ },
  { key: 'amlagold200', brand: 'Dabur Amla', name: 'Dabur Amla Gold Hair Oil 200ml', line: 'Dabur Amla Gold', category: 'Hair Care', subcategory: 'Hair Oil', size: 200, unit: 'ml', baseAed: 13.25, markets: GCC },
  { key: 'vatcoco200', brand: 'Vatika', name: 'Vatika Enriched Coconut Hair Oil 200ml', line: 'Vatika Coconut Hair Oil', category: 'Hair Care', subcategory: 'Hair Oil', size: 200, unit: 'ml', baseAed: 10.75, markets: 'ALL' },
  { key: 'vatcoco300', brand: 'Vatika', name: 'Vatika Enriched Coconut Hair Oil 300ml', line: 'Vatika Coconut Hair Oil', category: 'Hair Care', subcategory: 'Hair Oil', size: 300, unit: 'ml', baseAed: 14.5, markets: GCC_IQ },
  { key: 'vatbs400', brand: 'Vatika', name: 'Vatika Black Seed Shampoo 400ml', line: 'Vatika Shampoo', category: 'Hair Care', subcategory: 'Shampoo', size: 400, unit: 'ml', baseAed: 18.5, markets: [...GCC_IQ, 'KE'] },
  { key: 'vatgar400', brand: 'Vatika', name: 'Vatika Garlic Shampoo 400ml', line: 'Vatika Shampoo', category: 'Hair Care', subcategory: 'Shampoo', size: 400, unit: 'ml', baseAed: 18.5, markets: GCC },
  { key: 'vatcream140', brand: 'Vatika', name: 'Vatika Styling Hair Cream 140ml', line: 'Vatika Hair Cream', category: 'Hair Care', subcategory: 'Hair Cream', size: 140, unit: 'ml', baseAed: 9.25, markets: GCC_IQ },
  { key: 'vatcream210', brand: 'Vatika', name: 'Vatika Styling Hair Cream 210ml', line: 'Vatika Hair Cream', category: 'Hair Care', subcategory: 'Hair Cream', size: 210, unit: 'ml', baseAed: 12.75, markets: GCC },
  { key: 'vathz500', brand: 'Vatika', name: 'Vatika Hammam Zaith Hot Oil Treatment 500g', line: 'Vatika Hammam Zaith', category: 'Hair Care', subcategory: 'Hair Treatment', size: 500, unit: 'g', baseAed: 16.5, markets: GCC },
  { key: 'herbclove150', brand: 'Dabur Herbal', name: 'Dabur Herbal Clove Toothpaste 150g', line: 'Dabur Herbal Toothpaste', category: 'Oral Care', subcategory: 'Toothpaste', size: 150, unit: 'g', baseAed: 8.75, markets: 'ALL' },
  { key: 'herbchar150', brand: 'Dabur Herbal', name: 'Dabur Herbal Charcoal Toothpaste 150g', line: 'Dabur Herbal Toothpaste', category: 'Oral Care', subcategory: 'Toothpaste', size: 150, unit: 'g', baseAed: 9.5, markets: 'ALL' },
  { key: 'miswak120', brand: 'Dabur Herbal', name: 'Dabur Miswak Toothpaste 120g', line: 'Dabur Miswak', category: 'Oral Care', subcategory: 'Toothpaste', size: 120, unit: 'g', baseAed: 7.25, markets: [...GCC_IQ, 'KE'] },
  // ---- competitors ---------------------------------------------------------------------------
  { key: 'para200', brand: 'Parachute', name: 'Parachute Coconut Hair Oil 200ml', line: 'Parachute Coconut Oil', category: 'Hair Care', subcategory: 'Hair Oil', size: 200, unit: 'ml', baseAed: 12.25, markets: 'ALL' },
  { key: 'para300', brand: 'Parachute', name: 'Parachute Coconut Hair Oil 300ml', line: 'Parachute Coconut Oil', category: 'Hair Care', subcategory: 'Hair Oil', size: 300, unit: 'ml', baseAed: 16.5, markets: GCC_IQ },
  { key: 'emami200', brand: 'Emami', name: 'Emami 7 Oils in One Hair Oil 200ml', line: 'Emami 7 Oils in One', category: 'Hair Care', subcategory: 'Hair Oil', size: 200, unit: 'ml', baseAed: 13.5, markets: GCC },
  { key: 'bajaj200', brand: 'Bajaj', name: 'Bajaj Almond Drops Hair Oil 200ml', line: 'Bajaj Almond Drops', category: 'Hair Care', subcategory: 'Hair Oil', size: 200, unit: 'ml', baseAed: 12.75, markets: GCC },
  { key: 'himoil200', brand: 'Himalaya', name: 'Himalaya Anti-Hair Fall Hair Oil 200ml', line: 'Himalaya Hair Oil', category: 'Hair Care', subcategory: 'Hair Oil', size: 200, unit: 'ml', baseAed: 17.5, markets: [...GCC, 'KE'] },
  { key: 'pant400', brand: 'Pantene', name: 'Pantene Pro-V Smooth & Silky Shampoo 400ml', line: 'Pantene Pro-V Shampoo', category: 'Hair Care', subcategory: 'Shampoo', size: 400, unit: 'ml', baseAed: 21.5, markets: 'ALL' },
  { key: 'sun400', brand: 'Sunsilk', name: 'Sunsilk Black Shine Shampoo 400ml', line: 'Sunsilk Shampoo', category: 'Hair Care', subcategory: 'Shampoo', size: 400, unit: 'ml', baseAed: 16.75, markets: 'ALL' },
  { key: 'hs400', brand: 'Head & Shoulders', name: 'Head & Shoulders Classic Clean Shampoo 400ml', line: 'Head & Shoulders Shampoo', category: 'Hair Care', subcategory: 'Shampoo', size: 400, unit: 'ml', baseAed: 23.5, markets: [...GCC_IQ, 'KE', 'GH'] },
  { key: 'himsh400', brand: 'Himalaya', name: 'Himalaya Protein Shampoo 400ml', line: 'Himalaya Shampoo', category: 'Hair Care', subcategory: 'Shampoo', size: 400, unit: 'ml', baseAed: 19.75, markets: GCC },
  { key: 'pgcream140', brand: 'Parachute', name: 'Parachute Gold Hair Cream 140ml', line: 'Parachute Gold Hair Cream', category: 'Hair Care', subcategory: 'Hair Cream', size: 140, unit: 'ml', baseAed: 9.75, markets: GCC_IQ },
  { key: 'pgcream210', brand: 'Parachute', name: 'Parachute Gold Hair Cream 210ml', line: 'Parachute Gold Hair Cream', category: 'Hair Care', subcategory: 'Hair Cream', size: 210, unit: 'ml', baseAed: 13.5, markets: GCC },
  { key: 'bryl210', brand: 'Brylcreem', name: 'Brylcreem Original Hair Cream 210ml', line: 'Brylcreem', category: 'Hair Care', subcategory: 'Hair Cream', size: 210, unit: 'ml', baseAed: 14.25, markets: GCC },
  { key: 'pantor350', brand: 'Pantene', name: 'Pantene Oil Replacement 350ml', line: 'Pantene Oil Replacement', category: 'Hair Care', subcategory: 'Hair Cream', size: 350, unit: 'ml', baseAed: 17.5, markets: GCC },
  { key: 'himtp150', brand: 'Himalaya', name: 'Himalaya Complete Care Toothpaste 150g', line: 'Himalaya Toothpaste', category: 'Oral Care', subcategory: 'Toothpaste', size: 150, unit: 'g', baseAed: 9.25, markets: [...GCC, 'KE'] },
  { key: 'colherb125', brand: 'Colgate', name: 'Colgate Herbal Toothpaste 125ml', line: 'Colgate Herbal', category: 'Oral Care', subcategory: 'Toothpaste', size: 125, unit: 'ml', baseAed: 10.5, markets: 'ALL' },
  { key: 'colchar75', brand: 'Colgate', name: 'Colgate Charcoal Toothpaste 75ml', line: 'Colgate Charcoal', category: 'Oral Care', subcategory: 'Toothpaste', size: 75, unit: 'ml', baseAed: 13.75, markets: [...GCC, ...AFRICA] },
  { key: 'senso75', brand: 'Sensodyne', name: 'Sensodyne Herbal Multi Care Toothpaste 75ml', line: 'Sensodyne Herbal', category: 'Oral Care', subcategory: 'Toothpaste', size: 75, unit: 'ml', baseAed: 21.5, markets: [...GCC, 'KE'] },
];

export interface DemoMapping {
  own: string;
  competitor: string;
  equivalence: 'equivalent' | 'comparable';
  status: 'approved' | 'suggested';
  rationale: string;
}

const eq = (own: string, competitor: string, rationale = 'Same need, format and pack size'): DemoMapping => ({ own, competitor, equivalence: 'equivalent', status: 'approved', rationale });
const cmp = (own: string, competitor: string, rationale: string): DemoMapping => ({ own, competitor, equivalence: 'comparable', status: 'approved', rationale });
const sug = (own: string, competitor: string, equivalence: 'equivalent' | 'comparable', rationale: string): DemoMapping => ({ own, competitor, equivalence, status: 'suggested', rationale });

export const DEMO_MAPPINGS: DemoMapping[] = [
  eq('amla200', 'para200'), eq('amla200', 'emami200'), eq('amla200', 'bajaj200'), eq('amla200', 'himoil200'),
  eq('amla300', 'para300'), cmp('amla300', 'para200', 'Pack size differs (300ml vs 200ml) — compare unit price only'),
  cmp('amla100', 'para200', 'Pack size differs (100ml vs 200ml) — compare unit price only'),
  sug('amlagold200', 'emami200', 'equivalent', 'Same subcategory and pack size (200ml)'),
  eq('vatcoco200', 'para200'), eq('vatcoco300', 'para300'),
  eq('vatbs400', 'pant400'), eq('vatbs400', 'sun400'), eq('vatbs400', 'hs400'), eq('vatbs400', 'himsh400'),
  eq('vatgar400', 'sun400'), sug('vatgar400', 'pant400', 'equivalent', 'Same subcategory and pack size (400ml)'),
  eq('vatcream140', 'pgcream140'), cmp('vatcream140', 'bryl210', 'Pack size differs (140ml vs 210ml) — compare unit price only'),
  cmp('vatcream140', 'pantor350', 'Different format and size (leave-on oil replacement 350ml)'),
  eq('vatcream210', 'pgcream210'), eq('vatcream210', 'bryl210'),
  eq('herbclove150', 'himtp150'),
  cmp('herbclove150', 'colherb125', 'Units differ (150g vs 125ml) — unit prices are not comparable'),
  cmp('herbclove150', 'senso75', 'Units differ (150g vs 75ml) — unit prices are not comparable'),
  cmp('herbchar150', 'colchar75', 'Units differ (150g vs 75ml) — unit prices are not comparable'),
  sug('herbchar150', 'himtp150', 'equivalent', 'Same subcategory and pack size (150g)'),
  cmp('miswak120', 'himtp150', 'Pack size differs (120g vs 150g) — compare unit price only'),
  sug('miswak120', 'colherb125', 'comparable', 'Units differ (120g vs 125ml) — unit prices are not comparable'),
];

export type DemoRetailerKind = 'hypermarket' | 'marketplace' | 'supermarket';

export interface DemoRetailer {
  name: string;
  market: string;
  website: string;
  kind: DemoRetailerKind;
  /** How this demo source is labelled: simulated feed, demo CSV import or demo manual entry. */
  method: 'simulated' | 'csv_import' | 'manual';
  frequency: '6h' | '12h' | 'daily' | 'weekly' | 'manual';
  /** Share of the market's products this retailer lists. */
  assortment: number;
  /** Price level relative to the market average. */
  priceFactor: number;
  /** Probability that a simulated run fails (demonstrates failure handling). */
  failureRate: number;
  paused?: boolean;
}

export const DEMO_RETAILERS: DemoRetailer[] = [
  { name: 'Carrefour UAE', market: 'AE', website: 'https://www.carrefouruae.com', kind: 'hypermarket', method: 'simulated', frequency: '6h', assortment: 0.95, priceFactor: 1.0, failureRate: 0.02 },
  { name: 'Lulu Hypermarket UAE', market: 'AE', website: 'https://www.luluhypermarket.com', kind: 'hypermarket', method: 'simulated', frequency: '12h', assortment: 0.9, priceFactor: 0.98, failureRate: 0.03 },
  { name: 'Noon UAE', market: 'AE', website: 'https://www.noon.com', kind: 'marketplace', method: 'simulated', frequency: '12h', assortment: 0.85, priceFactor: 1.03, failureRate: 0.05 },
  { name: 'Amazon.ae', market: 'AE', website: 'https://www.amazon.ae', kind: 'marketplace', method: 'simulated', frequency: 'daily', assortment: 0.8, priceFactor: 1.05, failureRate: 0.04 },
  { name: 'Union Coop', market: 'AE', website: 'https://www.unioncoop.ae', kind: 'supermarket', method: 'manual', frequency: 'manual', assortment: 0.45, priceFactor: 0.97, failureRate: 0 },
  { name: 'Panda', market: 'SA', website: 'https://www.panda.sa', kind: 'hypermarket', method: 'simulated', frequency: 'daily', assortment: 0.9, priceFactor: 1.0, failureRate: 0.03 },
  { name: 'Carrefour KSA', market: 'SA', website: 'https://www.carrefourksa.com', kind: 'hypermarket', method: 'simulated', frequency: '12h', assortment: 0.9, priceFactor: 1.01, failureRate: 0.03 },
  { name: 'Noon KSA', market: 'SA', website: 'https://www.noon.com', kind: 'marketplace', method: 'simulated', frequency: 'daily', assortment: 0.8, priceFactor: 1.04, failureRate: 0.05 },
  { name: 'Amazon.sa', market: 'SA', website: 'https://www.amazon.sa', kind: 'marketplace', method: 'simulated', frequency: 'daily', assortment: 0.75, priceFactor: 1.06, failureRate: 0.04 },
  { name: 'Danube', market: 'SA', website: 'https://www.danube.sa', kind: 'supermarket', method: 'simulated', frequency: 'daily', assortment: 0.6, priceFactor: 1.08, failureRate: 0.03 },
  { name: 'Lulu Hypermarket Kuwait', market: 'KW', website: 'https://www.luluhypermarket.com', kind: 'hypermarket', method: 'simulated', frequency: 'daily', assortment: 0.85, priceFactor: 0.99, failureRate: 0.03 },
  { name: 'Carrefour Kuwait', market: 'KW', website: 'https://www.carrefourkuwait.com', kind: 'hypermarket', method: 'simulated', frequency: 'daily', assortment: 0.85, priceFactor: 1.0, failureRate: 0.03 },
  { name: 'The Sultan Center', market: 'KW', website: 'https://www.sultan-center.com', kind: 'supermarket', method: 'simulated', frequency: 'daily', assortment: 0.55, priceFactor: 1.07, failureRate: 0.03, paused: true },
  { name: 'Lulu Hypermarket Qatar', market: 'QA', website: 'https://www.luluhypermarket.com', kind: 'hypermarket', method: 'simulated', frequency: 'daily', assortment: 0.85, priceFactor: 0.99, failureRate: 0.03 },
  { name: 'Carrefour Qatar', market: 'QA', website: 'https://www.carrefourqatar.com', kind: 'hypermarket', method: 'simulated', frequency: 'daily', assortment: 0.85, priceFactor: 1.0, failureRate: 0.03 },
  { name: 'Al Meera', market: 'QA', website: 'https://www.almeera.com.qa', kind: 'supermarket', method: 'csv_import', frequency: 'manual', assortment: 0.5, priceFactor: 1.02, failureRate: 0 },
  { name: 'Lulu Hypermarket Bahrain', market: 'BH', website: 'https://www.luluhypermarket.com', kind: 'hypermarket', method: 'simulated', frequency: 'daily', assortment: 0.8, priceFactor: 0.99, failureRate: 0.03 },
  { name: 'Carrefour Bahrain', market: 'BH', website: 'https://www.carrefourbahrain.com', kind: 'hypermarket', method: 'simulated', frequency: 'daily', assortment: 0.8, priceFactor: 1.0, failureRate: 0.03 },
  { name: 'Lulu Hypermarket Oman', market: 'OM', website: 'https://www.luluhypermarket.com', kind: 'hypermarket', method: 'simulated', frequency: 'daily', assortment: 0.8, priceFactor: 0.99, failureRate: 0.03 },
  { name: 'Carrefour Oman', market: 'OM', website: 'https://www.carrefouroman.com', kind: 'hypermarket', method: 'simulated', frequency: 'daily', assortment: 0.8, priceFactor: 1.0, failureRate: 0.03 },
  { name: 'Carrefour Iraq', market: 'IQ', website: 'https://www.carrefouriraq.com', kind: 'hypermarket', method: 'simulated', frequency: 'daily', assortment: 0.8, priceFactor: 1.0, failureRate: 0.04 },
  { name: 'Miswag', market: 'IQ', website: 'https://www.miswag.com', kind: 'marketplace', method: 'simulated', frequency: 'daily', assortment: 0.6, priceFactor: 1.05, failureRate: 0.35 },
  { name: 'Carrefour Kenya', market: 'KE', website: 'https://www.carrefour.ke', kind: 'hypermarket', method: 'simulated', frequency: 'daily', assortment: 0.85, priceFactor: 1.0, failureRate: 0.03 },
  { name: 'Naivas', market: 'KE', website: 'https://www.naivas.online', kind: 'supermarket', method: 'simulated', frequency: 'daily', assortment: 0.75, priceFactor: 0.97, failureRate: 0.04 },
  { name: 'Jumia Kenya', market: 'KE', website: 'https://www.jumia.co.ke', kind: 'marketplace', method: 'simulated', frequency: 'daily', assortment: 0.7, priceFactor: 1.06, failureRate: 0.06 },
  { name: 'Carrefour Uganda', market: 'UG', website: 'https://www.carrefour.ug', kind: 'hypermarket', method: 'simulated', frequency: 'daily', assortment: 0.85, priceFactor: 1.0, failureRate: 0.04 },
  { name: 'Jumia Uganda', market: 'UG', website: 'https://www.jumia.ug', kind: 'marketplace', method: 'simulated', frequency: 'weekly', assortment: 0.7, priceFactor: 1.07, failureRate: 0.06 },
  { name: 'Shoprite Ghana', market: 'GH', website: 'https://www.shoprite.com.gh', kind: 'hypermarket', method: 'simulated', frequency: 'daily', assortment: 0.85, priceFactor: 1.0, failureRate: 0.04 },
  { name: 'Jumia Ghana', market: 'GH', website: 'https://www.jumia.com.gh', kind: 'marketplace', method: 'simulated', frequency: 'daily', assortment: 0.75, priceFactor: 1.05, failureRate: 0.06 },
  { name: 'Melcom', market: 'GH', website: 'https://www.melcom.com', kind: 'supermarket', method: 'simulated', frequency: 'weekly', assortment: 0.6, priceFactor: 0.98, failureRate: 0.05 },
];

/** Promotion mechanics by retailer type (repeated entries act as weights). */
export const PROMO_TYPES_BY_KIND: Record<DemoRetailerKind, PromoType[]> = {
  hypermarket: ['price_cut', 'price_cut', 'price_cut', 'multi_buy', 'bundle'],
  marketplace: ['price_cut', 'price_cut', 'coupon', 'coupon'],
  supermarket: ['price_cut', 'price_cut', 'multi_buy'],
};

export interface DemoMarketEconomics {
  /** Illustrative units of local currency per 1 USD. */
  perUsd: number;
  /** Whether the currency is pegged (demo rate history stays flat). */
  pegged: boolean;
  /** Price level of the market relative to the UAE. */
  level: number;
  /** Price rounding step in local currency. */
  step: number;
}

/** Illustrative figures only — replace with a live exchange-rate source for real analysis. */
export const DEMO_MARKET_ECONOMICS: Record<string, DemoMarketEconomics> = {
  AE: { perUsd: 3.6725, pegged: true, level: 1.0, step: 0.25 },
  SA: { perUsd: 3.75, pegged: true, level: 1.03, step: 0.25 },
  KW: { perUsd: 0.3068, pegged: false, level: 1.06, step: 0.025 },
  QA: { perUsd: 3.64, pegged: true, level: 1.08, step: 0.25 },
  BH: { perUsd: 0.376, pegged: true, level: 1.05, step: 0.025 },
  OM: { perUsd: 0.3845, pegged: true, level: 1.02, step: 0.025 },
  IQ: { perUsd: 1310, pegged: false, level: 0.92, step: 250 },
  KE: { perUsd: 129.5, pegged: false, level: 1.12, step: 5 },
  UG: { perUsd: 3650, pegged: false, level: 1.15, step: 100 },
  GH: { perUsd: 12.4, pegged: false, level: 1.2, step: 0.5 },
};

/** Other currencies given an illustrative demo rate so the reporting-currency selector has options. */
export const DEMO_EXTRA_RATES: Record<string, number> = { EUR: 0.92, GBP: 0.79, INR: 88.5 };

/** Listings deliberately left unmatched so the product-matching workflow has something to review. */
export const DEMO_UNMATCHED_LISTINGS: Array<{ retailer: string; title: string; externalId: string; gtinOf?: string; profileOf?: string }> = [
  { retailer: 'Noon UAE', title: 'Dabur Amla Hair Oil - 200 ml', externalId: 'N-DAB-AMLA-200-B', profileOf: 'amla200' },
  { retailer: 'Noon UAE', title: 'Vatika Naturals Enriched Coconut Hair Oil 300ml', externalId: 'N-VAT-COCO-300-B', profileOf: 'vatcoco300' },
  { retailer: 'Amazon.ae', title: 'Vatika Black Seed Shampoo 200ml (travel size)', externalId: 'B0DEMO200BS' },
  { retailer: 'Amazon.ae', title: 'Parachute Coconut Oil 200 ML Bottle', externalId: 'B0DEMOPARA2', gtinOf: 'para200', profileOf: 'para200' },
  { retailer: 'Jumia Kenya', title: 'Dabur Herbal Toothpaste Clove 150 g x 2', externalId: 'JK-DHT-150-2PK' },
];
