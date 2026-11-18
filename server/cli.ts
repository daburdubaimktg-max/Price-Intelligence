/**
 * Price Intelligence OS — maintenance commands.
 *
 *   node server/cli.ts <command> [arguments]
 *
 * Uses the same database and configuration (PIOS_DATA_DIR, …) as the server and never starts the HTTP listener or
 * the collection scheduler. Stop the server before commands that change data, or run them from the same host:
 * SQLite allows a single writer at a time and a long-running command would make the server wait.
 */
import './env.ts';
import path from 'node:path';
import { buildApp } from './app.ts';
import { createUser, revokeUserSessions, setPassword } from './auth/auth.ts';
import { randomPassword } from './lib/crypto.ts';
import { ensureReferenceData } from './seed/reference.ts';

const COMMANDS: Record<string, string> = {
  migrate: 'Create or upgrade the database schema and reference data (currencies, initial markets).',
  status: 'Show what the database contains, split into real and DEMO records.',
  'seed-demo': 'Load the clearly labelled DEMO dataset (refused when demo data is already present).',
  'purge-demo': 'Remove every DEMO record. Real products, listings and observations are never touched.',
  'export-excel [file]': 'Write the whole database as one Excel workbook (default: <data dir>/exports/price-intelligence-database.xlsx).',
  'backup [file]': 'Write a consistent copy of the SQLite database file (default: <data dir>/backups/price-intelligence-<timestamp>.db).',
  'load-catalogue <file> [--dry-run] [--update-products]': 'Load a prepared catalogue file: retailers, products, listings and the price observed for each listing (see README).',
  'suggest-mappings [--min-retailers N]': 'Propose competitor pairings for own products (never approved automatically); with N, only for own products listed at N retailers or more.',
  'fetch-rates': 'Fetch the latest exchange rates from the configured provider and add them to the rate history.',
  'create-admin <email> [name]': 'Create an administrator with a generated one-time password.',
  'reset-password <email>': 'Give a user a generated one-time password, unlock the account and sign out its sessions.',
};

function usage(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((c) => c.length));
  return ['Usage: node server/cli.ts <command>', '', ...Object.entries(COMMANDS).map(([c, d]) => `  ${c.padEnd(width)}  ${d}`), ''].join('\n');
}

function table(rows: Array<[string, string | number]>): string {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `  ${label.padEnd(width)}  ${typeof value === 'number' ? value.toLocaleString('en-US') : value}`).join('\n');
}

const [command, ...args] = process.argv.slice(2);
if (!command || command === 'help' || command === '--help' || command === '-h') {
  console.log(usage());
  process.exit(command ? 0 : 1);
}
if (!Object.keys(COMMANDS).some((c) => c.split(' ')[0] === command)) {
  console.error(`Unknown command "${command}".\n\n${usage()}`);
  process.exit(1);
}

// Routes are registered (so default alert rules and the alert engine exist exactly as in the server) but nothing listens.
const { app, ctx } = await buildApp({ schedulerEnabled: false, logLevel: 'warn' });
let exitCode = 0;
try {
  ensureReferenceData(ctx);
  const count = (sql: string) => ctx.db.scalar<number>(sql) ?? 0;

  switch (command) {
    case 'migrate': {
      const version = count('SELECT MAX(version) FROM schema_migrations');
      console.log(`Database ready at ${ctx.config.dbPath} (schema version ${version}).`);
      break;
    }

    case 'status': {
      const real = (tableName: string) => count(`SELECT COUNT(*) FROM ${tableName} WHERE is_demo = 0`);
      const demo = (tableName: string) => count(`SELECT COUNT(*) FROM ${tableName} WHERE is_demo = 1`);
      console.log(`Database: ${ctx.config.dbPath}\n`);
      console.log(
        table([
          ['Products (real / DEMO)', `${real('products')} / ${demo('products')}`],
          ['Retailers (real / DEMO)', `${real('retailers')} / ${demo('retailers')}`],
          ['Retailer listings (real / DEMO)', `${real('retailer_listings')} / ${demo('retailer_listings')}`],
          ['Price observations (real / DEMO)', `${real('price_observations')} / ${demo('price_observations')}`],
          ['Voided observations', count('SELECT COUNT(*) FROM observation_voids')],
          ['Collection jobs (real / simulated)', `${real('collection_jobs')} / ${demo('collection_jobs')}`],
          ['Open alerts', count(`SELECT COUNT(*) FROM alerts WHERE status = 'open'`)],
          ['Users', count('SELECT COUNT(*) FROM users')],
        ]),
      );
      const classes = ctx.db.all<{ data_class: string; n: number; first: string; last: string }>(
        `SELECT data_class, COUNT(*) AS n, MIN(observed_at) AS first, MAX(observed_at) AS last FROM price_observations GROUP BY data_class ORDER BY data_class`,
      );
      if (classes.length) {
        console.log('\nObservations by origin:');
        console.log(table(classes.map((c) => [c.data_class, `${c.n.toLocaleString('en-US')}  (${c.first.slice(0, 10)} → ${c.last.slice(0, 10)})`])));
      }
      break;
    }

    case 'seed-demo': {
      const { demoDataPresent, seedDemo } = await import('./seed/demo.ts');
      if (demoDataPresent(ctx)) {
        console.error('DEMO data is already present. Run "purge-demo" first if you want a fresh demo dataset.');
        exitCode = 1;
        break;
      }
      const started = Date.now();
      const counts = await seedDemo(ctx);
      console.log(`DEMO dataset loaded in ${((Date.now() - started) / 1000).toFixed(1)} s. Every record is flagged as DEMO and all prices are fictional.`);
      console.log(table(Object.entries(counts)));
      break;
    }

    case 'purge-demo': {
      const { purgeDemo } = await import('./seed/demo.ts');
      const counts = purgeDemo(ctx);
      const removed = Object.entries(counts).filter(([, n]) => n > 0);
      console.log(removed.length ? 'DEMO records removed:' : 'There was no DEMO data to remove.');
      if (removed.length) console.log(table(removed));
      break;
    }

    case 'export-excel': {
      const { mirrorPath, writeDatabaseWorkbook } = await import('./services/database-export.ts');
      const target = path.resolve(args[0] ?? mirrorPath(ctx));
      const started = Date.now();
      const result = await writeDatabaseWorkbook(ctx, target, { includeAdminSheets: true, generatedBy: 'command line' });
      console.log(`Excel workbook written to ${target}`);
      console.log(`  ${result.observationRows.toLocaleString('en-US')} price observations, ${((Date.now() - started) / 1000).toFixed(1)} s`);
      break;
    }

    case 'backup': {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      const target = path.resolve(args[0] ?? path.join(ctx.config.dataDir, 'backups', `price-intelligence-${stamp}.db`));
      await ctx.db.backupTo(target);
      console.log(`Database backup written to ${target}`);
      break;
    }

    case 'load-catalogue': {
      const file = args.find((a) => !a.startsWith('--'));
      if (!file) {
        console.error('Usage: node server/cli.ts load-catalogue <file.json> [--dry-run] [--update-products]');
        exitCode = 1;
        break;
      }
      const absolute = path.resolve(file);
      const fs = await import('node:fs');
      if (!fs.existsSync(absolute)) {
        console.error(`File not found: ${absolute}`);
        exitCode = 1;
        break;
      }
      const { loadCatalogue } = await import('./services/catalogue-load.ts');
      const started = Date.now();
      const dryRun = args.includes('--dry-run');
      const outcome = loadCatalogue(ctx, JSON.parse(fs.readFileSync(absolute, 'utf8')), { baseDir: path.dirname(absolute), dryRun, updateExisting: args.includes('--update-products') });
      console.log(`${dryRun ? 'Dry run — nothing was stored. The load would have' : 'Catalogue loaded in ' + ((Date.now() - started) / 1000).toFixed(1) + ' s. It'} created:`);
      console.log(
        table([
          ['Retailers', outcome.retailers_created],
          ['Brands', outcome.brands_created],
          ['Categories', outcome.categories_created],
          ['Products (new / already present)', `${outcome.products_created} / ${outcome.products_reused}`],
          ['Products brought in line with the file', outcome.products_updated],
          ['Listings (new / already present)', `${outcome.listings_created} / ${outcome.listings_existing}`],
          ['Listings left unmatched', outcome.listings_unmatched],
          ['Listings retired (products archived)', `${outcome.listings_retired} (${outcome.products_archived})`],
          ['Evidence records', outcome.evidence_created],
          ['Price observations (new / already present)', `${outcome.observations_inserted} / ${outcome.observations_duplicate}`],
          ['Observations carrying a deal tag', outcome.tagged_observations],
          ['Observations rejected', outcome.observations_rejected.length],
        ]),
      );
      for (const r of outcome.observations_rejected.slice(0, 20)) console.log(`  rejected: ${r.retailer} ${r.external_id} — ${r.reason}`);
      if (outcome.warnings.length) {
        console.log(`\n${outcome.warnings.length} warning(s):`);
        for (const w of outcome.warnings.slice(0, 30)) console.log(`  - ${w}`);
        if (outcome.warnings.length > 30) console.log(`  … ${outcome.warnings.length - 30} more`);
      }
      break;
    }

    case 'suggest-mappings': {
      const flag = args.indexOf('--min-retailers');
      const minRetailers = flag >= 0 ? Number(args[flag + 1]) : undefined;
      if (minRetailers !== undefined && (!Number.isInteger(minRetailers) || minRetailers < 1)) {
        console.error('Usage: node server/cli.ts suggest-mappings [--min-retailers N]');
        exitCode = 1;
        break;
      }
      const { suggestCompetitorMappings } = await import('./services/matching.ts');
      const outcome = suggestCompetitorMappings(ctx, undefined, { minRetailers });
      console.log(`${outcome.createdIds.length} pairing(s) proposed for ${outcome.considered} own product(s). They wait for review under Product Catalogue → Competitor mappings; nothing is approved automatically.`);
      break;
    }

    case 'fetch-rates': {
      const { fetchRatesFromProvider } = await import('./services/fx.ts');
      const outcome = await fetchRatesFromProvider(ctx, null);
      console.log(`Exchange rates as of ${outcome.as_of} from ${outcome.source}: ${outcome.inserted} added, ${outcome.unchanged} already on record (${outcome.currencies.join(', ')}).`);
      break;
    }

    case 'create-admin': {
      const email = args[0]?.trim().toLowerCase();
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        console.error('Usage: node server/cli.ts create-admin <email> [name]');
        exitCode = 1;
        break;
      }
      if (ctx.db.get('SELECT 1 FROM users WHERE email = ?', [email])) {
        console.error(`A user with the e-mail ${email} already exists. Use "reset-password ${email}" instead.`);
        exitCode = 1;
        break;
      }
      const password = randomPassword();
      await createUser(ctx, { email, name: args.slice(1).join(' ').trim() || 'Administrator', password, role: 'admin', mustChangePassword: true });
      console.log(`Administrator created.\n  e-mail:   ${email}\n  password: ${password}\nA new password must be chosen at first sign-in.`);
      break;
    }

    case 'reset-password': {
      const email = args[0]?.trim().toLowerCase();
      const user = email ? ctx.db.get<{ id: number }>('SELECT id FROM users WHERE email = ?', [email]) : undefined;
      if (!user) {
        console.error(email ? `No user with the e-mail ${email}.` : 'Usage: node server/cli.ts reset-password <email>');
        exitCode = 1;
        break;
      }
      const password = randomPassword();
      await setPassword(ctx, user.id, password, true);
      revokeUserSessions(ctx, user.id);
      console.log(`Password reset.\n  e-mail:   ${email}\n  password: ${password}\nThe account is unlocked, signed out everywhere and must choose a new password at next sign-in.`);
      break;
    }
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  exitCode = 1;
} finally {
  await app.close();
}
process.exit(exitCode);
