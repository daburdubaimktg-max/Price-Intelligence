#!/usr/bin/env node
/**
 * Builds the public, read-only snapshot edition into dist/pages (a static site for GitHub Pages or
 * any other static host).
 *
 *   npm run build:snapshot                 uses data/price-intelligence.db
 *   npm run build:snapshot -- --db <file>  uses another database file (e.g. a backup)
 *
 * The database is only read. The copy that ships with the site has sign-in data, credentials, the
 * audit trail and provider dataset ids removed (see snapshot/build-db.mjs).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildSnapshotDb } from '../snapshot/build-db.mjs';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const dbFlag = args.indexOf('--db');
const source = path.resolve(root, dbFlag >= 0 && args[dbFlag + 1] ? args[dbFlag + 1] : 'data/price-intelligence.db');
const outDir = path.join(root, 'dist/pages');

const meta = buildSnapshotDb({ source, outDir: path.join(root, 'snapshot/public/data') });
console.log(
  `Snapshot database: ${meta.counts.observations} observations, ${meta.counts.products} products, ${meta.counts.retailers} retailers — ` +
    `${(meta.db_bytes / 1_048_576).toFixed(1)} MB, ${(meta.gz_bytes / 1_048_576).toFixed(1)} MB compressed`,
);

const vite = spawnSync(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', path.join(root, 'snapshot/vite.config.ts')], {
  cwd: root,
  stdio: 'inherit',
});
if (vite.status !== 0) process.exit(vite.status ?? 1);

fs.copyFileSync(path.join(root, 'client/public/favicon.svg'), path.join(outDir, 'favicon.svg'));
// GitHub Pages: serve the files as they are (no Jekyll processing).
fs.writeFileSync(path.join(outDir, '.nojekyll'), '');
console.log(`Static site written to ${path.relative(root, outDir)}/ (snapshot taken ${meta.generated_at})`);
