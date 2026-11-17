/**
 * Loads `.env` from the project root into the environment, if the file exists. Variables that are already set win.
 * Imported first by the entry points (server and maintenance commands) only — never by the test harness, so a
 * developer's local settings cannot leak into tests.
 */
import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve(import.meta.dirname, '..', '.env');
if (fs.existsSync(file)) {
  try {
    process.loadEnvFile(file);
  } catch (err) {
    console.error(`Could not read ${file}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
