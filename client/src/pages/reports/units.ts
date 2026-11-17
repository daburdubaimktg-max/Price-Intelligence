/** Value formatting by chart unit, shared by the report charts and the assistant's answer charts. */
import { currencyDecimals, fmtNumber, fmtPct } from '@/lib/format.ts';

/** Formats a value in a chart's unit: 'index', '%' or a currency code. */
export function unitFormatter(unit: string): (value: number) => string {
  if (unit === 'index') return (v) => v.toFixed(1);
  if (unit === '%') return (v) => fmtPct(v, 1);
  if (!unit) return (v) => fmtNumber(v, 2);
  const decimals = currencyDecimals(unit);
  const plain = new Intl.NumberFormat('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  // unit prices below 1 need one more decimal than the currency normally shows
  const fine = new Intl.NumberFormat('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals === 0 ? 1 : decimals + 1 });
  return (v) => (Math.abs(v) < 1 ? fine : plain).format(v);
}
