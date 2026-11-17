/** Constants and small pieces shared by the Health tab's panels, charts and table. */
import { DEEMPHASIS, SERIES_COLORS } from '@/components/charts/kit.tsx';
import type { DataClass } from '@shared/constants.ts';
import type { CollectionSource } from '@shared/api/collection.ts';

/** Outcomes and freshness are states, so they use the status colours — always beside their labels and figures. */
export const OUTCOME_COLORS = { succeeded: '#0ca30c', partial: '#fab219', failed: '#d03b3b', not_configured: DEEMPHASIS, cancelled: '#6b7489' } as const;
export const FRESHNESS_COLORS = { fresh: '#0ca30c', stale: '#fab219', never: '#ec835a' } as const;
/** Same assignment as the overview's ledger strip: colour follows the data class everywhere. */
export const CLASS_COLORS: Record<DataClass, string> = { collected: SERIES_COLORS[5], imported: SERIES_COLORS[6], manual: SERIES_COLORS[4], simulated: SERIES_COLORS[3] };

export type SourcesResponse = { rows: CollectionSource[]; total: number };

/** Real automated sources, people-driven sources (manual entry, imports) and the demo generator are never pooled. */
export type SourceKind = 'real' | 'people' | 'simulated';
export const kindOf = (s: CollectionSource): SourceKind => (s.method === 'simulated' ? 'simulated' : s.runnable ? 'real' : 'people');

/** Small hatched marker for a line of simulated figures. */
export function DemoTag() {
  return <span className="hatch shrink-0 rounded-[3px] border border-dashed border-warn/60 px-1 text-[10px] leading-[14px] font-semibold tracking-wide text-warn-ink">DEMO</span>;
}
