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
  /** Whether other sites may show the app inside a frame (preview panes, intranet portals). */
  allowEmbedding: boolean;
  /** Request rate limits on sign-in and the assistant. Always on in a running server; switched off by the test harness. */
  rateLimits: boolean;
  anthropicApiKey: string | null;
  sessionIdleHours: number;
  sessionAbsoluteHours: number;
  logLevel: string;
}

/** An environment variable, with empty strings (e.g. `LOG_LEVEL=` in a .env file) treated as unset. */
function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const nodeEnv = env('NODE_ENV') ?? 'development';
  const isProduction = nodeEnv === 'production';
  const rootDir = path.resolve(import.meta.dirname, '..');
  const dataDir = path.resolve(overrides.dataDir ?? env('PIOS_DATA_DIR') ?? path.join(rootDir, 'data'));
  const port = Number(env('PORT') ?? 4000);
  const base: Config = {
    env: nodeEnv,
    isProduction,
    host: env('HOST') ?? '0.0.0.0',
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 4000,
    trustProxy: bool(env('PIOS_TRUST_PROXY'), false),
    rootDir,
    dataDir,
    dbPath: path.join(dataDir, 'price-intelligence.db'),
    evidenceDir: path.join(dataDir, 'evidence'),
    importDir: path.join(dataDir, 'imports'),
    clientDistDir: path.join(rootDir, 'dist', 'client'),
    seedDemo: bool(env('PIOS_SEED_DEMO'), true),
    schedulerEnabled: !['off', 'false', '0', 'no'].includes((env('PIOS_SCHEDULER') ?? 'on').toLowerCase()),
    adminEmail: env('PIOS_ADMIN_EMAIL') ?? null,
    adminPassword: env('PIOS_ADMIN_PASSWORD') ?? null,
    secretKey: env('PIOS_SECRET_KEY') ?? null,
    userAgent: env('PIOS_USER_AGENT') ?? 'PriceIntelligenceOS/1.0',
    // Private/loopback targets are allowed outside production so local feeds and fixtures can be used.
    allowPrivateNetwork: bool(env('PIOS_ALLOW_PRIVATE_NETWORK'), !isProduction),
    // Framing by other origins is refused in production unless explicitly enabled (clickjacking protection).
    allowEmbedding: bool(env('PIOS_ALLOW_EMBEDDING'), !isProduction),
    rateLimits: true,
    anthropicApiKey: env('ANTHROPIC_API_KEY') ?? null,
    sessionIdleHours: 12,
    sessionAbsoluteHours: 24 * 7,
    logLevel: env('LOG_LEVEL') ?? (isProduction ? 'info' : 'warn'),
  };
  const merged = { ...base, ...overrides };
  if (overrides.dataDir && !overrides.dbPath) {
    merged.dbPath = path.join(dataDir, 'price-intelligence.db');
    merged.evidenceDir = path.join(dataDir, 'evidence');
    merged.importDir = path.join(dataDir, 'imports');
  }
  return merged;
}
