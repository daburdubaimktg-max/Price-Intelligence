import path from 'node:path';

export interface Config {
  env: string;
  isProduction: boolean;
  host: string;
  port: number;
  trustProxy: boolean;
  rootDir: string;
  dataDir: string;
  dbPath: string;
  evidenceDir: string;
  importDir: string;
  clientDistDir: string;
  seedDemo: boolean;
  schedulerEnabled: boolean;
  adminEmail: string | null;
  adminPassword: string | null;
  secretKey: string | null;
  userAgent: string;
  allowPrivateNetwork: boolean;
  anthropicApiKey: string | null;
  sessionIdleHours: number;
  sessionAbsoluteHours: number;
  logLevel: string;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = process.env.NODE_ENV ?? 'development';
  const isProduction = env === 'production';
  const rootDir = path.resolve(import.meta.dirname, '..');
  const dataDir = path.resolve(overrides.dataDir ?? process.env.PIOS_DATA_DIR ?? path.join(rootDir, 'data'));
  const base: Config = {
    env,
    isProduction,
    host: process.env.HOST ?? '0.0.0.0',
    port: Number(process.env.PORT ?? 4000),
    trustProxy: bool(process.env.PIOS_TRUST_PROXY, false),
    rootDir,
    dataDir,
    dbPath: path.join(dataDir, 'price-intelligence.db'),
    evidenceDir: path.join(dataDir, 'evidence'),
    importDir: path.join(dataDir, 'imports'),
    clientDistDir: path.join(rootDir, 'dist', 'client'),
    seedDemo: bool(process.env.PIOS_SEED_DEMO, true),
    schedulerEnabled: (process.env.PIOS_SCHEDULER ?? 'on').toLowerCase() !== 'off',
    adminEmail: process.env.PIOS_ADMIN_EMAIL || null,
    adminPassword: process.env.PIOS_ADMIN_PASSWORD || null,
    secretKey: process.env.PIOS_SECRET_KEY || null,
    userAgent: process.env.PIOS_USER_AGENT || 'PriceIntelligenceOS/1.0',
    // Private/loopback targets are allowed outside production so local feeds and fixtures can be used.
    allowPrivateNetwork: bool(process.env.PIOS_ALLOW_PRIVATE_NETWORK, !isProduction),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
    sessionIdleHours: 12,
    sessionAbsoluteHours: 24 * 7,
    logLevel: process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'warn'),
  };
  const merged = { ...base, ...overrides };
  if (overrides.dataDir && !overrides.dbPath) {
    merged.dbPath = path.join(dataDir, 'price-intelligence.db');
    merged.evidenceDir = path.join(dataDir, 'evidence');
    merged.importDir = path.join(dataDir, 'imports');
  }
  return merged;
}
