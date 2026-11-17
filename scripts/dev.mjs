#!/usr/bin/env node
/**
 * Development launcher: runs the API server (restarting on changes) and the Vite dev server together.
 *
 *   npm run dev          → API on http://localhost:4000, web app on http://localhost:5173 (proxies /api to the API)
 *
 * PORT and VITE_PORT override the two ports. Ctrl+C stops both.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiPort = process.env.PORT ?? '4000';
const webPort = process.env.VITE_PORT ?? '5173';
const env = { ...process.env, PORT: apiPort, VITE_PORT: webPort };

let stopping = false;

// `--only api` or `--only web` starts just one of the two.
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;

const children = [
  // .env is read by the server itself (server/env.ts), so a missing file is not an error
  { name: 'api', color: '\x1b[36m', command: process.execPath, args: ['--watch-path=server', '--watch-path=shared', 'server/index.ts'] },
  { name: 'web', color: '\x1b[35m', command: process.execPath, args: [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')] },
]
  .filter((spec) => !only || spec.name === only)
  .map((spec) => {
  const child = spawn(spec.command, spec.args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = process.stdout.isTTY ? `${spec.color}[${spec.name}]\x1b[0m ` : `[${spec.name}] `;
  const forward = (stream, out) => {
    let buffered = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) out.write(`${prefix}${line}\n`);
    });
    stream.on('end', () => {
      if (buffered) out.write(`${prefix}${buffered}\n`);
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`${prefix}stopped (${signal ?? `exit code ${code}`}) — shutting down`);
    stop(code ?? 1);
  });
  return child;
  });

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 1500).unref();
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

console.log(
  ['Price Intelligence OS (development)', only !== 'api' ? `  web app  http://localhost:${webPort}` : null, only !== 'web' ? `  API      http://localhost:${apiPort}/api` : null, '']
    .filter((line) => line !== null)
    .join('\n'),
);
