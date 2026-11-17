/** DEMO dataset loader and purge. (Implementation in progress — signatures are final.) */
import type { AppContext } from '../context.ts';

/** Loads the clearly-labelled DEMO dataset. Returns row counts per entity. */
export async function seedDemo(_ctx: AppContext): Promise<Record<string, number>> {
  throw new Error('seedDemo is not implemented yet');
}

/** Removes every DEMO record (is_demo = 1). Real data is never touched. Returns deleted row counts per entity. */
export function purgeDemo(_ctx: AppContext): Record<string, number> {
  throw new Error('purgeDemo is not implemented yet');
}
