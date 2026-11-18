/**
 * Build of the public, read-only snapshot edition (a static site, e.g. for GitHub Pages).
 *
 * The page bundle is the normal web client. The worker bundle contains the application's server code
 * (routes and services), with the Node driver replaced by SQLite-in-WebAssembly and with stand-ins for
 * the Node-only modules that reading the data never touches (file system, mail, crawling, spreadsheets).
 *
 * Run through `npm run build:snapshot`, which prepares the database copy first.
 */
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = import.meta.dirname;
const root = path.resolve(here, '..');

const metaFile = path.join(here, 'public/data/snapshot.json');
if (!fs.existsSync(metaFile)) {
  throw new Error('snapshot/public/data/snapshot.json is missing. Build the snapshot with `npm run build:snapshot`.');
}
const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as {
  generated_at: string;
  gz_bytes: number;
  sha256: string;
  latest_observation_at: string | null;
  counts: Record<string, number>;
};

/** Node-only modules the worker never calls while reading; value: the named exports the server imports. */
const STAND_INS: Record<string, string[]> = {
  'node:fs': [],
  'node:crypto': [],
  'node:zlib': [],
  'node:net': [],
  'node:dns/promises': [],
  'node:sqlite': [],
  'node:events': ['once'],
  'node:stream': ['Writable', 'PassThrough', 'Readable'],
  'node:stream/promises': ['finished'],
  'csv-parse/sync': ['parse'],
  'fast-xml-parser': ['XMLParser'],
  cheerio: ['load'],
  'robots-parser': [],
  nodemailer: [],
  exceljs: [],
  '@anthropic-ai/sdk': [],
  '@anthropic-ai/sdk/helpers/beta/zod': ['betaZodOutputFormat'],
};

function standInSource(name: string, named: string[]): string {
  const label = name.replace(/^node:/, '');
  return `
const unavailable = (what) => {
  const fail = () => {
    throw new Error(what + ' is not available in the read-only web snapshot');
  };
  return new Proxy(function () {}, {
    get(target, prop) {
      if (prop === 'prototype') return target.prototype;
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return unavailable(what + '.' + prop);
    },
    apply: fail,
    construct: () => unavailable(what + ' instance'),
  });
};
const base = unavailable(${JSON.stringify(label)});
${
  label === 'fs'
    ? `const safe = { existsSync: () => false, mkdirSync: () => undefined, readdirSync: () => [] };
export default new Proxy(base, { get: (target, prop) => (prop in safe ? safe[prop] : target[prop]) });`
    : 'export default base;'
}
${named.map((n) => `export const ${n} = base[${JSON.stringify(n)}];`).join('\n')}
`;
}

function serverInTheBrowser(): Plugin {
  const nodeDriver = path.join(root, 'server/db/sqlite.ts');
  const browserDriver = path.join(here, 'src/db.ts');
  const pathShim = path.join(here, 'src/shims/path.ts');
  const prefix = '\0pios-stand-in:';
  return {
    name: 'pios-server-in-the-browser',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === 'node:path') return pathShim;
      if (source in STAND_INS) return `${prefix}${source}`;
      if (importer && source.endsWith('/sqlite.ts')) {
        const resolved = path.resolve(path.dirname(importer.split('?')[0]!), source);
        if (resolved === nodeDriver) return browserDriver;
      }
      return null;
    },
    load(id) {
      if (!id.startsWith(prefix)) return null;
      const name = id.slice(prefix.length);
      return standInSource(name, STAND_INS[name] ?? []);
    },
  };
}

export default defineConfig({
  root: here,
  base: './',
  publicDir: path.join(here, 'public'),
  cacheDir: path.join(root, 'node_modules/.vite-snapshot'),
  plugins: [serverInTheBrowser(), react(), tailwindcss()],
  worker: {
    format: 'es',
    plugins: () => [serverInTheBrowser()],
  },
  resolve: {
    alias: {
      '@': path.join(root, 'client/src'),
      '@shared': path.join(root, 'shared'),
    },
  },
  define: {
    __SNAPSHOT_AT__: JSON.stringify(meta.generated_at),
    __SNAPSHOT_SHA__: JSON.stringify(meta.sha256.slice(0, 12)),
    __SNAPSHOT_GZ_BYTES__: JSON.stringify(meta.gz_bytes),
    __SNAPSHOT_LATEST__: JSON.stringify(meta.latest_observation_at ?? ''),
    __SNAPSHOT_COUNTS__: JSON.stringify(meta.counts),
  },
  build: {
    outDir: path.join(root, 'dist/pages'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
  },
});
