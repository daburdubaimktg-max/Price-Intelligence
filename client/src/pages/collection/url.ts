/**
 * URL state of the Data Collection Centre. One flat namespace so a view can be shared as a link and a tile on
 * the Health tab can open another tab already filtered: `h_` health, `s_` sources, `j_` jobs, `l_` logs,
 * `i_` imports; `source`, `job` and `import` open the detail drawers.
 */
import { useUrlState } from '@/lib/hooks.ts';

export const TAB_KEYS = ['health', 'sources', 'jobs', 'logs', 'imports', 'methods'] as const;
export type TabKey = (typeof TAB_KEYS)[number];

export const COLLECTION_DEFAULTS = {
  tab: 'health' as string | undefined,
  // health
  h_days: '14' as string | undefined,
  h_view: 'all' as string | undefined,
  h_page: '1' as string | undefined,
  // sources
  s_status: undefined as string | undefined,
  s_method: undefined as string | undefined,
  s_market: undefined as string | undefined,
  s_q: undefined as string | undefined,
  // jobs
  j_from: undefined as string | undefined,
  j_to: undefined as string | undefined,
  j_retailer: undefined as string | undefined,
  j_status: undefined as string | undefined,
  j_class: undefined as string | undefined,
  j_trigger: undefined as string | undefined,
  j_page: '1' as string | undefined,
  // logs
  l_from: undefined as string | undefined,
  l_to: undefined as string | undefined,
  l_level: undefined as string | undefined,
  l_retailer: undefined as string | undefined,
  l_class: undefined as string | undefined,
  l_job: undefined as string | undefined,
  l_q: undefined as string | undefined,
  l_page: '1' as string | undefined,
  // imports
  i_kind: undefined as string | undefined,
  i_status: undefined as string | undefined,
  i_page: '1' as string | undefined,
  // drawers
  source: undefined as string | undefined,
  job: undefined as string | undefined,
  import: undefined as string | undefined,
};

export type CollectionUrl = typeof COLLECTION_DEFAULTS;
export type CollectionPatch = Partial<Record<keyof CollectionUrl, string | undefined | null>>;

export function useCollectionUrl() {
  return useUrlState<CollectionUrl>(COLLECTION_DEFAULTS);
}

export const SOURCE_FILTER_KEYS = ['s_status', 's_method', 's_market', 's_q'] as const;
export const JOB_FILTER_KEYS = ['j_from', 'j_to', 'j_retailer', 'j_status', 'j_class', 'j_trigger'] as const;
export const LOG_FILTER_KEYS = ['l_from', 'l_to', 'l_level', 'l_retailer', 'l_class', 'l_job', 'l_q'] as const;
export const IMPORT_FILTER_KEYS = ['i_kind', 'i_status'] as const;

/** A patch that clears the given keys (used by the Reset buttons and when a tile opens a pre-filtered tab). */
export function cleared<K extends keyof CollectionUrl>(keys: readonly K[]): CollectionPatch {
  return Object.fromEntries(keys.map((k) => [k, undefined])) as CollectionPatch;
}

export function countActive<K extends keyof CollectionUrl>(state: CollectionUrl, keys: readonly K[]): number {
  return keys.filter((k) => state[k] !== undefined && state[k] !== '' && state[k] !== COLLECTION_DEFAULTS[k]).length;
}
