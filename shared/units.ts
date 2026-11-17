import type { ContentDimension, PackUnit } from './constants.ts';

export interface PackContent {
  /** Total content in base units: millilitres, grams or units. */
  amount: number;
  dimension: ContentDimension;
}

const UNIT_INFO: Record<PackUnit, { dimension: ContentDimension; toBase: number }> = {
  ml: { dimension: 'volume', toBase: 1 },
  l: { dimension: 'volume', toBase: 1000 },
  g: { dimension: 'mass', toBase: 1 },
  kg: { dimension: 'mass', toBase: 1000 },
  unit: { dimension: 'count', toBase: 1 },
};

export function packContent(
  packSize: number | null | undefined,
  packUnit: PackUnit | string | null | undefined,
  unitsPerPack: number | null | undefined = 1,
): PackContent | null {
  if (!packSize || !packUnit || !(packUnit in UNIT_INFO)) return null;
  const info = UNIT_INFO[packUnit as PackUnit];
  const amount = packSize * info.toBase * (unitsPerPack && unitsPerPack > 0 ? unitsPerPack : 1);
  if (!(amount > 0)) return null;
  return { amount, dimension: info.dimension };
}

/** Basis used for unit prices: per 100 ml, per 100 g, or per single unit. */
export function unitBasisLabel(dimension: ContentDimension | null | undefined): string {
  if (dimension === 'volume') return 'per 100ml';
  if (dimension === 'mass') return 'per 100g';
  if (dimension === 'count') return 'per unit';
  return '';
}

export function unitFactor(dimension: ContentDimension): number {
  return dimension === 'count' ? 1 : 100;
}

/** Price per 100 ml / 100 g / unit. Returns null when the pack content is unknown. */
export function unitPrice(price: number | null | undefined, content: PackContent | null): number | null {
  if (price === null || price === undefined || !content) return null;
  return (price * unitFactor(content.dimension)) / content.amount;
}

export function formatPack(
  packSize: number | null | undefined,
  packUnit: string | null | undefined,
  unitsPerPack: number | null | undefined = 1,
): string {
  if (!packSize || !packUnit) return '—';
  const size = Number.isInteger(packSize) ? String(packSize) : String(Number(packSize.toFixed(3)));
  const unit = packUnit === 'unit' ? (packSize === 1 ? ' unit' : ' units') : packUnit;
  const single = `${size}${unit}`;
  return unitsPerPack && unitsPerPack > 1 ? `${unitsPerPack} × ${single}` : single;
}

/** Extracts a pack size such as "200 ml", "1.5L", "2x150g" from free text (used for match suggestions). */
export function parsePackFromText(text: string): { packSize: number; packUnit: PackUnit; unitsPerPack: number } | null {
  const multi = /(\d+)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(ml|l|ltr|litre|liter|g|gm|gms|kg)\b/i.exec(text);
  const single = /(\d+(?:[.,]\d+)?)\s*(ml|l|ltr|litre|liter|g|gm|gms|kg)\b/i.exec(text);
  const m = multi ?? single;
  if (!m) return null;
  const unitsPerPack = multi ? Number(multi[1]) : 1;
  const sizeText = (multi ? multi[2] : single![1])!.replace(',', '.');
  const rawUnit = (multi ? multi[3] : single![2])!.toLowerCase();
  const packUnit: PackUnit = rawUnit.startsWith('ml')
    ? 'ml'
    : rawUnit.startsWith('l')
      ? 'l'
      : rawUnit.startsWith('kg')
        ? 'kg'
        : 'g';
  const packSize = Number(sizeText);
  if (!(packSize > 0)) return null;
  return { packSize, packUnit, unitsPerPack };
}
