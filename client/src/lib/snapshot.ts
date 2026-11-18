/**
 * Set only in the public, read-only snapshot edition (see /snapshot). There the whole app runs inside
 * the page on a copy of the database taken at one moment, and nothing can be changed.
 */
export interface SnapshotInfo {
  /** When the snapshot was taken (ISO). "Now" in the snapshot starts at this moment. */
  at: string;
  /** Newest price observation in the snapshot (ISO), if any. */
  latest_observation_at: string | null;
}

export function snapshotInfo(): SnapshotInfo | null {
  const info = (globalThis as { __PIOS_SNAPSHOT__?: SnapshotInfo }).__PIOS_SNAPSHOT__;
  return info && typeof info.at === 'string' ? info : null;
}
