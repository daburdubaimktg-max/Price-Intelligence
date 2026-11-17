/**
 * Staged imports of historical prices and products from CSV or Excel (.xlsx).
 *
 *   stage     – keep the original file (sha256 recorded) and propose a column mapping
 *   validate  – dry run: every row is checked, nothing is written to the ledger
 *   commit    – valid rows are written; invalid rows are skipped and reported
 *   void      – a committed price import can be withdrawn: its observations are voided, never deleted
 *
 * Imported observations keep their original observation dates, are labelled "imported"
 * (source_method = csv_import), reference the import batch and its evidence record, and carry a
 * confidence indicator. Re-importing the same file never duplicates observations.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext, AuthUser } from '../context.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../lib/errors.ts';
import { parseCsv, parseXlsx, toCsv, type TabularData } from '../lib/tabular.ts';
import { nowIso, parseTimestamp, type DateOrder, type ParsedTimestamp } from '../lib/time.ts';
import {
  AVAILABILITY, dealTagFromLabel, normaliseDealTags, PACK_UNITS, sortDealTags,
  type Availability, type DealTag, type PackUnit, type PromoType,
} from '../../shared/constants.ts';
import { formatPack, parsePackFromText } from '../../shared/units.ts';
import type {
  ImportBatch,
  ImportCommitResponse,
  ImportFieldInfo,
  ImportIssue,
  ImportKind,
  ImportStageResponse,
  ImportSummary,
  ImportValidateResponse,
  ImportVoidResponse,
  ObservationImportOptions,
  ObservationImportPreviewRow,
  ProductImportOptions,
  ProductImportPreviewRow,
} from '../../shared/api/observations.ts';
import { audit } from './core.ts';
import { refreshListingDerived } from './derived.ts';
import { buildXlsx, XLSX_MIME, type ColumnSpec } from './export.ts';
import { ingestObservations, normaliseObservation, type NormalisedObservation, type ObservationInput } from './ingestion.ts';

export const IMPORT_MAX_BYTES = 30 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 200_000;
const ISSUE_LIMIT = 200;
const WARNING_LIMIT = 100;
const PREVIEW_ROWS = 20;
const COMMIT_CHUNK = 5000;
const EXAMPLE_MARKER = 'EXAMPLE ROW';

// ---------------------------------------------------------------------------------------------
// Field catalogue
// ---------------------------------------------------------------------------------------------
export const OBSERVATION_FIELDS: ImportFieldInfo[] = [
  { field: 'listing_code', label: 'Listing code', group: 'Which listing', required: 'conditional', description: 'The listing identifier (e.g. LST-000123). The most precise way to identify a listing; if mapped, retailer and product columns are optional.' },
  { field: 'retailer', label: 'Retailer', group: 'Which listing', required: 'conditional', description: 'Retailer name exactly as configured. Needed unless a listing code is given.' },
  { field: 'market', label: 'Market', group: 'Which listing', required: 'no', description: 'Market code or name (e.g. AE or UAE). Needed only when the same retailer name exists in several markets.' },
  { field: 'listing_external_id', label: 'Retailer item ID', group: 'Which listing', required: 'conditional', description: "The retailer's own SKU / item id of the listing." },
  { field: 'listing_url', label: 'Listing URL', group: 'Which listing', required: 'conditional', description: 'The exact URL configured on the listing.' },
  { field: 'product_code', label: 'Product code', group: 'Which listing', required: 'conditional', description: 'Canonical product ID (e.g. PRD-00042); used with the retailer to find the listing.' },
  { field: 'sku', label: 'SKU', group: 'Which listing', required: 'conditional', description: 'Your SKU of the canonical product; used with the retailer to find the listing.' },
  { field: 'gtin', label: 'Barcode / GTIN', group: 'Which listing', required: 'conditional', description: 'Barcode of the canonical product; used with the retailer to find the listing.' },
  { field: 'observed_at', label: 'Observed at (date and time)', group: 'When', required: 'conditional', description: 'When the price was observed. ISO timestamps with an offset are exact; otherwise the market time zone (or UTC, see options) applies. A date without a time is recorded as "date only".' },
  { field: 'observed_date', label: 'Observation date', group: 'When', required: 'conditional', description: 'Date of the observation when date and time are in separate columns.' },
  { field: 'observed_time', label: 'Observation time', group: 'When', required: 'no', description: 'Time of day (HH:mm) belonging to the observation date.' },
  { field: 'regular_price', label: 'Regular price', group: 'Price', required: 'no', description: 'Regular listed price ("was" price).' },
  { field: 'current_price', label: 'Current price', group: 'Price', required: 'conditional', description: 'Price the shopper pays. Required unless a promo or regular price is given, or the product is out of stock.' },
  { field: 'promo_price', label: 'Promo price', group: 'Price', required: 'no', description: 'Promotional price when on offer.' },
  { field: 'discount_pct', label: 'Discount %', group: 'Price', required: 'no', description: 'Discount in percent (20 or 20%). Calculated from the regular price when blank.' },
  { field: 'currency', label: 'Currency', group: 'Price', required: 'no', description: 'ISO currency code. Must equal the retailer currency; blank means the retailer currency.' },
  { field: 'on_promotion', label: 'On promotion', group: 'Promotion', required: 'no', description: 'Yes / No flag for promotional pricing.' },
  { field: 'promo_type', label: 'Promo type', group: 'Promotion', required: 'no', description: 'Price cut, multi-buy, bundle, coupon or other.' },
  { field: 'promo_description', label: 'Promo description', group: 'Promotion', required: 'no', description: 'Offer text, e.g. "Buy 2 save 20%".' },
  { field: 'promo_starts_on', label: 'Promo starts on', group: 'Promotion', required: 'no', description: 'Stated start date of the promotion.' },
  { field: 'promo_ends_on', label: 'Promo ends on', group: 'Promotion', required: 'no', description: 'Stated end date of the promotion.' },
  { field: 'tags', label: 'Tags', group: 'Tags and signals', required: 'no', description: 'Deal tags or badges shown with the price, e.g. "Limited time deal", "Best seller" or "Extra 10% off" (English or Arabic). Separate several tags with ; or |. A plain price cut such as "Save 30%" is not a tag.' },
  { field: 'tag_text', label: 'Tag text', group: 'Tags and signals', required: 'no', description: 'The retailer\'s own wording of the tag, e.g. "Early Yellow Friday Deal". It is also read for tags when the Tags column is blank.' },
  { field: 'rating', label: 'Rating', group: 'Tags and signals', required: 'no', description: 'Average customer rating from 0 to 5 (4.5, or 4.5/5).' },
  { field: 'review_count', label: 'Reviews', group: 'Tags and signals', required: 'no', description: 'Number of ratings or reviews (a whole number; 1.2K is read as 1,200).' },
  { field: 'sales_rank', label: 'Sales rank', group: 'Tags and signals', required: 'no', description: 'Position in the retailer\'s sales ranking: 3, or the full wording such as "#3 in Shampoos".' },
  { field: 'sales_rank_label', label: 'Sales rank label', group: 'Tags and signals', required: 'no', description: 'The ranking the position refers to, e.g. "#3 in Shampoos".' },
  { field: 'seller_name', label: 'Seller', group: 'Tags and signals', required: 'no', description: 'Who sells the item on the listing: the retailer itself or a marketplace seller.' },
  { field: 'availability', label: 'Availability', group: 'Other', required: 'no', description: 'In stock, limited, out of stock or unknown.' },
  { field: 'product_url', label: 'Product URL', group: 'Other', required: 'no', description: 'URL where the price was seen.' },
  { field: 'confidence', label: 'Confidence', group: 'Other', required: 'no', description: 'Evidence confidence: 0–1, 0–100 or high / medium / low.' },
  { field: 'note', label: 'Note', group: 'Other', required: 'no', description: 'Free-text note stored with the observation.' },
];

export const PRODUCT_FIELDS: ImportFieldInfo[] = [
  { field: 'product_code', label: 'Product code', group: 'Identity', required: 'no', description: 'Existing product ID (PRD-…). Only used to update existing products.' },
  { field: 'name', label: 'Product name', group: 'Identity', required: 'yes', description: 'Name of the product.' },
  { field: 'brand', label: 'Brand', group: 'Identity', required: 'yes', description: 'Brand name. Must exist unless "create missing brands" is enabled.' },
  { field: 'ownership', label: 'Brand ownership', group: 'Identity', required: 'conditional', description: 'Own brand or competitor. Needed when a brand has to be created.' },
  { field: 'category', label: 'Category', group: 'Classification', required: 'yes', description: 'Top-level category.' },
  { field: 'subcategory', label: 'Subcategory', group: 'Classification', required: 'no', description: 'Subcategory within the category.' },
  { field: 'product_line', label: 'Product line', group: 'Classification', required: 'no', description: 'Range / line used to group pack sizes.' },
  { field: 'sku', label: 'SKU', group: 'Identity', required: 'no', description: 'Your internal SKU (unique).' },
  { field: 'gtin', label: 'Barcode / GTIN', group: 'Identity', required: 'no', description: 'Barcode, 8–14 digits (unique).' },
  { field: 'pack_size', label: 'Pack size', group: 'Pack', required: 'no', description: 'Numeric size, or size with unit such as "200ml" or "2x150g".' },
  { field: 'pack_unit', label: 'Pack unit', group: 'Pack', required: 'no', description: 'ml, l, g, kg or unit.' },
  { field: 'units_per_pack', label: 'Units per pack', group: 'Pack', required: 'no', description: 'Number of units in a multi-pack (default 1).' },
  { field: 'image_url', label: 'Image URL', group: 'Other', required: 'no', description: 'Link to a product image.' },
  { field: 'description', label: 'Description', group: 'Other', required: 'no', description: 'Free-text description.' },
  { field: 'markets', label: 'Markets', group: 'Other', required: 'no', description: 'Market codes or names where the product is sold, separated by | or ;' },
  { field: 'status', label: 'Status', group: 'Other', required: 'no', description: 'active, inactive or archived (default active).' },
];

const OBSERVATION_SYNONYMS: Record<string, string[]> = {
  listing_code: ['listingcode', 'listingid', 'listing'],
  retailer: ['retailer', 'retailername', 'store', 'storename', 'shop', 'banner', 'chain', 'account', 'customer', 'website', 'site', 'source'],
  market: ['market', 'marketcode', 'country', 'countrycode'],
  listing_external_id: ['retaileritemid', 'listingexternalid', 'externalid', 'retailersku', 'retailerid', 'itemid', 'retailerproductid', 'retaileritemcode', 'asin'],
  listing_url: ['listingurl', 'listinglink'],
  product_code: ['productcode', 'productid', 'prdcode'],
  sku: ['sku', 'skucode', 'itemcode', 'materialcode', 'article', 'articlecode', 'internalsku'],
  gtin: ['gtin', 'barcode', 'barcodegtin', 'gtinbarcode', 'ean', 'ean13', 'upc'],
  observed_at: ['observedat', 'observedatutc', 'observedatdateandtime', 'timestamp', 'datetime', 'dateandtime', 'observationtimestamp', 'capturedat', 'scrapedat', 'checkedat'],
  observed_date: ['observationdate', 'observeddate', 'date', 'pricedate', 'day', 'capturedate', 'checkdate'],
  observed_time: ['observationtime', 'observedtime', 'time'],
  regular_price: ['regularprice', 'listprice', 'rrp', 'wasprice', 'originalprice', 'mrp', 'fullprice', 'baseprice', 'regularlistedprice', 'shelfprice', 'normalprice'],
  current_price: ['currentprice', 'sellingprice', 'currentsellingprice', 'price', 'nowprice', 'finalprice', 'actualprice'],
  promo_price: ['promoprice', 'promotionalprice', 'offerprice', 'saleprice', 'discountedprice', 'specialprice', 'dealprice'],
  discount_pct: ['discount%', 'discountpct', 'discountpercent', 'discountpercentage', 'discount', '%off', 'percentoff', 'pctoff'],
  currency: ['currency', 'currencycode', 'ccy'],
  on_promotion: ['onpromotion', 'ispromo', 'onpromo', 'promoflag', 'onoffer', 'promotionflag'],
  promo_type: ['promotype', 'promotiontype', 'offertype', 'mechanic', 'promomechanic', 'promotionmechanic'],
  promo_description: ['promodescription', 'promotiondescription', 'offerdescription', 'promotext', 'promotiontext', 'offertext', 'promotion', 'promo', 'offer'],
  promo_starts_on: ['promostartson', 'promostart', 'promostartdate', 'promotionstart', 'promotionstartdate', 'offerstart', 'offerstartdate'],
  promo_ends_on: ['promoendson', 'promoend', 'promoenddate', 'promotionend', 'promotionenddate', 'offerend', 'offerenddate', 'validuntil', 'validto'],
  availability: ['availability', 'stockstatus', 'stock', 'instock', 'available', 'availabilitystatus'],
  product_url: ['producturl', 'observedurl', 'pageurl', 'productlink', 'productpageurl'],
  confidence: ['confidence', 'extractionconfidence', 'confidencescore', 'evidenceconfidence'],
  note: ['note', 'notes', 'comment', 'comments', 'remark', 'remarks'],
  tags: ['tags', 'tag', 'dealtags', 'dealtag', 'badges', 'badge', 'dealbadge', 'dealbadges', 'deallabel', 'labels'],
  tag_text: ['tagtext', 'tagwording', 'badgetext', 'dealtext', 'dealtagtext', 'retailertag', 'taglabel'],
  rating: ['rating', 'ratings', 'starrating', 'stars', 'averagerating', 'avgrating', 'customerrating', 'productrating', 'reviewrating'],
  review_count: ['reviews', 'reviewcount', 'reviewscount', 'numberofreviews', 'noofreviews', 'totalreviews', 'ratingcount', 'ratingscount', 'numberofratings'],
  sales_rank: ['salesrank', 'rank', 'ranking', 'bestsellerrank', 'bestsellersrank', 'bsr', 'categoryrank'],
  sales_rank_label: ['salesranklabel', 'ranklabel', 'ranktext', 'rankcategory', 'salesranktext', 'salesrankcategory'],
  seller_name: ['seller', 'sellername', 'soldby', 'merchant', 'merchantname', 'vendor', 'vendorname'],
};

const PRODUCT_SYNONYMS: Record<string, string[]> = {
  product_code: ['productcode', 'productid', 'prdcode'],
  name: ['productname', 'name', 'product', 'title', 'itemname', 'producttitle', 'skuname', 'skudescription'],
  brand: ['brand', 'brandname'],
  ownership: ['brandownership', 'ownership', 'owncompetitor', 'brandtype'],
  category: ['category', 'productcategory', 'categoryname'],
  subcategory: ['subcategory', 'productsubcategory', 'subcategoryname', 'segment'],
  product_line: ['productline', 'productrange', 'range', 'line', 'family', 'subbrand'],
  sku: ['sku', 'skucode', 'itemcode', 'materialcode', 'article', 'articlecode', 'internalsku'],
  gtin: ['gtin', 'barcode', 'barcodegtin', 'gtinbarcode', 'ean', 'ean13', 'upc'],
  pack_size: ['packsize', 'size', 'netcontent', 'netweight', 'netvolume', 'volume', 'weight', 'pack'],
  pack_unit: ['packunit', 'packsizeunit', 'sizeunit', 'unit', 'uom', 'unitofmeasure'],
  units_per_pack: ['unitsperpack', 'unitsinpack', 'packcount', 'packquantity', 'piecesperpack', 'qtyperpack', 'multipack'],
  image_url: ['imageurl', 'productimage', 'image', 'picture', 'imagelink'],
  description: ['description', 'productdescription', 'details'],
  markets: ['markets', 'marketavailability', 'availablemarkets', 'countries', 'market'],
  status: ['status', 'productstatus'],
};

const normHeader = (header: string) => header.toLowerCase().replace(/[^a-z0-9%]/g, '');

export function fieldsFor(kind: ImportKind): ImportFieldInfo[] {
  return kind === 'observations' ? OBSERVATION_FIELDS : PRODUCT_FIELDS;
}

/** Guesses field → header from the column names (also recognises the headers of our own exports and templates). */
export function suggestMapping(kind: ImportKind, headers: string[]): { mapping: Record<string, string>; options: Record<string, unknown> } {
  const synonyms = kind === 'observations' ? OBSERVATION_SYNONYMS : PRODUCT_SYNONYMS;
  const byNorm = new Map<string, string>();
  for (const header of headers) {
    const key = normHeader(header);
    if (key && !byNorm.has(key)) byNorm.set(key, header);
  }
  const mapping: Record<string, string> = {};
  const used = new Set<string>();
  for (const [field, names] of Object.entries(synonyms)) {
    for (const name of names) {
      const header = byNorm.get(name);
      if (header && !used.has(header)) {
        mapping[field] = header;
        used.add(header);
        break;
      }
    }
  }
  const options: Record<string, unknown> = {};
  if (kind === 'observations') {
    // A bare "URL" / "Link" column identifies the listing when nothing else does; otherwise it is the observed page.
    const generic = byNorm.get('url') ?? byNorm.get('link');
    if (generic && !used.has(generic)) {
      const identified = ['listing_code', 'listing_external_id', 'listing_url', 'product_code', 'sku', 'gtin'].some((f) => mapping[f]);
      const target = identified ? 'product_url' : 'listing_url';
      if (!mapping[target]) mapping[target] = generic;
    }
    const stampHeader = mapping.observed_at ?? mapping.observed_date;
    if (stampHeader && /\b(utc|gmt)\b/i.test(stampHeader)) options.timezone_mode = 'utc';
  }
  return { mapping, options };
}

// ---------------------------------------------------------------------------------------------
// Batch storage
// ---------------------------------------------------------------------------------------------
interface BatchRow {
  id: number;
  kind: ImportKind;
  file_name: string;
  stored_path: string | null;
  sha256: string | null;
  size_bytes: number | null;
  status: ImportBatch['status'];
  mapping: string;
  options: string;
  row_count: number;
  valid_count: number;
  inserted_count: number;
  duplicate_count: number;
  error_count: number;
  errors: string;
  evidence_id: number | null;
  created_by: number | null;
  created_by_name: string | null;
  created_at: string;
  committed_at: string | null;
  voided_by: number | null;
  voided_by_name: string | null;
  voided_at: string | null;
  void_reason: string | null;
  is_demo: 0 | 1;
}

const BATCH_SELECT = `SELECT b.*, cu.name AS created_by_name, vu.name AS voided_by_name
  FROM import_batches b LEFT JOIN users cu ON cu.id = b.created_by LEFT JOIN users vu ON vu.id = b.voided_by`;

function safeJson<T>(text: string, fallback: T): T {
  try {
    const value = JSON.parse(text) as T;
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function toBatch(row: BatchRow): ImportBatch {
  return {
    id: row.id,
    kind: row.kind,
    file_name: row.file_name,
    sha256: row.sha256,
    size_bytes: row.size_bytes,
    status: row.status,
    mapping: safeJson<Record<string, string>>(row.mapping, {}),
    options: safeJson<Record<string, unknown>>(row.options, {}),
    row_count: row.row_count,
    valid_count: row.valid_count,
    inserted_count: row.inserted_count,
    duplicate_count: row.duplicate_count,
    error_count: row.error_count,
    evidence_id: row.evidence_id,
    created_by: row.created_by,
    created_by_name: row.created_by_name,
    created_at: row.created_at,
    committed_at: row.committed_at,
    voided_by: row.voided_by,
    voided_by_name: row.voided_by_name,
    voided_at: row.voided_at,
    void_reason: row.void_reason,
    is_demo: row.is_demo,
  };
}

function batchRow(ctx: AppContext, id: number): BatchRow {
  const row = ctx.db.get<BatchRow>(`${BATCH_SELECT} WHERE b.id = ?`, [id]);
  if (!row) throw notFound('Import');
  return row;
}

export function getBatch(ctx: AppContext, id: number): ImportBatch {
  return toBatch(batchRow(ctx, id));
}

interface StoredReport {
  errors: ImportIssue[];
  error_total: number;
  warnings: ImportIssue[];
  warning_total: number;
  summary: ImportSummary | null;
  result: Record<string, number> | null;
}

function readReport(row: BatchRow): StoredReport {
  const parsed = safeJson<Partial<StoredReport> | ImportIssue[]>(row.errors, []);
  if (Array.isArray(parsed)) return { errors: parsed, error_total: parsed.length, warnings: [], warning_total: 0, summary: null, result: null };
  return {
    errors: parsed.errors ?? [],
    error_total: parsed.error_total ?? parsed.errors?.length ?? 0,
    warnings: parsed.warnings ?? [],
    warning_total: parsed.warning_total ?? parsed.warnings?.length ?? 0,
    summary: parsed.summary ?? null,
    result: parsed.result ?? null,
  };
}

export function getBatchDetail(ctx: AppContext, id: number) {
  const row = batchRow(ctx, id);
  return { batch: toBatch(row), ...readReport(row) };
}

export function listBatches(ctx: AppContext, filter: { kind?: ImportKind; status?: string; limit: number; offset: number }) {
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (filter.kind) {
    conditions.push('b.kind = ?');
    params.push(filter.kind);
  }
  if (filter.status) {
    conditions.push('b.status = ?');
    params.push(filter.status);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = ctx.db.scalar<number>(`SELECT COUNT(*) FROM import_batches b ${where}`, params) ?? 0;
  const rows = ctx.db
    .all<BatchRow>(`${BATCH_SELECT} ${where} ORDER BY b.id DESC LIMIT ? OFFSET ?`, [...params, filter.limit, filter.offset])
    .map(toBatch);
  return { rows, total };
}

type FileFormat = 'csv' | 'xlsx';

function detectFormat(fileName: string, buffer: Buffer): FileFormat {
  const extension = path.extname(fileName).toLowerCase();
  const zip = buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
  const ole = buffer.length > 8 && buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0;
  if (ole || extension === '.xls') {
    throw unprocessable('Old Excel workbooks (.xls) are not supported. Save the file as "Excel Workbook (.xlsx)" or CSV and upload it again.');
  }
  if (zip || extension === '.xlsx' || extension === '.xlsm') {
    if (!zip) throw unprocessable('The file has an Excel extension but is not a valid .xlsx workbook.');
    return 'xlsx';
  }
  if (['.csv', '.txt', '.tsv', ''].includes(extension)) {
    if (buffer.includes(0) && !(buffer[0] === 0xff && buffer[1] === 0xfe) && !(buffer[0] === 0xfe && buffer[1] === 0xff)) {
      throw unprocessable('The file does not look like a text CSV file.');
    }
    return 'csv';
  }
  throw unprocessable('Unsupported file type. Upload a CSV (.csv) or Excel (.xlsx) file.');
}

interface LoadedTable extends TabularData {
  format: FileFormat;
  sheets: string[];
  sheet: string | null;
}

async function loadTable(fileName: string, buffer: Buffer, sheet?: string | null): Promise<LoadedTable> {
  const format = detectFormat(fileName, buffer);
  let table: LoadedTable;
  try {
    if (format === 'xlsx') {
      const data = await parseXlsx(buffer, sheet);
      table = { ...data, format };
    } else {
      table = { ...parseCsv(buffer), format, sheets: [], sheet: null };
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw unprocessable((err as Error).message);
  }
  if (table.headers.length === 0) throw unprocessable('The file is empty: no header row was found.');
  if (table.rows.length > IMPORT_MAX_ROWS) {
    throw unprocessable(`The file has ${table.rows.length.toLocaleString('en-US')} data rows; the limit per import is ${IMPORT_MAX_ROWS.toLocaleString('en-US')}. Split it into several files.`);
  }
  return table;
}

function readStoredFile(ctx: AppContext, row: BatchRow): Buffer {
  if (!row.stored_path) throw conflict('The original file of this import is no longer available. Upload it again.');
  const absolute = path.resolve(ctx.config.dataDir, row.stored_path);
  if (!absolute.startsWith(path.resolve(ctx.config.importDir) + path.sep) || !fs.existsSync(absolute)) {
    throw conflict('The original file of this import is no longer available. Upload it again.');
  }
  return fs.readFileSync(absolute);
}

const cleanFileName = (name: string) => path.basename(name).replace(/[^\w.\- ()]+/g, '_').slice(0, 120) || 'import';

export async function stageImport(
  ctx: AppContext,
  input: { kind: ImportKind; fileName: string; buffer: Buffer; sheet?: string | null; user: AuthUser; ip?: string },
): Promise<ImportStageResponse> {
  if (input.buffer.length === 0) throw unprocessable('The uploaded file is empty.');
  const table = await loadTable(input.fileName, input.buffer, input.sheet);
  const sha = sha256Hex(input.buffer);
  const fileName = cleanFileName(input.fileName);
  fs.mkdirSync(ctx.config.importDir, { recursive: true });
  const absolute = path.join(ctx.config.importDir, `${Date.now()}-${sha.slice(0, 12)}-${fileName}`);
  fs.writeFileSync(absolute, input.buffer, { mode: 0o640 });
  const storedPath = path.relative(ctx.config.dataDir, absolute);
  const suggestion = suggestMapping(input.kind, table.headers);
  const now = nowIso();
  const batchId = ctx.db.tx(() => {
    const evidenceId = ctx.db.run(
      `INSERT INTO source_evidence (kind, reference, file_path, file_name, mime_type, size_bytes, sha256, uploaded_by, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        table.format === 'csv' ? 'csv_file' : 'document',
        fileName,
        storedPath,
        fileName,
        table.format === 'csv' ? 'text/csv; charset=utf-8' : XLSX_MIME,
        input.buffer.length,
        sha,
        input.user.id,
        `Original file of a ${input.kind === 'observations' ? 'price history' : 'product'} import`,
        now,
      ],
    ).lastInsertRowid;
    return ctx.db.run(
      `INSERT INTO import_batches (kind, file_name, stored_path, sha256, size_bytes, status, mapping, options, row_count, evidence_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'staged', ?, ?, ?, ?, ?, ?)`,
      [
        input.kind,
        fileName,
        storedPath,
        sha,
        input.buffer.length,
        JSON.stringify(suggestion.mapping),
        JSON.stringify({ ...suggestion.options, sheet: table.sheet }),
        table.rows.length,
        evidenceId,
        input.user.id,
        now,
      ],
    ).lastInsertRowid;
  });
  audit(ctx, input.user, 'import.stage', 'import_batch', batchId, { kind: input.kind, file_name: fileName, rows: table.rows.length, sha256: sha }, input.ip);
  return {
    batch: getBatch(ctx, batchId),
    headers: table.headers,
    sample_rows: table.rows.slice(0, PREVIEW_ROWS),
    row_count: table.rows.length,
    suggested_mapping: suggestion.mapping,
    suggested_options: suggestion.options,
    fields: fieldsFor(input.kind),
    sheets: table.sheets,
    sheet: table.sheet,
  };
}

/** Re-reads the staged file (optionally another worksheet) and returns its columns again. */
export async function describeStagedFile(ctx: AppContext, batchId: number, sheet?: string | null): Promise<ImportStageResponse> {
  const row = batchRow(ctx, batchId);
  if (row.status === 'committed' || row.status === 'voided') throw conflict('This import has already been committed.');
  const stored = safeJson<Record<string, unknown>>(row.options, {});
  const table = await loadTable(row.file_name, readStoredFile(ctx, row), sheet ?? (stored.sheet as string | null | undefined));
  const suggestion = suggestMapping(row.kind, table.headers);
  if (sheet && table.sheet !== stored.sheet) {
    ctx.db.run('UPDATE import_batches SET options = ?, mapping = ?, row_count = ?, status = ? WHERE id = ?', [
      JSON.stringify({ ...suggestion.options, sheet: table.sheet }),
      JSON.stringify(suggestion.mapping),
      table.rows.length,
      'staged',
      batchId,
    ]);
  }
  return {
    batch: getBatch(ctx, batchId),
    headers: table.headers,
    sample_rows: table.rows.slice(0, PREVIEW_ROWS),
    row_count: table.rows.length,
    suggested_mapping: suggestion.mapping,
    suggested_options: suggestion.options,
    fields: fieldsFor(row.kind),
    sheets: table.sheets,
    sheet: table.sheet,
  };
}

// ---------------------------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------------------------
type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = (error: string): Parsed<never> => ({ ok: false, error });

/** "AED 1,250.50", "12,50 €", "KSh 1 250" → number. Blank → null. */
export function parsePrice(text: string, decimalComma: boolean): Parsed<number | null> {
  const raw = text.trim();
  if (!raw) return ok(null);
  if (/^(n\/?a|na|null|none|-|–|—)$/i.test(raw)) return ok(null);
  let s = raw.replace(/[^\d.,-]/g, '');
  if (!/\d/.test(s)) return fail(`"${raw}" is not a price`);
  const negative = s.startsWith('-');
  s = s.replace(/-/g, '').replace(/^[.,]+|[.,]+$/g, '');
  if (!s) return fail(`"${raw}" is not a price`);
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  const digitsAfter = (index: number) => s.length - index - 1;
  let decimalSeparator: ',' | '.' | null;
  if (lastComma >= 0 && lastDot >= 0) {
    decimalSeparator = lastComma > lastDot ? ',' : '.';
  } else if (lastComma >= 0) {
    // A single comma followed by one or two digits can only be a decimal comma; three digits follow the option.
    const single = s.indexOf(',') === lastComma;
    decimalSeparator = single && digitsAfter(lastComma) !== 3 ? ',' : decimalComma && single ? ',' : null;
  } else if (lastDot >= 0) {
    const single = s.indexOf('.') === lastDot;
    decimalSeparator = !single ? null : decimalComma && digitsAfter(lastDot) === 3 ? null : '.';
  } else {
    decimalSeparator = null;
  }
  let normalised: string;
  if (decimalSeparator === ',') normalised = s.replace(/\./g, '').replace(',', '.');
  else if (decimalSeparator === '.') normalised = s.replace(/,/g, '');
  else normalised = s.replace(/[.,]/g, '');
  const value = Number(normalised);
  if (!Number.isFinite(value)) return fail(`"${raw}" is not a price`);
  return ok(negative ? -value : value);
}

export function parsePercent(text: string): Parsed<number | null> {
  const raw = text.trim();
  if (!raw || /^(n\/?a|na|-|–|—)$/i.test(raw)) return ok(null);
  const hasSign = raw.includes('%');
  const value = Number(raw.replace(/%/g, '').replace(/\s/g, '').replace(',', '.').replace(/^-/, ''));
  if (!Number.isFinite(value)) return fail(`"${raw}" is not a percentage`);
  // A bare fraction such as 0.2 means 20 % (how Excel stores percentages).
  return ok(!hasSign && value > 0 && value < 1 ? Number((value * 100).toPrecision(10)) : value);
}

export function parseConfidence(text: string): Parsed<number | null> {
  const raw = text.trim().toLowerCase();
  if (!raw) return ok(null);
  if (['high', 'h', 'verified', 'certain'].includes(raw)) return ok(0.9);
  if (['medium', 'med', 'm', 'moderate'].includes(raw)) return ok(0.7);
  if (['low', 'l', 'uncertain'].includes(raw)) return ok(0.4);
  const percent = raw.includes('%');
  const value = Number(raw.replace(/%/g, '').replace(',', '.'));
  if (!Number.isFinite(value) || value < 0 || value > 100) return fail(`"${text.trim()}" is not a confidence value (use 0–1, 0–100 or high / medium / low)`);
  return ok(percent || value > 1 ? value / 100 : value);
}

const TRUE_WORDS = new Set(['yes', 'y', 'true', 't', '1', 'x', 'promo', 'on promotion', 'on offer']);
const FALSE_WORDS = new Set(['no', 'n', 'false', 'f', '0', 'none', 'regular']);

export function parseFlag(text: string): Parsed<boolean | null> {
  const raw = text.trim().toLowerCase();
  if (!raw) return ok(null);
  if (TRUE_WORDS.has(raw)) return ok(true);
  if (FALSE_WORDS.has(raw)) return ok(false);
  return fail(`"${text.trim()}" is not a yes / no value`);
}

const AVAILABILITY_WORDS: Record<string, Availability> = {
  in_stock: 'in_stock', instock: 'in_stock', 'in stock': 'in_stock', available: 'in_stock', yes: 'in_stock', y: 'in_stock', true: 'in_stock', '1': 'in_stock', stocked: 'in_stock', 'on shelf': 'in_stock',
  limited: 'limited', 'limited stock': 'limited', 'low stock': 'limited', 'few left': 'limited', limited_stock: 'limited', 'low': 'limited',
  out_of_stock: 'out_of_stock', outofstock: 'out_of_stock', 'out of stock': 'out_of_stock', oos: 'out_of_stock', unavailable: 'out_of_stock', 'sold out': 'out_of_stock', 'not available': 'out_of_stock', no: 'out_of_stock', n: 'out_of_stock', false: 'out_of_stock', '0': 'out_of_stock',
  unknown: 'unknown', 'n/a': 'unknown', na: 'unknown', '?': 'unknown',
};

export function parseAvailability(text: string, fallback: Availability): Parsed<Availability> {
  const raw = text.trim().toLowerCase();
  if (!raw) return ok(fallback);
  const value = AVAILABILITY_WORDS[raw] ?? AVAILABILITY_WORDS[raw.replace(/[-_]/g, ' ')];
  return value ? ok(value) : fail(`"${text.trim()}" is not a known availability (use in stock, limited, out of stock or unknown)`);
}

export function parsePromoType(text: string): PromoType | null {
  const raw = text.trim().toLowerCase().replace(/[-_]/g, ' ');
  if (!raw) return null;
  if (/price ?cut|discount|markdown|mark down|reduction|sale|% ?off|save/.test(raw)) return 'price_cut';
  if (/multi ?buy|bogo|buy \d|for \d|\d for|b\dg\d/.test(raw)) return 'multi_buy';
  if (/bundle|gift|free|combo|pack offer/.test(raw)) return 'bundle';
  if (/coupon|voucher|code/.test(raw)) return 'coupon';
  return 'other';
}

const BLANK_WORDS = /^(n\/?a|na|null|none|-|–|—)$/i;

/** "4.5", "4,5", "4.5/5", "4.5 out of 5", "4.5 stars" → 4.5. Blank → null. */
export function parseRating(text: string): Parsed<number | null> {
  const raw = text.trim();
  if (!raw || BLANK_WORDS.test(raw)) return ok(null);
  const m = /^(\d+(?:[.,]\d+)?)\s*(?:\/\s*5|(?:out\s+)?of\s+5|stars?|★)?$/i.exec(raw);
  const value = m ? Number(m[1]!.replace(',', '.')) : Number.NaN;
  if (!Number.isFinite(value) || value < 0 || value > 5) return fail(`"${raw}" is not a rating (use a number from 0 to 5, e.g. 4.5)`);
  return ok(value);
}

/** "1280", "1,280", "(1 280)", "1,280 ratings", "1.2K" → whole number. Blank → null. */
export function parseCount(text: string, what: string): Parsed<number | null> {
  const raw = text.trim();
  if (!raw || BLANK_WORDS.test(raw)) return ok(null);
  const m = /^\(?\s*([\d.,\s\u00A0']+?)\s*([km])?\+?\s*\)?\s*(?:(?:global\s+)?(?:ratings?|reviews?))?$/i.exec(raw);
  if (m) {
    const digits = m[1]!.trim();
    const suffix = m[2]?.toLowerCase();
    let value = Number.NaN;
    if (suffix) value = Math.round(Number(digits.replace(/[\s\u00A0']/g, '').replace(',', '.')) * (suffix === 'k' ? 1_000 : 1_000_000));
    else if (/^\d+$/.test(digits)) value = Number(digits);
    else if (/^\d{1,3}(?:[.,\s\u00A0']\d{3})+$/.test(digits)) value = Number(digits.replace(/\D/g, ''));
    else if (/^\d+[.,]0+$/.test(digits)) value = Number(digits.split(/[.,]/)[0]);
    if (Number.isSafeInteger(value) && value >= 0) return ok(value);
  }
  return fail(`"${raw}" is not a ${what} (use a whole number, e.g. 1280)`);
}

/** "3", "#3", "#3 in Shampoos" → the position, plus the full wording as the label when it says more than the number. */
export function parseSalesRank(text: string): Parsed<{ rank: number | null; label: string | null }> {
  const raw = text.trim();
  if (!raw || BLANK_WORDS.test(raw)) return ok({ rank: null, label: null });
  const m = /^(?:#|no\.?\s*|rank\s*#?)?\s*(\d{1,3}(?:[,\s\u00A0]\d{3})+|\d+)(?:\.0+)?(?![\d.,])\s*(.*)$/i.exec(raw);
  if (!m) return fail(`"${raw}" is not a sales rank (use a whole number such as 3, or wording such as "#3 in Shampoos")`);
  return ok({ rank: Number(m[1]!.replace(/\D/g, '')), label: m[2]!.trim() ? raw : null });
}

/** Entries of a "Tags" cell: separated by ; or | or line breaks, or a JSON list. Commas only separate exact keys / labels. */
function splitTagCell(text: string): string[] {
  const raw = text.trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((entry) => String(entry).trim()).filter(Boolean);
    } catch {
      // not JSON: read as plain wording
    }
  }
  return raw
    .split(/[|;\r\n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => {
      const pieces = part.split(',').map((piece) => piece.trim()).filter(Boolean);
      return pieces.length > 1 && pieces.every((piece) => dealTagFromLabel(piece)) ? pieces : [part];
    });
}

/**
 * Reads the "Tags" and "Tag text" cells of a row. Tag keys and labels (as written by our own exports) are taken
 * as they are; any other wording goes through normaliseDealTags and is kept as the tag text, so wording that is
 * not recognised ends up as "Other tag" with the retailer's words preserved. A plain price cut is not a tag.
 */
export function parseTagCells(tagsCell: string, tagTextCell: string): { tags: DealTag[]; tag_text: string | null } {
  const entries = splitTagCell(tagsCell);
  const tags = new Set<DealTag>();
  const recognised: string[] = [];
  const unrecognised: string[] = [];
  let namedOther = false;
  for (const entry of entries) {
    const key = dealTagFromLabel(entry);
    if (key) {
      tags.add(key);
      if (key === 'other') namedOther = true;
      continue;
    }
    const derived = normaliseDealTags([entry]);
    if (derived.length === 0) continue; // a plain price cut is not a tag
    if (derived.length === 1 && derived[0] === 'other') unrecognised.push(entry);
    else recognised.push(entry);
    for (const tag of derived) tags.add(tag);
  }
  let tagText = tagTextCell.trim() || null;
  if (entries.length === 0 && tagText) for (const tag of normaliseDealTags([tagText])) tags.add(tag);
  // "Other tag" only says that nothing was recognised: next to a recognised tag it adds nothing.
  if (tags.size > 1 && !namedOther) tags.delete('other');
  if (!tagText) {
    const kept = tags.has('other') ? [...recognised, ...unrecognised] : recognised;
    if (kept.length) tagText = kept.join('; ');
  }
  return { tags: sortDealTags(tags), tag_text: tagText };
}

/** Like parseTimestamp, but honours the UTC option and keeps fractional seconds of naive timestamps. */
export function parseImportTimestamp(text: string, timeZone: string, order: DateOrder, mode: 'market' | 'utc'): ParsedTimestamp | null {
  const value = text.trim();
  const parsed = parseTimestamp(value, mode === 'utc' ? 'UTC' : timeZone, order);
  if (!parsed) return null;
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/i.test(value);
  if (!hasOffset && parsed.basis === 'exact') {
    const fraction = /:\d{2}\.(\d{1,3})\d*\s*(am|pm)?$/i.exec(value);
    if (fraction) {
      const ms = Number(fraction[1]!.padEnd(3, '0'));
      return { utc: new Date(Date.parse(parsed.utc) + ms).toISOString(), basis: 'exact' };
    }
  }
  return parsed;
}

function parseDateOnly(text: string, order: DateOrder): Parsed<string | null> {
  const raw = text.trim();
  if (!raw) return ok(null);
  const parsed = parseTimestamp(raw, 'UTC', order);
  if (!parsed) return fail(`"${raw}" is not a recognisable date`);
  return ok(parsed.utc.slice(0, 10));
}

const AMBIGUOUS_DATE = /^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/;

function dateProblem(text: string, order: DateOrder): string {
  const m = AMBIGUOUS_DATE.exec(text.trim());
  if (m && order === 'auto' && Number(m[1]) <= 12 && Number(m[2]) <= 12 && m[1] !== m[2]) {
    return `Date "${text.trim()}" is ambiguous (day/month or month/day?). Choose the date order in the import options.`;
  }
  return `"${text.trim()}" is not a recognisable date/time (use e.g. 2026-03-14 or 14/03/2026 09:30)`;
}

// ---------------------------------------------------------------------------------------------
// Observation import
// ---------------------------------------------------------------------------------------------
export const DEFAULT_OBSERVATION_OPTIONS: ObservationImportOptions = {
  date_order: 'auto',
  timezone_mode: 'market',
  default_confidence: 0.7,
  default_availability: 'unknown',
  decimal_comma: false,
  evidence_kind: 'csv_file',
  evidence_note: null,
  allow_missing_dates: false,
  create_missing_listings: false,
  sheet: null,
};

export const DEFAULT_PRODUCT_OPTIONS: ProductImportOptions = {
  update_existing: false,
  create_missing_brands: false,
  create_missing_categories: false,
  sheet: null,
};

interface RetailerRef {
  id: number;
  name: string;
  market_id: number;
  market_code: string;
  market_name: string;
  country_name: string;
  currency_code: string;
  timezone: string;
  is_demo: number;
}

interface ProductRef {
  id: number;
  code: string;
  name: string;
}

interface ListingRef {
  /** Negative while the listing is only planned (create_missing_listings). */
  id: number;
  code: string | null;
  retailer_id: number;
  retailer_name: string;
  market_id: number;
  market_code: string;
  market_name: string;
  currency_code: string;
  timezone: string;
  is_demo: number;
  product_id: number | null;
  product_name: string | null;
  is_active: number;
}

interface PendingListing {
  tempId: number;
  retailer: RetailerRef;
  product: ProductRef;
  external_id: string | null;
  url: string | null;
}

const LISTING_SELECT = `SELECT l.id, l.code, l.retailer_id, r.name AS retailer_name, r.market_id, m.code AS market_code,
  m.name AS market_name, r.currency_code, m.timezone, l.is_demo, l.product_id, p.name AS product_name, l.is_active
  FROM retailer_listings l JOIN retailers r ON r.id = l.retailer_id JOIN markets m ON m.id = r.market_id
  LEFT JOIN products p ON p.id = l.product_id`;

/** Memoised look-ups so a file with 100,000 rows issues a handful of distinct queries. */
class Resolver {
  private readonly ctx: AppContext;
  private readonly cache = new Map<string, unknown>();

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  private memo<T>(key: string, load: () => T): T {
    if (!this.cache.has(key)) this.cache.set(key, load());
    return this.cache.get(key) as T;
  }

  retailers(name: string): RetailerRef[] {
    return this.memo(`r:${name.toLowerCase()}`, () =>
      this.ctx.db.all<RetailerRef>(
        `SELECT r.id, r.name, r.market_id, m.code AS market_code, m.name AS market_name, m.country_name, r.currency_code, m.timezone, r.is_demo
         FROM retailers r JOIN markets m ON m.id = r.market_id WHERE r.name = ? COLLATE NOCASE ORDER BY r.id`,
        [name],
      ),
    );
  }

  listingByCode(code: string): ListingRef | undefined {
    return this.memo(`lc:${code.toUpperCase()}`, () => this.ctx.db.get<ListingRef>(`${LISTING_SELECT} WHERE l.code = ? COLLATE NOCASE`, [code]));
  }

  listingByExternalId(retailerId: number, externalId: string): ListingRef | undefined {
    return this.memo(`le:${retailerId}:${externalId}`, () =>
      this.ctx.db.get<ListingRef>(`${LISTING_SELECT} WHERE l.retailer_id = ? AND l.external_id = ?`, [retailerId, externalId]),
    );
  }

  listingByUrl(retailerId: number, url: string): ListingRef | undefined {
    return this.memo(`lu:${retailerId}:${url}`, () =>
      this.ctx.db.get<ListingRef>(`${LISTING_SELECT} WHERE l.retailer_id = ? AND l.url = ?`, [retailerId, url]),
    );
  }

  listingsForProduct(retailerId: number, productId: number): ListingRef[] {
    return this.memo(`lp:${retailerId}:${productId}`, () =>
      this.ctx.db.all<ListingRef>(`${LISTING_SELECT} WHERE l.retailer_id = ? AND l.product_id = ? ORDER BY l.is_active DESC, l.id`, [retailerId, productId]),
    );
  }

  product(kind: 'code' | 'sku' | 'gtin', value: string): ProductRef | undefined {
    return this.memo(`p:${kind}:${value.toLowerCase()}`, () =>
      this.ctx.db.get<ProductRef>(`SELECT id, code, name FROM products WHERE ${kind} = ?${kind === 'code' ? ' COLLATE NOCASE' : ''}`, [value]),
    );
  }
}

interface AnalysedObservation {
  row: number;
  listing: ListingRef;
  input: ObservationInput;
  normalised: NormalisedObservation;
  duplicateInFile: boolean;
}

interface ObservationAnalysis {
  rows: AnalysedObservation[];
  pending: Map<string, PendingListing>;
  issues: ImportIssue[];
  warnings: ImportIssue[];
  summary: ImportSummary;
  preview: ObservationImportPreviewRow[];
}

function normaliseObservationOptions(raw: Record<string, unknown> | undefined, mapping: Record<string, string>): ObservationImportOptions {
  const input = raw ?? {};
  const stampHeader = mapping.observed_at ?? mapping.observed_date ?? '';
  const out: ObservationImportOptions = {
    ...DEFAULT_OBSERVATION_OPTIONS,
    // A column that says "UTC" is read as UTC unless the user decides otherwise.
    timezone_mode: /\b(utc|gmt)\b/i.test(stampHeader) ? 'utc' : 'market',
  };
  if (input.date_order === 'auto' || input.date_order === 'dmy' || input.date_order === 'mdy') out.date_order = input.date_order;
  if (input.timezone_mode === 'market' || input.timezone_mode === 'utc') out.timezone_mode = input.timezone_mode;
  if (input.default_confidence !== undefined && input.default_confidence !== null && input.default_confidence !== '') {
    const c = Number(input.default_confidence);
    if (!Number.isFinite(c) || c < 0 || c > 1) throw unprocessable('Default confidence must be between 0 and 1');
    out.default_confidence = c;
  }
  if (typeof input.default_availability === 'string' && (AVAILABILITY as readonly string[]).includes(input.default_availability)) {
    out.default_availability = input.default_availability as Availability;
  }
  out.decimal_comma = input.decimal_comma === true;
  if (input.evidence_kind === 'csv_file' || input.evidence_kind === 'screenshot' || input.evidence_kind === 'document') out.evidence_kind = input.evidence_kind;
  if (typeof input.evidence_note === 'string' && input.evidence_note.trim()) out.evidence_note = input.evidence_note.trim().slice(0, 1000);
  out.allow_missing_dates = input.allow_missing_dates === true;
  out.create_missing_listings = input.create_missing_listings === true;
  if (typeof input.sheet === 'string' && input.sheet.trim()) out.sheet = input.sheet.trim();
  return out;
}

function checkMapping(kind: ImportKind, mapping: Record<string, string>, headers: string[]): Record<string, string> {
  const known = new Set(fieldsFor(kind).map((f) => f.field));
  const available = new Set(headers);
  const clean: Record<string, string> = {};
  for (const [field, header] of Object.entries(mapping ?? {})) {
    if (header === null || header === undefined || header === '') continue;
    if (!known.has(field)) throw unprocessable(`Unknown import field "${field}"`);
    if (typeof header !== 'string' || !available.has(header)) throw unprocessable(`Column "${String(header)}" (mapped to ${field}) does not exist in the file`);
    clean[field] = header;
  }
  return clean;
}

function analyseObservations(
  ctx: AppContext,
  table: TabularData,
  mapping: Record<string, string>,
  options: ObservationImportOptions,
  importTime: string,
): ObservationAnalysis {
  const identifies = ['listing_code', 'listing_external_id', 'listing_url', 'product_code', 'sku', 'gtin'].some((f) => mapping[f]);
  if (!identifies) {
    throw unprocessable('Map at least one column that identifies the listing: a listing code, or the retailer together with a retailer item ID, listing URL, product code, SKU or barcode.');
  }
  if (!mapping.listing_code && !mapping.retailer) throw unprocessable('Map the retailer column (or a listing code column).');
  if (!mapping.current_price && !mapping.regular_price && !mapping.promo_price && !mapping.availability) {
    throw unprocessable('Map at least one price column (current, regular or promo price).');
  }
  if (!mapping.observed_at && !mapping.observed_date && !options.allow_missing_dates) {
    throw unprocessable('Map the observation date column — or enable "allow missing dates" to record rows at the import time (flagged as such).');
  }

  const resolver = new Resolver(ctx);
  const issues: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const rows: AnalysedObservation[] = [];
  const pending = new Map<string, PendingListing>();
  const seenKeys = new Map<string, number>();
  const seenInstants = new Map<string, { key: string; row: number }>();
  let exampleRows = 0;
  let duplicatesInFile = 0;
  const now = Date.now();
  const get = (record: Record<string, string>, field: string) => (mapping[field] ? (record[mapping[field]!] ?? '').trim() : '');

  table.rows.forEach((record, index) => {
    const rowNumber = table.rowNumbers[index] ?? index + 2;
    const problem = (message: string, field?: string) => {
      issues.push({ row: rowNumber, field, message });
    };
    if (Object.values(record).some((value) => value.toUpperCase().startsWith(EXAMPLE_MARKER))) {
      exampleRows++;
      warnings.push({ row: rowNumber, message: 'Template example row ignored' });
      return;
    }

    // ---- which listing ------------------------------------------------------------------
    let listing: ListingRef | undefined;
    const listingCode = get(record, 'listing_code');
    const retailerName = get(record, 'retailer');
    const marketText = get(record, 'market');
    let retailer: RetailerRef | undefined;
    let retailerCandidates: RetailerRef[] = [];
    if (retailerName) {
      const candidates = resolver.retailers(retailerName);
      const m = marketText.toLowerCase();
      retailerCandidates = m
        ? candidates.filter((c) => c.market_code.toLowerCase() === m || c.market_name.toLowerCase() === m || c.country_name.toLowerCase() === m)
        : candidates;
      if (candidates.length === 0) return problem(`Retailer "${retailerName}" is not configured`, 'retailer');
      if (retailerCandidates.length === 0) return problem(`Retailer "${retailerName}" does not exist in market "${marketText}"`, 'market');
      if (retailerCandidates.length === 1) retailer = retailerCandidates[0];
    }
    if (listingCode) {
      // The listing code is decisive; a retailer column is only used as a consistency check.
      listing = resolver.listingByCode(listingCode);
      if (!listing) return problem(`Listing "${listingCode}" does not exist`, 'listing_code');
      if (retailerCandidates.length > 0 && !retailerCandidates.some((c) => c.id === listing!.retailer_id)) {
        const other = retailerCandidates[0]!;
        return problem(`Listing ${listing.code} belongs to ${listing.retailer_name} (${listing.market_code}), not to ${other.name} (${other.market_code})`, 'listing_code');
      }
    } else {
      if (retailerCandidates.length > 1) {
        return problem(
          `Retailer "${retailerName}" exists in several markets (${retailerCandidates.map((c) => c.market_code).join(', ')}); add a market column`,
          'market',
        );
      }
      if (!retailer) return problem('The row names no retailer and no listing code', 'retailer');
      const externalId = get(record, 'listing_external_id');
      const url = get(record, 'listing_url');
      if (externalId) listing = resolver.listingByExternalId(retailer.id, externalId);
      if (!listing && url) listing = resolver.listingByUrl(retailer.id, url);
      if (!listing) {
        const identifiers: Array<['code' | 'sku' | 'gtin', string, string]> = [
          ['code', get(record, 'product_code'), 'product_code'],
          ['sku', get(record, 'sku'), 'sku'],
          ['gtin', get(record, 'gtin').replace(/\s/g, ''), 'gtin'],
        ];
        let product: ProductRef | undefined;
        for (const [kind, value, field] of identifiers) {
          if (!value) continue;
          const found = resolver.product(kind, value);
          if (!found) return problem(`No product with ${field === 'product_code' ? 'product code' : field.toUpperCase()} "${value}"`, field);
          if (product && product.id !== found.id) {
            return problem(`The product identifiers disagree: ${product.code} vs ${found.code}`, field);
          }
          product = found;
        }
        if (!product) {
          if (externalId) return problem(`No listing at ${retailer.name} with retailer item ID "${externalId}"`, 'listing_external_id');
          if (url) return problem(`No listing at ${retailer.name} with URL "${url}"`, 'listing_url');
          return problem('The row does not identify a listing (need a retailer item ID, listing URL, product code, SKU or barcode)');
        }
        const candidates = resolver.listingsForProduct(retailer.id, product.id);
        const active = candidates.filter((c) => c.is_active);
        if (active.length === 1 || (active.length === 0 && candidates.length === 1)) {
          listing = active[0] ?? candidates[0];
        } else if (candidates.length > 1) {
          return problem(
            `${product.name} has ${candidates.length} listings at ${retailer.name} (${candidates.map((c) => c.code).join(', ')}); use the listing code to say which one`,
          );
        } else if (options.create_missing_listings) {
          const key = `${retailer.id}:${product.id}`;
          let planned = pending.get(key);
          if (!planned) {
            planned = { tempId: -(pending.size + 1), retailer, product, external_id: externalId || null, url: url || null };
            pending.set(key, planned);
          }
          listing = {
            id: planned.tempId,
            code: null,
            retailer_id: retailer.id,
            retailer_name: retailer.name,
            market_id: retailer.market_id,
            market_code: retailer.market_code,
            market_name: retailer.market_name,
            currency_code: retailer.currency_code,
            timezone: retailer.timezone,
            is_demo: retailer.is_demo,
            product_id: product.id,
            product_name: product.name,
            is_active: 1,
          };
        } else {
          return problem(`${product.name} is not listed at ${retailer.name}. Add the listing first, or enable "create missing listings".`);
        }
      }
    }
    if (!listing) return problem('The listing could not be determined');

    // ---- when ----------------------------------------------------------------------------
    let observedAt: string;
    let basis: 'exact' | 'date_only' | 'import_time';
    const stampText = get(record, 'observed_at') || [get(record, 'observed_date'), get(record, 'observed_time')].filter(Boolean).join(' ');
    if (!stampText || (!get(record, 'observed_at') && !get(record, 'observed_date'))) {
      if (!options.allow_missing_dates) return problem('The observation date is missing', mapping.observed_at ? 'observed_at' : 'observed_date');
      observedAt = importTime;
      basis = 'import_time';
    } else {
      const parsed = parseImportTimestamp(stampText, listing.timezone, options.date_order, options.timezone_mode);
      if (!parsed) return problem(dateProblem(stampText, options.date_order), mapping.observed_at ? 'observed_at' : 'observed_date');
      observedAt = parsed.utc;
      basis = parsed.basis;
    }

    // ---- prices and the rest ---------------------------------------------------------------
    const numbers: Record<'regular_price' | 'current_price' | 'promo_price', number | null> = { regular_price: null, current_price: null, promo_price: null };
    for (const field of ['regular_price', 'current_price', 'promo_price'] as const) {
      const parsed = parsePrice(get(record, field), options.decimal_comma);
      if (!parsed.ok) return problem(parsed.error, field);
      numbers[field] = parsed.value;
    }
    const discount = parsePercent(get(record, 'discount_pct'));
    if (!discount.ok) return problem(discount.error, 'discount_pct');
    const flag = parseFlag(get(record, 'on_promotion'));
    if (!flag.ok) return problem(flag.error, 'on_promotion');
    const availability = parseAvailability(get(record, 'availability'), options.default_availability);
    if (!availability.ok) return problem(availability.error, 'availability');
    const confidence = parseConfidence(get(record, 'confidence'));
    if (!confidence.ok) return problem(confidence.error, 'confidence');
    const startsOn = parseDateOnly(get(record, 'promo_starts_on'), options.date_order);
    if (!startsOn.ok) return problem(startsOn.error, 'promo_starts_on');
    const endsOn = parseDateOnly(get(record, 'promo_ends_on'), options.date_order);
    if (!endsOn.ok) return problem(endsOn.error, 'promo_ends_on');
    const currency = get(record, 'currency').toUpperCase();
    if (currency && !/^[A-Z]{3}$/.test(currency)) return problem(`"${get(record, 'currency')}" is not a currency code (use e.g. AED)`, 'currency');
    const rating = parseRating(get(record, 'rating'));
    if (!rating.ok) return problem(rating.error, 'rating');
    const reviews = parseCount(get(record, 'review_count'), 'number of reviews');
    if (!reviews.ok) return problem(reviews.error, 'review_count');
    const rank = parseSalesRank(get(record, 'sales_rank'));
    if (!rank.ok) return problem(rank.error, 'sales_rank');
    const tagged = parseTagCells(get(record, 'tags'), get(record, 'tag_text'));

    const discounted = discount.value !== null && discount.value > 0;
    const input: ObservationInput = {
      listing_id: listing.id,
      observed_at: observedAt,
      observed_basis: basis,
      currency_code: currency || null,
      regular_price: numbers.regular_price,
      current_price: numbers.current_price,
      promo_price: numbers.promo_price,
      discount_pct: discount.value,
      // A stated discount means promotional pricing unless the row explicitly says otherwise.
      is_promo: flag.value ?? (discounted ? true : null),
      promo_type: parsePromoType(get(record, 'promo_type')) ?? (discounted && flag.value !== false ? 'price_cut' : null),
      promo_description: get(record, 'promo_description') || null,
      promo_starts_on: startsOn.value,
      promo_ends_on: endsOn.value,
      availability: availability.value,
      product_url: get(record, 'product_url') || null,
      confidence: confidence.value ?? options.default_confidence,
      note: get(record, 'note') || null,
      tags: tagged.tags.length ? tagged.tags : null,
      tag_text: tagged.tag_text,
      rating: rating.value,
      review_count: reviews.value,
      sales_rank: rank.value.rank,
      sales_rank_label: get(record, 'sales_rank_label') || rank.value.label,
      seller_name: get(record, 'seller_name') || null,
    };
    let normalised: NormalisedObservation;
    try {
      normalised = normaliseObservation(input, listing, now);
    } catch (err) {
      return problem((err as Error).message);
    }

    const instant = `${listing.id}|${normalised.observed_at}`;
    const firstRow = seenKeys.get(normalised.dedupe_key);
    let duplicateInFile = false;
    if (firstRow !== undefined) {
      duplicateInFile = true;
      duplicatesInFile++;
      if (warnings.length < WARNING_LIMIT * 5) warnings.push({ row: rowNumber, message: `Same observation as row ${firstRow} — it will be stored once` });
    } else {
      seenKeys.set(normalised.dedupe_key, rowNumber);
      const other = seenInstants.get(instant);
      if (other && other.key !== normalised.dedupe_key) {
        warnings.push({ row: rowNumber, message: `Different values for the same listing and time as row ${other.row} — this row replaces it` });
      }
      seenInstants.set(instant, { key: normalised.dedupe_key, row: rowNumber });
    }
    rows.push({ row: rowNumber, listing, input, normalised, duplicateInFile });
  });

  // ---- compare with the ledger (existing listings only) ---------------------------------------
  let alreadyInLedger = 0;
  let willSupersede = 0;
  const byListing = new Map<number, AnalysedObservation[]>();
  for (const row of rows) {
    if (row.duplicateInFile || row.listing.id < 0) continue;
    const list = byListing.get(row.listing.id);
    if (list) list.push(row);
    else byListing.set(row.listing.id, [row]);
  }
  for (const [listingId, list] of byListing) {
    let min = list[0]!.normalised.observed_at;
    let max = min;
    for (const row of list) {
      if (row.normalised.observed_at < min) min = row.normalised.observed_at;
      if (row.normalised.observed_at > max) max = row.normalised.observed_at;
    }
    const existing = ctx.db.all<{ id: number; observed_at: string; dedupe_key: string; voided: number }>(
      `SELECT o.id, o.observed_at, o.dedupe_key, EXISTS (SELECT 1 FROM observation_voids v WHERE v.observation_id = o.id) AS voided
       FROM price_observations o WHERE o.listing_id = ? AND o.observed_at BETWEEN ? AND ?`,
      [listingId, min, max],
    );
    if (existing.length === 0) continue;
    const keys = new Map(existing.map((e) => [e.dedupe_key, e]));
    const liveInstants = new Set(existing.filter((e) => !e.voided).map((e) => e.observed_at));
    for (const row of list) {
      const same = keys.get(row.normalised.dedupe_key);
      if (same) {
        alreadyInLedger++;
        if (same.voided) {
          warnings.push({ row: row.row, message: `Identical to observation #${same.id}, which was voided — restore that observation instead of importing it again` });
        }
      } else if (liveInstants.has(row.normalised.observed_at)) {
        willSupersede++;
      }
    }
  }

  const valid = rows.length;
  const listingIds = new Set(rows.map((r) => r.listing.id));
  const retailerIds = new Set(rows.map((r) => r.listing.retailer_id));
  let from: string | null = null;
  let to: string | null = null;
  for (const row of rows) {
    const date = row.normalised.observed_local_date;
    if (from === null || date < from) from = date;
    if (to === null || date > to) to = date;
  }
  const summary: ImportSummary = {
    rows: table.rows.length,
    valid,
    invalid: issues.length,
    duplicates_in_file: duplicatesInFile,
    already_in_ledger: alreadyInLedger,
    will_insert: valid - duplicatesInFile - alreadyInLedger,
    will_supersede: willSupersede,
    listings_to_create: pending.size,
    listings: listingIds.size,
    retailers: retailerIds.size,
    date_from: from,
    date_to: to,
    example_rows_skipped: exampleRows,
  };
  const preview = rows.slice(0, PREVIEW_ROWS).map(
    (row): ObservationImportPreviewRow => ({
      row: row.row,
      listing_code: row.listing.code,
      new_listing: row.listing.id < 0,
      retailer: row.listing.retailer_name,
      market: row.listing.market_code,
      product: row.listing.product_name,
      observed_at: row.normalised.observed_at,
      observed_basis: row.normalised.observed_basis,
      observed_local_date: row.normalised.observed_local_date,
      currency: row.normalised.currency_code,
      regular_price: row.normalised.regular_price,
      current_price: row.normalised.current_price,
      promo_price: row.normalised.promo_price,
      discount_pct: row.normalised.discount_pct,
      is_promo: row.normalised.is_promo === 1,
      promo_type: row.normalised.promo_type,
      availability: row.normalised.availability,
      confidence: row.normalised.confidence,
      tags: row.normalised.tags,
      tag_text: row.normalised.tag_text,
      rating: row.normalised.rating,
      review_count: row.normalised.review_count,
      sales_rank: row.normalised.sales_rank,
      seller_name: row.normalised.seller_name,
    }),
  );
  return { rows, pending, issues, warnings, summary, preview };
}

// ---------------------------------------------------------------------------------------------
// Product import
// ---------------------------------------------------------------------------------------------
const UNIT_WORDS: Record<string, PackUnit> = {
  ml: 'ml', mls: 'ml', millilitre: 'ml', millilitres: 'ml', milliliter: 'ml', milliliters: 'ml', cc: 'ml',
  l: 'l', lt: 'l', ltr: 'l', ltrs: 'l', litre: 'l', litres: 'l', liter: 'l', liters: 'l',
  g: 'g', gm: 'g', gms: 'g', gr: 'g', gram: 'g', grams: 'g',
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  unit: 'unit', units: 'unit', pc: 'unit', pcs: 'unit', piece: 'unit', pieces: 'unit', ea: 'unit', each: 'unit', count: 'unit', ct: 'unit',
  sachet: 'unit', sachets: 'unit', tablet: 'unit', tablets: 'unit', sheet: 'unit', sheets: 'unit', wipes: 'unit', bar: 'unit', bars: 'unit',
};

interface ProductValues {
  name: string;
  brand: string;
  ownership: 'own' | 'competitor' | null;
  category: string;
  subcategory: string | null;
  product_line: string | null;
  sku: string | null;
  gtin: string | null;
  pack_size: number | null;
  pack_unit: PackUnit | null;
  units_per_pack: number | null;
  image_url: string | null;
  description: string | null;
  market_ids: number[] | null;
  market_codes: string[];
  status: 'active' | 'inactive' | 'archived' | null;
}

interface AnalysedProduct {
  row: number;
  action: 'create' | 'update';
  productId: number | null;
  productCode: string | null;
  values: ProductValues;
  newBrand: boolean;
}

interface ProductAnalysis {
  rows: AnalysedProduct[];
  issues: ImportIssue[];
  warnings: ImportIssue[];
  summary: ImportSummary;
  preview: ProductImportPreviewRow[];
  newBrands: Map<string, { name: string; ownership: 'own' | 'competitor' }>;
  newCategories: Map<string, { name: string; parent: string | null }>;
}

function normaliseProductOptions(raw: Record<string, unknown> | undefined): ProductImportOptions {
  const input = raw ?? {};
  return {
    update_existing: input.update_existing === true,
    create_missing_brands: input.create_missing_brands === true,
    create_missing_categories: input.create_missing_categories === true,
    sheet: typeof input.sheet === 'string' && input.sheet.trim() ? input.sheet.trim() : null,
  };
}

function analyseProducts(ctx: AppContext, table: TabularData, mapping: Record<string, string>, options: ProductImportOptions): ProductAnalysis {
  for (const field of ['name', 'brand', 'category']) {
    if (!mapping[field]) throw unprocessable(`Map the ${field === 'name' ? 'product name' : field} column.`);
  }
  const { db } = ctx;
  const brands = new Map(db.all<{ id: number; name: string; ownership: 'own' | 'competitor' }>('SELECT id, name, ownership FROM brands').map((b) => [b.name.toLowerCase(), b]));
  const categoryRows = db.all<{ id: number; name: string; parent_id: number | null }>('SELECT id, name, parent_id FROM categories');
  const topCategories = new Map(categoryRows.filter((c) => c.parent_id === null).map((c) => [c.name.toLowerCase(), c]));
  const subCategories = new Map(categoryRows.filter((c) => c.parent_id !== null).map((c) => [`${c.parent_id}:${c.name.toLowerCase()}`, c]));
  const markets = db.all<{ id: number; code: string; name: string; country_name: string }>('SELECT id, code, name, country_name FROM markets');
  const marketByKey = new Map<string, { id: number; code: string }>();
  for (const m of markets) {
    for (const key of [m.code, m.name, m.country_name]) marketByKey.set(key.toLowerCase(), { id: m.id, code: m.code });
  }
  const findProduct = (column: 'code' | 'sku' | 'gtin', value: string) =>
    db.get<{ id: number; code: string }>(`SELECT id, code FROM products WHERE ${column} = ?${column === 'code' ? ' COLLATE NOCASE' : ''}`, [value]);

  const issues: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const rows: AnalysedProduct[] = [];
  const newBrands = new Map<string, { name: string; ownership: 'own' | 'competitor' }>();
  const newCategories = new Map<string, { name: string; parent: string | null }>();
  const seen = new Map<string, number>();
  let exampleRows = 0;
  let duplicatesInFile = 0;
  let existingSkipped = 0;
  const get = (record: Record<string, string>, field: string) => (mapping[field] ? (record[mapping[field]!] ?? '').trim() : '');

  table.rows.forEach((record, index) => {
    const rowNumber = table.rowNumbers[index] ?? index + 2;
    const problem = (message: string, field?: string) => {
      issues.push({ row: rowNumber, field, message });
    };
    if (Object.values(record).some((value) => value.toUpperCase().startsWith(EXAMPLE_MARKER))) {
      exampleRows++;
      warnings.push({ row: rowNumber, message: 'Template example row ignored' });
      return;
    }
    const name = get(record, 'name');
    if (!name) return problem('Product name is missing', 'name');
    if (name.length > 300) return problem('Product name is longer than 300 characters', 'name');
    const brandName = get(record, 'brand');
    if (!brandName) return problem('Brand is missing', 'brand');
    const categoryName = get(record, 'category');
    if (!categoryName) return problem('Category is missing', 'category');

    const ownershipText = get(record, 'ownership').toLowerCase();
    let ownership: 'own' | 'competitor' | null = null;
    if (ownershipText) {
      if (/^(own|own brand|ours|our brand|internal|yes)$/.test(ownershipText)) ownership = 'own';
      else if (/^(competitor|competition|comp|competitor brand|external|no)$/.test(ownershipText)) ownership = 'competitor';
      else return problem(`"${get(record, 'ownership')}" is not a brand ownership (use "own" or "competitor")`, 'ownership');
    }
    const existingBrand = brands.get(brandName.toLowerCase());
    let newBrand = false;
    if (!existingBrand) {
      if (!options.create_missing_brands) return problem(`Brand "${brandName}" does not exist. Create it first, or enable "create missing brands".`, 'brand');
      const planned = newBrands.get(brandName.toLowerCase());
      const effective = ownership ?? planned?.ownership ?? null;
      if (!effective) return problem(`Brand "${brandName}" is new: say whether it is an own brand or a competitor (ownership column)`, 'ownership');
      if (planned && ownership && planned.ownership !== ownership) return problem(`Brand "${brandName}" is marked both own and competitor in this file`, 'ownership');
      if (!planned) newBrands.set(brandName.toLowerCase(), { name: brandName, ownership: effective });
      newBrand = true;
    } else if (ownership && existingBrand.ownership !== ownership) {
      warnings.push({ row: rowNumber, field: 'ownership', message: `Brand "${existingBrand.name}" is already recorded as ${existingBrand.ownership}; the ownership column is ignored` });
    }

    const top = topCategories.get(categoryName.toLowerCase());
    if (!top) {
      if (!options.create_missing_categories) return problem(`Category "${categoryName}" does not exist. Create it first, or enable "create missing categories".`, 'category');
      const key = `:${categoryName.toLowerCase()}`;
      if (!newCategories.has(key)) newCategories.set(key, { name: categoryName, parent: null });
    }
    const subcategoryName = get(record, 'subcategory') || null;
    if (subcategoryName) {
      const exists = top ? subCategories.get(`${top.id}:${subcategoryName.toLowerCase()}`) : undefined;
      if (!exists) {
        if (!options.create_missing_categories) return problem(`Subcategory "${subcategoryName}" does not exist under "${categoryName}"`, 'subcategory');
        const key = `${categoryName.toLowerCase()}:${subcategoryName.toLowerCase()}`;
        if (!newCategories.has(key)) newCategories.set(key, { name: subcategoryName, parent: categoryName });
      }
    }

    const sku = get(record, 'sku') || null;
    let gtin: string | null = get(record, 'gtin').replace(/[\s-]/g, '') || null;
    if (gtin) {
      if (/e\+?\d+$/i.test(gtin)) return problem('The barcode was turned into scientific notation by the spreadsheet. Format the column as text and re-enter it.', 'gtin');
      if (!/^\d{8,14}$/.test(gtin)) return problem(`"${get(record, 'gtin')}" is not a barcode (8–14 digits)`, 'gtin');
    } else gtin = null;

    let packSize: number | null = null;
    let packUnit: PackUnit | null = null;
    let unitsPerPack: number | null = null;
    const sizeText = get(record, 'pack_size');
    const unitText = get(record, 'pack_unit').toLowerCase().replace(/\.$/, '');
    if (sizeText) {
      const plain = Number(sizeText.replace(',', '.'));
      if (Number.isFinite(plain) && /^[\d.,]+$/.test(sizeText)) {
        packSize = plain;
      } else {
        const fromText = parsePackFromText(sizeText);
        if (!fromText) return problem(`"${sizeText}" is not a pack size (use a number, or e.g. "200ml")`, 'pack_size');
        packSize = fromText.packSize;
        packUnit = fromText.packUnit;
        if (fromText.unitsPerPack > 1) unitsPerPack = fromText.unitsPerPack;
      }
      if (!(packSize > 0)) return problem('Pack size must be greater than zero', 'pack_size');
    }
    if (unitText) {
      const unit = UNIT_WORDS[unitText];
      if (!unit) return problem(`"${get(record, 'pack_unit')}" is not a pack unit (use ${PACK_UNITS.join(', ')})`, 'pack_unit');
      packUnit = unit;
    }
    if (packSize !== null && !packUnit) return problem('A pack size needs a unit (ml, l, g, kg or unit)', 'pack_unit');
    if (packSize === null && packUnit) packUnit = null;
    const unitsText = get(record, 'units_per_pack');
    if (unitsText) {
      const units = Number(unitsText);
      if (!Number.isInteger(units) || units < 1 || units > 1000) return problem(`"${unitsText}" is not a valid number of units per pack`, 'units_per_pack');
      unitsPerPack = units;
    }

    const imageUrl = get(record, 'image_url') || null;
    if (imageUrl && !/^https?:\/\/\S+$/i.test(imageUrl)) return problem('Image URL must start with http:// or https://', 'image_url');

    let marketIds: number[] | null = null;
    const marketCodes: string[] = [];
    const marketsText = get(record, 'markets');
    if (marketsText) {
      marketIds = [];
      for (const part of marketsText.split(/[|;,]/).map((p) => p.trim()).filter(Boolean)) {
        const market = marketByKey.get(part.toLowerCase());
        if (!market) return problem(`Market "${part}" is not configured`, 'markets');
        if (!marketIds.includes(market.id)) {
          marketIds.push(market.id);
          marketCodes.push(market.code);
        }
      }
    }

    let status: ProductValues['status'] = null;
    const statusText = get(record, 'status').toLowerCase();
    if (statusText) {
      if (['active', 'yes', 'y', 'true', '1', 'live'].includes(statusText)) status = 'active';
      else if (['inactive', 'no', 'n', 'false', '0', 'discontinued', 'delisted'].includes(statusText)) status = 'inactive';
      else if (statusText === 'archived') status = 'archived';
      else return problem(`"${get(record, 'status')}" is not a status (use active, inactive or archived)`, 'status');
    }

    // ---- does it exist already? -------------------------------------------------------------
    const codeText = get(record, 'product_code');
    let existing: { id: number; code: string } | undefined;
    if (codeText) {
      existing = findProduct('code', codeText);
      if (!existing) return problem(`Product code "${codeText}" does not exist (leave the column blank for new products)`, 'product_code');
    }
    if (!existing && sku) existing = findProduct('sku', sku);
    if (!existing && gtin) existing = findProduct('gtin', gtin);
    if (!existing && existingBrand) {
      existing = db.get<{ id: number; code: string }>(
        `SELECT id, code FROM products WHERE brand_id = ? AND name = ? COLLATE NOCASE
           AND COALESCE(pack_size, 0) = COALESCE(?, 0) AND COALESCE(pack_unit, '') = COALESCE(?, '') AND units_per_pack = ?`,
        [existingBrand.id, name, packSize, packUnit, unitsPerPack ?? 1],
      );
    }
    if (existing) {
      // Unique identifiers must not collide with a different product.
      for (const [column, value] of [['sku', sku], ['gtin', gtin]] as const) {
        if (!value) continue;
        const holder = findProduct(column, value);
        if (holder && holder.id !== existing.id) return problem(`${column.toUpperCase()} "${value}" already belongs to product ${holder.code}`, column);
      }
    }

    const fileKeys = [
      sku ? `sku:${sku.toLowerCase()}` : null,
      gtin ? `gtin:${gtin}` : null,
      `n:${brandName.toLowerCase()}|${name.toLowerCase()}|${packSize ?? ''}|${packUnit ?? ''}|${unitsPerPack ?? 1}`,
    ].filter((k): k is string => k !== null);
    const firstRow = fileKeys.map((k) => seen.get(k)).find((r) => r !== undefined);
    if (firstRow !== undefined) {
      duplicatesInFile++;
      warnings.push({ row: rowNumber, message: `Same product (SKU, barcode or name and pack) as row ${firstRow} — skipped` });
      return;
    }
    for (const key of fileKeys) seen.set(key, rowNumber);

    if (existing && !options.update_existing) {
      existingSkipped++;
      warnings.push({ row: rowNumber, message: `Already in the catalogue as ${existing.code} — skipped (enable "update existing" to change it)` });
      return;
    }
    rows.push({
      row: rowNumber,
      action: existing ? 'update' : 'create',
      productId: existing?.id ?? null,
      productCode: existing?.code ?? null,
      newBrand,
      values: {
        name,
        brand: existingBrand?.name ?? brandName,
        ownership,
        category: top?.name ?? categoryName,
        subcategory: subcategoryName,
        product_line: get(record, 'product_line') || null,
        sku,
        gtin,
        pack_size: packSize,
        pack_unit: packUnit,
        units_per_pack: unitsPerPack,
        image_url: imageUrl,
        description: get(record, 'description') || null,
        market_ids: marketIds,
        market_codes: marketCodes,
        status,
      },
    });
  });

  const toCreate = rows.filter((r) => r.action === 'create').length;
  const toUpdate = rows.length - toCreate;
  const summary: ImportSummary = {
    rows: table.rows.length,
    valid: rows.length,
    invalid: issues.length,
    duplicates_in_file: duplicatesInFile,
    already_in_ledger: existingSkipped,
    will_insert: rows.length,
    to_create: toCreate,
    to_update: toUpdate,
    brands_to_create: newBrands.size,
    categories_to_create: newCategories.size,
    example_rows_skipped: exampleRows,
  };
  const preview = rows.slice(0, PREVIEW_ROWS).map(
    (r): ProductImportPreviewRow => ({
      row: r.row,
      action: r.action,
      product_code: r.productCode,
      name: r.values.name,
      brand: r.values.brand,
      new_brand: r.newBrand,
      category: r.values.category,
      subcategory: r.values.subcategory,
      sku: r.values.sku,
      gtin: r.values.gtin,
      pack: formatPack(r.values.pack_size, r.values.pack_unit, r.values.units_per_pack ?? 1),
      markets: r.values.market_codes,
      status: r.values.status ?? (r.action === 'create' ? 'active' : 'unchanged'),
    }),
  );
  return { rows, issues, warnings, summary, preview, newBrands, newCategories };
}

// ---------------------------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------------------------
function storeReport(ctx: AppContext, batchId: number, report: StoredReport): void {
  ctx.db.run('UPDATE import_batches SET errors = ? WHERE id = ?', [
    JSON.stringify({ ...report, errors: report.errors.slice(0, ISSUE_LIMIT), warnings: report.warnings.slice(0, WARNING_LIMIT) }),
    batchId,
  ]);
}

export async function validateImport(
  ctx: AppContext,
  batchId: number,
  body: { mapping?: Record<string, string>; options?: Record<string, unknown> },
): Promise<ImportValidateResponse> {
  const row = batchRow(ctx, batchId);
  if (row.status === 'committed' || row.status === 'voided') throw conflict('This import has already been committed. Upload the file again to import it once more.');
  const storedOptions = safeJson<Record<string, unknown>>(row.options, {});
  const rawOptions = { ...storedOptions, ...(body.options ?? {}) };
  const sheet = typeof rawOptions.sheet === 'string' ? rawOptions.sheet : null;
  const table = await loadTable(row.file_name, readStoredFile(ctx, row), sheet);
  const mapping = checkMapping(row.kind, body.mapping ?? safeJson<Record<string, string>>(row.mapping, {}), table.headers);

  let summary: ImportSummary;
  let issues: ImportIssue[];
  let warnings: ImportIssue[];
  let preview: ImportValidateResponse['preview'];
  let options: ObservationImportOptions | ProductImportOptions;
  if (row.kind === 'observations') {
    options = normaliseObservationOptions(rawOptions, mapping);
    const analysis = analyseObservations(ctx, table, mapping, options, nowIso());
    ({ summary, issues, warnings, preview } = analysis);
  } else {
    options = normaliseProductOptions(rawOptions);
    const analysis = analyseProducts(ctx, table, mapping, options);
    ({ summary, issues, warnings, preview } = analysis);
  }
  ctx.db.run(`UPDATE import_batches SET mapping = ?, options = ?, row_count = ?, valid_count = ?, error_count = ?, status = 'validated' WHERE id = ?`, [
    JSON.stringify(mapping),
    JSON.stringify({ ...options, sheet: table.sheet }),
    table.rows.length,
    summary.valid,
    issues.length,
    batchId,
  ]);
  storeReport(ctx, batchId, { errors: issues, error_total: issues.length, warnings, warning_total: warnings.length, summary, result: null });
  return {
    batch: getBatch(ctx, batchId),
    summary,
    errors: issues.slice(0, ISSUE_LIMIT),
    error_total: issues.length,
    warnings: warnings.slice(0, WARNING_LIMIT),
    warning_total: warnings.length,
    preview,
  };
}

// ---------------------------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------------------------
const committing = new Set<number>();
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export async function commitImport(ctx: AppContext, batchId: number, user: AuthUser, ip?: string): Promise<ImportCommitResponse> {
  const row = batchRow(ctx, batchId);
  if (row.status === 'committed') throw conflict('This import has already been committed.');
  if (row.status === 'voided') throw conflict('This import was voided and cannot be committed again. Upload the file again instead.');
  if (row.status === 'staged') throw conflict('Validate the import before committing it.');
  if (committing.has(batchId)) throw conflict('This import is being committed right now.');
  committing.add(batchId);
  try {
    const mapping = safeJson<Record<string, string>>(row.mapping, {});
    const storedOptions = safeJson<Record<string, unknown>>(row.options, {});
    const table = await loadTable(row.file_name, readStoredFile(ctx, row), typeof storedOptions.sheet === 'string' ? storedOptions.sheet : null);
    checkMapping(row.kind, mapping, table.headers);
    const result =
      row.kind === 'observations'
        ? await commitObservations(ctx, row, table, mapping, normaliseObservationOptions(storedOptions, mapping), user)
        : commitProducts(ctx, row, table, mapping, normaliseProductOptions(storedOptions), user);
    audit(
      ctx,
      user,
      'import.commit',
      'import_batch',
      batchId,
      { kind: row.kind, file_name: row.file_name, inserted: result.inserted, updated: result.updated, duplicates: result.duplicates, skipped_invalid: result.skipped_invalid },
      ip,
    );
    return result;
  } catch (err) {
    // Whatever stopped the commit is recorded on the batch so the user can see why. Rows written before
    // the failure stay in the ledger; committing again is safe because identical observations are skipped.
    const current = ctx.db.get<{ status: string }>('SELECT status FROM import_batches WHERE id = ?', [batchId]);
    if (current && current.status !== 'committed') {
      ctx.db.run(`UPDATE import_batches SET status = 'failed' WHERE id = ?`, [batchId]);
      const report = readReport(batchRow(ctx, batchId));
      storeReport(ctx, batchId, {
        ...report,
        errors: [{ row: 0, message: `Import failed: ${(err as Error).message}` }, ...report.errors],
        error_total: report.error_total + 1,
      });
    }
    throw err;
  } finally {
    committing.delete(batchId);
  }
}

async function commitObservations(
  ctx: AppContext,
  batch: BatchRow,
  table: TabularData,
  mapping: Record<string, string>,
  options: ObservationImportOptions,
  user: AuthUser,
): Promise<ImportCommitResponse> {
  const importTime = nowIso();
  const analysis = analyseObservations(ctx, table, mapping, options, importTime);
  const issues = [...analysis.issues];
  const now = nowIso();

  // Listings that the file needs but that do not exist yet.
  const createdIds = new Map<number, number>();
  if (analysis.pending.size > 0) {
    ctx.db.tx(() => {
      for (const planned of analysis.pending.values()) {
        const id = ctx.db.run(
          `INSERT INTO retailer_listings (retailer_id, product_id, external_id, url, title, match_status, matched_by, matched_at, is_active, is_demo, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'matched', ?, ?, 1, ?, ?, ?)`,
          [planned.retailer.id, planned.product.id, planned.external_id, planned.url, planned.product.name, user.id, now, planned.retailer.is_demo, now, now],
        ).lastInsertRowid;
        createdIds.set(planned.tempId, id);
        audit(ctx, user, 'listing.create', 'listing', id, { via: 'import', import_batch_id: batch.id, retailer_id: planned.retailer.id, product_id: planned.product.id });
      }
    });
  }

  // The batch's evidence record states what the figures were taken from.
  if (batch.evidence_id) {
    ctx.db.run('UPDATE source_evidence SET kind = ?, note = ? WHERE id = ?', [
      options.evidence_kind,
      options.evidence_note ?? `Original file of a price history import (${batch.file_name})`,
      batch.evidence_id,
    ]);
  }

  const entries = analysis.rows
    .map((row) => ({ row: row.row, input: { ...row.input, listing_id: row.listing.id < 0 ? createdIds.get(row.listing.id)! : row.listing.id, evidence_id: batch.evidence_id } }))
    .sort((a, b) => a.input.listing_id - b.input.listing_id || (a.input.observed_at < b.input.observed_at ? -1 : a.input.observed_at > b.input.observed_at ? 1 : a.row - b.row));

  let inserted = 0;
  let duplicates = 0;
  let superseded = 0;
  let start = 0;
  while (start < entries.length) {
    // Keep all rows of one listing in the same transaction so its derived state is rebuilt once.
    let end = Math.min(entries.length, start + COMMIT_CHUNK);
    while (end < entries.length && entries[end]!.input.listing_id === entries[end - 1]!.input.listing_id) end++;
    const chunk = entries.slice(start, end);
    const result = ingestObservations(ctx, chunk.map((e) => e.input), {
      sourceMethod: 'csv_import',
      importBatchId: batch.id,
      userId: user.id,
      collectedAt: importTime,
      suppressAlerts: true,
    });
    inserted += result.inserted;
    duplicates += result.duplicates;
    superseded += result.superseded;
    for (const rejected of result.rejected) issues.push({ row: chunk[rejected.index]!.row, message: rejected.reason });
    start = end;
    // Let other requests through between chunks of a large import.
    if (start < entries.length) await yieldToEventLoop();
  }

  issues.sort((a, b) => a.row - b.row);
  ctx.db.run(
    `UPDATE import_batches SET status = 'committed', row_count = ?, valid_count = ?, inserted_count = ?, duplicate_count = ?, error_count = ?, committed_at = ? WHERE id = ?`,
    [table.rows.length, analysis.rows.length, inserted, duplicates, issues.length, nowIso(), batch.id],
  );
  storeReport(ctx, batch.id, {
    errors: issues,
    error_total: issues.length,
    warnings: analysis.warnings,
    warning_total: analysis.warnings.length,
    summary: analysis.summary,
    result: { inserted, updated: 0, duplicates, superseded, skipped_invalid: issues.length, listings_created: createdIds.size },
  });
  return {
    batch: getBatch(ctx, batch.id),
    inserted,
    updated: 0,
    duplicates,
    superseded,
    skipped_invalid: issues.length,
    listings_created: createdIds.size,
    errors: issues.slice(0, ISSUE_LIMIT),
    error_total: issues.length,
  };
}

function commitProducts(
  ctx: AppContext,
  batch: BatchRow,
  table: TabularData,
  mapping: Record<string, string>,
  options: ProductImportOptions,
  user: AuthUser,
): ImportCommitResponse {
  const analysis = analyseProducts(ctx, table, mapping, options);
  const { db } = ctx;
  const now = nowIso();
  let created = 0;
  let updated = 0;
  db.tx(() => {
    const brandIds = new Map(db.all<{ id: number; name: string }>('SELECT id, name FROM brands').map((b) => [b.name.toLowerCase(), b.id]));
    for (const [key, brand] of analysis.newBrands) {
      const id = db.run('INSERT INTO brands (name, ownership, created_at, updated_at) VALUES (?, ?, ?, ?)', [brand.name, brand.ownership, now, now]).lastInsertRowid;
      brandIds.set(key, id);
      audit(ctx, user, 'brand.create', 'brand', id, { via: 'import', import_batch_id: batch.id, name: brand.name, ownership: brand.ownership });
    }
    const topIds = new Map(db.all<{ id: number; name: string }>('SELECT id, name FROM categories WHERE parent_id IS NULL').map((c) => [c.name.toLowerCase(), c.id]));
    const categoryId = (name: string): number => {
      const existing = topIds.get(name.toLowerCase());
      if (existing) return existing;
      const id = db.run('INSERT INTO categories (name, parent_id, created_at) VALUES (?, NULL, ?)', [name, now]).lastInsertRowid;
      topIds.set(name.toLowerCase(), id);
      return id;
    };
    const subcategoryId = (parentId: number, name: string): number => {
      const existing = db.get<{ id: number }>('SELECT id FROM categories WHERE parent_id = ? AND name = ? COLLATE NOCASE', [parentId, name]);
      if (existing) return existing.id;
      return db.run('INSERT INTO categories (name, parent_id, created_at) VALUES (?, ?, ?)', [name, parentId, now]).lastInsertRowid;
    };

    for (const item of analysis.rows) {
      const v = item.values;
      const brandId = brandIds.get(v.brand.toLowerCase())!;
      const catId = categoryId(v.category);
      const subId = v.subcategory ? subcategoryId(catId, v.subcategory) : null;
      let productId: number;
      if (item.action === 'create') {
        productId = db.run(
          `INSERT INTO products (brand_id, name, product_line, category_id, subcategory_id, sku, gtin, pack_size, pack_unit, units_per_pack,
             image_url, description, status, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [brandId, v.name, v.product_line, catId, subId, v.sku, v.gtin, v.pack_size, v.pack_unit, v.units_per_pack ?? 1, v.image_url, v.description, v.status ?? 'active', user.id, now, now],
        ).lastInsertRowid;
        created++;
      } else {
        productId = item.productId!;
        // Only columns that are mapped and filled in are changed; blank cells leave the product as it is.
        const sets: string[] = ['brand_id = ?', 'name = ?', 'category_id = ?', 'updated_at = ?'];
        const params: Array<string | number | null> = [brandId, v.name, catId, now];
        const optional: Array<[string, string | number | null]> = [
          ['subcategory_id', subId],
          ['product_line', v.product_line],
          ['sku', v.sku],
          ['gtin', v.gtin],
          ['pack_size', v.pack_size],
          ['pack_unit', v.pack_size === null ? null : v.pack_unit],
          ['units_per_pack', v.units_per_pack],
          ['image_url', v.image_url],
          ['description', v.description],
          ['status', v.status],
        ];
        for (const [column, value] of optional) {
          if (value === null) continue;
          sets.push(`${column} = ?`);
          params.push(value);
        }
        db.run(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`, [...params, productId]);
        updated++;
      }
      if (v.market_ids) {
        if (item.action === 'update') db.run('DELETE FROM product_markets WHERE product_id = ?', [productId]);
        for (const marketId of v.market_ids) {
          db.run('INSERT OR IGNORE INTO product_markets (product_id, market_id) VALUES (?, ?)', [productId, marketId]);
        }
      }
    }
    db.run(
      `UPDATE import_batches SET status = 'committed', row_count = ?, valid_count = ?, inserted_count = ?, duplicate_count = ?, error_count = ?, committed_at = ? WHERE id = ?`,
      [table.rows.length, analysis.rows.length, created, analysis.summary.already_in_ledger + analysis.summary.duplicates_in_file, analysis.issues.length, now, batch.id],
    );
  });
  storeReport(ctx, batch.id, {
    errors: analysis.issues,
    error_total: analysis.issues.length,
    warnings: analysis.warnings,
    warning_total: analysis.warnings.length,
    summary: analysis.summary,
    result: { inserted: created, updated, duplicates: analysis.summary.already_in_ledger + analysis.summary.duplicates_in_file, superseded: 0, skipped_invalid: analysis.issues.length, listings_created: 0 },
  });
  return {
    batch: getBatch(ctx, batch.id),
    inserted: created,
    updated,
    duplicates: analysis.summary.already_in_ledger + analysis.summary.duplicates_in_file,
    superseded: 0,
    skipped_invalid: analysis.issues.length,
    listings_created: 0,
    errors: analysis.issues.slice(0, ISSUE_LIMIT),
    error_total: analysis.issues.length,
  };
}

// ---------------------------------------------------------------------------------------------
// Void a committed price import (observations are voided, never deleted)
// ---------------------------------------------------------------------------------------------
export function voidImport(ctx: AppContext, batchId: number, reason: string, user: AuthUser, ip?: string): ImportVoidResponse {
  const row = batchRow(ctx, batchId);
  if (row.kind !== 'observations') throw badRequest('Only price imports can be voided. Products created by an import are managed in the catalogue.');
  if (row.status === 'voided') throw conflict('This import is already voided.');
  if (row.status !== 'committed') throw conflict('Only a committed import can be voided.');
  const { db } = ctx;
  const now = nowIso();
  let voided = 0;
  let restored = 0;
  const listings = new Set<number>();
  db.tx(() => {
    const own = db.all<{ id: number; listing_id: number; observed_at: string }>(
      `SELECT o.id, o.listing_id, o.observed_at FROM price_observations o
       WHERE o.import_batch_id = ? AND NOT EXISTS (SELECT 1 FROM observation_voids v WHERE v.observation_id = o.id)`,
      [batchId],
    );
    for (const obs of own) {
      db.run('INSERT INTO observation_voids (observation_id, reason, voided_by, voided_at, import_batch_id) VALUES (?, ?, ?, ?, ?)', [
        obs.id,
        `Import #${batchId} voided: ${reason}`,
        user.id,
        now,
        batchId,
      ]);
      listings.add(obs.listing_id);
      voided++;
    }
    // Observations that this import had superseded come back, unless something else now covers that instant.
    const victims = db.all<{ id: number; listing_id: number; observed_at: string }>(
      `SELECT o.id, o.listing_id, o.observed_at FROM observation_voids v JOIN price_observations o ON o.id = v.observation_id
       WHERE v.import_batch_id = ? AND (o.import_batch_id IS NULL OR o.import_batch_id <> ?)`,
      [batchId, batchId],
    );
    for (const victim of victims) {
      const covered = db.get('SELECT 1 FROM v_observations WHERE listing_id = ? AND observed_at = ? LIMIT 1', [victim.listing_id, victim.observed_at]);
      if (covered) continue;
      db.run('DELETE FROM observation_voids WHERE observation_id = ?', [victim.id]);
      listings.add(victim.listing_id);
      restored++;
    }
    for (const listingId of listings) refreshListingDerived(ctx, listingId, [], true);
    db.run(`UPDATE import_batches SET status = 'voided', voided_by = ?, voided_at = ?, void_reason = ? WHERE id = ?`, [user.id, now, reason, batchId]);
  });
  audit(ctx, user, 'import.void', 'import_batch', batchId, { reason, observations_voided: voided, observations_restored: restored }, ip);
  return { batch: getBatch(ctx, batchId), observations_voided: voided, observations_restored: restored, listings_affected: listings.size };
}

// ---------------------------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------------------------
const EXAMPLE_NOTE = `${EXAMPLE_MARKER} — delete before importing`;

const OBSERVATION_TEMPLATE: { columns: ColumnSpec[]; rows: Record<string, unknown>[] } = {
  columns: [
    { key: 'retailer', header: 'Retailer', type: 'text' },
    { key: 'market', header: 'Market', type: 'text', width: 10 },
    { key: 'listing_code', header: 'Listing code', type: 'text', width: 14 },
    { key: 'sku', header: 'SKU', type: 'text', width: 16 },
    { key: 'gtin', header: 'GTIN', type: 'text', width: 16 },
    { key: 'observed_at', header: 'Observed at', type: 'text', width: 20 },
    { key: 'regular_price', header: 'Regular price', type: 'money' },
    { key: 'current_price', header: 'Current price', type: 'money' },
    { key: 'promo_price', header: 'Promo price', type: 'money' },
    { key: 'discount_pct', header: 'Discount %', type: 'number' },
    { key: 'promo_type', header: 'Promo type', type: 'text', width: 13 },
    { key: 'promo_description', header: 'Promo description', type: 'text', width: 26 },
    { key: 'promo_starts_on', header: 'Promo starts on', type: 'text', width: 16 },
    { key: 'promo_ends_on', header: 'Promo ends on', type: 'text', width: 16 },
    { key: 'availability', header: 'Availability', type: 'text', width: 14 },
    { key: 'tags', header: 'Tags', type: 'text', width: 30 },
    { key: 'tag_text', header: 'Tag text', type: 'text', width: 26 },
    { key: 'rating', header: 'Rating', type: 'number', width: 9 },
    { key: 'review_count', header: 'Reviews', type: 'integer', width: 10 },
    { key: 'sales_rank', header: 'Sales rank', type: 'text', width: 20 },
    { key: 'seller_name', header: 'Seller', type: 'text', width: 20 },
    { key: 'currency', header: 'Currency', type: 'text', width: 10 },
    { key: 'product_url', header: 'Product URL', type: 'text', width: 34 },
    { key: 'confidence', header: 'Confidence', type: 'text', width: 12 },
    { key: 'note', header: 'Note', type: 'text', width: 44 },
  ],
  rows: [
    {
      retailer: 'Example Retailer', market: 'AE', listing_code: null, sku: 'EXAMPLE-SKU-001', gtin: null, observed_at: '2026-01-15 09:30',
      regular_price: 15.5, current_price: 12.95, promo_price: null, discount_pct: null, promo_type: 'Price cut', promo_description: 'Save 15%',
      promo_starts_on: '2026-01-10', promo_ends_on: '2026-01-20', availability: 'In stock',
      tags: 'Limited time deal; Best seller', tag_text: null, rating: 4.5, review_count: 1280, sales_rank: '#3 in Hair Oils', seller_name: 'Example Retailer',
      currency: 'AED', product_url: 'https://www.example.com/product/123', confidence: 'High', note: EXAMPLE_NOTE,
    },
    {
      retailer: 'Example Retailer', market: 'AE', listing_code: 'LST-000000', sku: null, gtin: null, observed_at: '2026-01-16',
      regular_price: 15.5, current_price: 15.5, promo_price: null, discount_pct: null, promo_type: null, promo_description: null,
      promo_starts_on: null, promo_ends_on: null, availability: 'In stock',
      tags: null, tag_text: null, rating: null, review_count: null, sales_rank: null, seller_name: null,
      currency: 'AED', product_url: null, confidence: 'Medium', note: EXAMPLE_NOTE,
    },
  ],
};

const PRODUCT_TEMPLATE: { columns: ColumnSpec[]; rows: Record<string, unknown>[] } = {
  columns: [
    { key: 'name', header: 'Product name', type: 'text', width: 36 },
    { key: 'brand', header: 'Brand', type: 'text' },
    { key: 'ownership', header: 'Brand ownership', type: 'text', width: 16 },
    { key: 'category', header: 'Category', type: 'text' },
    { key: 'subcategory', header: 'Subcategory', type: 'text' },
    { key: 'product_line', header: 'Product line', type: 'text' },
    { key: 'sku', header: 'SKU', type: 'text', width: 16 },
    { key: 'gtin', header: 'GTIN', type: 'text', width: 16 },
    { key: 'pack_size', header: 'Pack size', type: 'number' },
    { key: 'pack_unit', header: 'Pack unit', type: 'text', width: 10 },
    { key: 'units_per_pack', header: 'Units per pack', type: 'integer', width: 14 },
    { key: 'image_url', header: 'Image URL', type: 'text', width: 30 },
    { key: 'markets', header: 'Markets', type: 'text', width: 16 },
    { key: 'status', header: 'Status', type: 'text', width: 10 },
    { key: 'description', header: 'Description', type: 'text', width: 44 },
  ],
  rows: [
    {
      name: 'Example Hair Oil 200ml', brand: 'Example Brand', ownership: 'own', category: 'Hair Care', subcategory: 'Hair Oil', product_line: 'Example Hair Oil',
      sku: 'EXAMPLE-SKU-001', gtin: '6290000000017', pack_size: 200, pack_unit: 'ml', units_per_pack: 1, image_url: null, markets: 'AE|SA', status: 'active', description: EXAMPLE_NOTE,
    },
    {
      name: 'Example Rival Shampoo 2x400ml', brand: 'Example Rival', ownership: 'competitor', category: 'Hair Care', subcategory: 'Shampoo', product_line: null,
      sku: null, gtin: null, pack_size: 400, pack_unit: 'ml', units_per_pack: 2, image_url: null, markets: 'AE', status: 'active', description: EXAMPLE_NOTE,
    },
  ],
};

export async function importTemplate(kind: ImportKind, format: 'csv' | 'xlsx'): Promise<{ body: Buffer | string; mime: string; fileName: string }> {
  const template = kind === 'observations' ? OBSERVATION_TEMPLATE : PRODUCT_TEMPLATE;
  const base = kind === 'observations' ? 'price-import-template' : 'product-import-template';
  if (format === 'csv') {
    return { body: toCsv(template.columns, template.rows), mime: 'text/csv; charset=utf-8', fileName: `${base}.csv` };
  }
  const instructions = fieldsFor(kind).map((f) => ({
    field: f.label,
    group: f.group,
    required: f.required === 'yes' ? 'Required' : f.required === 'conditional' ? 'One of several' : 'Optional',
    description: f.description,
  }));
  const body = await buildXlsx(
    [
      { name: 'Import', columns: template.columns, rows: template.rows },
      {
        name: 'Instructions',
        notes: [
          kind === 'observations' ? 'How to fill in the price import sheet' : 'How to fill in the product import sheet',
          `Rows marked "${EXAMPLE_MARKER}" are examples and are ignored by the importer. Column names can be changed; you confirm the mapping after uploading.`,
        ],
        columns: [
          { key: 'field', header: 'Column', type: 'text', width: 28 },
          { key: 'group', header: 'Group', type: 'text', width: 16 },
          { key: 'required', header: 'Required?', type: 'text', width: 16 },
          { key: 'description', header: 'What to enter', type: 'text', width: 110 },
        ],
        rows: instructions,
      },
    ],
    { title: kind === 'observations' ? 'Price import template' : 'Product import template' },
  );
  return { body, mime: XLSX_MIME, fileName: `${base}.xlsx` };
}

