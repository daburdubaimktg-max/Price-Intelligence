#!/usr/bin/env node
/**
 * Production launcher: `npm start`.
 *
 * Sets NODE_ENV=production unless it is already set, then starts the server. It exists so that the same
 * command works in every shell — `NODE_ENV=production node …` is not understood by the Windows command line.
 * Settings in a `.env` file next to package.json are read by the server itself (server/env.ts).
 */
process.env.NODE_ENV ??= 'production';
await import('../server/index.ts');
