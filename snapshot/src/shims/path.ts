/** Minimal POSIX `node:path` for the browser build (the server code only joins and splits names). */
function normalize(input: string): string {
  const absolute = input.startsWith('/');
  const out: string[] = [];
  for (const part of input.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
    } else out.push(part);
  }
  const joined = out.join('/');
  return absolute ? `/${joined}` : joined || '.';
}

function join(...parts: Array<string | undefined>): string {
  return normalize(parts.filter((p): p is string => typeof p === 'string' && p !== '').join('/'));
}

function resolve(...parts: Array<string | undefined>): string {
  let resolved = '';
  for (let i = parts.length - 1; i >= 0 && !resolved.startsWith('/'); i--) {
    const part = parts[i];
    if (typeof part !== 'string' || !part) continue;
    resolved = resolved ? `${part}/${resolved}` : part;
  }
  return normalize(resolved.startsWith('/') ? resolved : `/${resolved}`);
}

function dirname(input: string): string {
  const clean = input.replace(/\/+$/, '');
  const at = clean.lastIndexOf('/');
  if (at < 0) return '.';
  return at === 0 ? '/' : clean.slice(0, at);
}

function basename(input: string, suffix?: string): string {
  const clean = input.replace(/\/+$/, '');
  const name = clean.slice(clean.lastIndexOf('/') + 1);
  return suffix && name.endsWith(suffix) && name !== suffix ? name.slice(0, -suffix.length) : name;
}

function extname(input: string): string {
  const name = basename(input);
  const at = name.lastIndexOf('.');
  return at > 0 ? name.slice(at) : '';
}

function relative(from: string, to: string): string {
  const a = resolve(from).split('/').filter(Boolean);
  const b = resolve(to).split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

const isAbsolute = (input: string): boolean => input.startsWith('/');
const sep = '/';
const delimiter = ':';

const path = { normalize, join, resolve, dirname, basename, extname, relative, isAbsolute, sep, delimiter, posix: null as unknown };
path.posix = path;

export { normalize, join, resolve, dirname, basename, extname, relative, isAbsolute, sep, delimiter };
export default path;
