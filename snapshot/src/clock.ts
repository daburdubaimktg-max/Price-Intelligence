/**
 * The snapshot's clock. Import this module first, in the page and in the worker.
 *
 * A snapshot is the state of the database at one moment. If the page used the visitor's real clock, a
 * snapshot opened three weeks later would report every price as stale and show no current offers — a
 * true statement about the file, but useless for looking at the product. So "now" inside the snapshot
 * starts at the moment the snapshot was taken and runs forward from there while the page is open. The
 * page says so in a banner, with the real date of the snapshot.
 *
 * Dates with explicit arguments (`new Date(iso)`, `Date.parse`, `Date.UTC`) are not affected.
 */
const RealDate = Date;

const takenAt = RealDate.parse(__SNAPSHOT_AT__);
const scope = globalThis as unknown as { document?: unknown; Date: DateConstructor; process?: unknown; __PIOS_SNAPSHOT__?: unknown };

/** Milliseconds between the visitor's clock and the snapshot's clock. */
let offset = Number.isFinite(takenAt) ? RealDate.now() - takenAt : 0;

export function getClockOffset(): number {
  return offset;
}

/** The worker takes the page's offset, so both tell exactly the same time. */
export function setClockOffset(value: number): void {
  if (Number.isFinite(value)) offset = value;
}

const now = (): number => RealDate.now() - offset;

const SnapshotDate: DateConstructor = new Proxy(RealDate, {
  construct(target, args: unknown[], newTarget) {
    if (args.length === 0) return new target(now());
    return Reflect.construct(target, args, newTarget === SnapshotDate ? target : newTarget) as object;
  },
  apply(target) {
    return new target(now()).toString();
  },
  get(target, prop) {
    if (prop === 'now') return now;
    return Reflect.get(target, prop, target) as unknown;
  },
});

scope.Date = SnapshotDate;

/** Real moment the snapshot was taken, and the newest price observation it contains. */
export const SNAPSHOT_INFO = { at: __SNAPSHOT_AT__, latest_observation_at: __SNAPSHOT_LATEST__ || null };
scope.__PIOS_SNAPSHOT__ = SNAPSHOT_INFO;

// The server code reads a few `process` values (environment switches, uptime). Only the worker runs it.
if (scope.document === undefined && scope.process === undefined) {
  const started = RealDate.now();
  scope.process = {
    env: {},
    argv: [],
    pid: 1,
    platform: 'browser',
    version: 'web',
    versions: {},
    cwd: () => '/',
    uptime: () => (RealDate.now() - started) / 1000,
    emitWarning: () => undefined,
    nextTick: (fn: (...a: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => fn(...args)),
    getBuiltinModule: () => undefined,
  };
}
