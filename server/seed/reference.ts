/**
 * Base configuration loaded into an empty database: currencies and the initial set of markets.
 * This is real configuration (not demo data) and can be edited or extended in Administration.
 */
import type { AppContext } from '../context.ts';
import { nowIso } from '../lib/time.ts';

export const CURRENCIES: Array<[code: string, name: string, symbol: string, decimals: number]> = [
  ['AED', 'UAE Dirham', 'AED', 2],
  ['SAR', 'Saudi Riyal', 'SAR', 2],
  ['KWD', 'Kuwaiti Dinar', 'KWD', 3],
  ['QAR', 'Qatari Riyal', 'QAR', 2],
  ['BHD', 'Bahraini Dinar', 'BHD', 3],
  ['OMR', 'Omani Rial', 'OMR', 3],
  ['IQD', 'Iraqi Dinar', 'IQD', 0],
  ['KES', 'Kenyan Shilling', 'KSh', 2],
  ['UGX', 'Ugandan Shilling', 'USh', 0],
  ['GHS', 'Ghanaian Cedi', 'GH₵', 2],
  ['USD', 'US Dollar', '$', 2],
  ['EUR', 'Euro', '€', 2],
  ['GBP', 'Pound Sterling', '£', 2],
  ['INR', 'Indian Rupee', '₹', 2],
  ['EGP', 'Egyptian Pound', 'E£', 2],
  ['NGN', 'Nigerian Naira', '₦', 2],
  ['TZS', 'Tanzanian Shilling', 'TSh', 0],
  ['ZAR', 'South African Rand', 'R', 2],
  ['JOD', 'Jordanian Dinar', 'JOD', 3],
  ['PKR', 'Pakistani Rupee', 'Rs', 2],
];

export const INITIAL_MARKETS: Array<{
  code: string;
  name: string;
  country_name: string;
  region: string;
  currency: string;
  timezone: string;
}> = [
  { code: 'AE', name: 'UAE', country_name: 'United Arab Emirates', region: 'GCC', currency: 'AED', timezone: 'Asia/Dubai' },
  { code: 'SA', name: 'Saudi Arabia', country_name: 'Saudi Arabia', region: 'GCC', currency: 'SAR', timezone: 'Asia/Riyadh' },
  { code: 'KW', name: 'Kuwait', country_name: 'Kuwait', region: 'GCC', currency: 'KWD', timezone: 'Asia/Kuwait' },
  { code: 'QA', name: 'Qatar', country_name: 'Qatar', region: 'GCC', currency: 'QAR', timezone: 'Asia/Qatar' },
  { code: 'BH', name: 'Bahrain', country_name: 'Bahrain', region: 'GCC', currency: 'BHD', timezone: 'Asia/Bahrain' },
  { code: 'OM', name: 'Oman', country_name: 'Oman', region: 'GCC', currency: 'OMR', timezone: 'Asia/Muscat' },
  { code: 'IQ', name: 'Iraq', country_name: 'Iraq', region: 'Levant & Iraq', currency: 'IQD', timezone: 'Asia/Baghdad' },
  { code: 'KE', name: 'Kenya', country_name: 'Kenya', region: 'East Africa', currency: 'KES', timezone: 'Africa/Nairobi' },
  { code: 'UG', name: 'Uganda', country_name: 'Uganda', region: 'East Africa', currency: 'UGX', timezone: 'Africa/Kampala' },
  { code: 'GH', name: 'Ghana', country_name: 'Ghana', region: 'West Africa', currency: 'GHS', timezone: 'Africa/Accra' },
];

export function ensureReferenceData(ctx: AppContext): void {
  const { db } = ctx;
  db.tx(() => {
    if ((db.scalar<number>('SELECT COUNT(*) FROM currencies') ?? 0) === 0) {
      for (const [code, name, symbol, decimals] of CURRENCIES) {
        db.run('INSERT INTO currencies (code, name, symbol, decimals) VALUES (?, ?, ?, ?)', [code, name, symbol, decimals]);
      }
    }
    if ((db.scalar<number>('SELECT COUNT(*) FROM markets') ?? 0) === 0) {
      const now = nowIso();
      INITIAL_MARKETS.forEach((m, i) => {
        db.run(
          `INSERT INTO markets (code, name, country_code, country_name, region, currency_code, timezone, default_frequency, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'daily', ?, ?, ?)`,
          [m.code, m.name, m.code, m.country_name, m.region, m.currency, m.timezone, (i + 1) * 10, now, now],
        );
      });
    }
  });
}
