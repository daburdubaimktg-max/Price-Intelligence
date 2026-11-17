/**
 * Layout of the text columns of a generated table (report sections and assistant answers).
 *
 * Two things keep wide tables readable without hiding anything:
 *   - a text column that says the same thing in every row (one brand, one currency, one data source…)
 *     is stated once above the grid instead of being repeated;
 *   - longer text may wrap, but never into a sliver: it gets the width its longest value needs on two lines.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

export const DEMO_SUFFIX = /\s*(?:\(DEMO\)|·\s*DEMO)$/;

type Cell = string | number | null | undefined;
const textOf = (value: Cell): string => (value === null || value === undefined ? '' : String(value));

export interface TextColumnLayout {
  wrap: boolean;
  minWidth?: number;
}

export interface TextLayout {
  /** Columns holding one and the same value in every row, with that value. */
  constant: Array<{ key: string; value: string }>;
  /** Wrapping of the text columns that stay in the grid. */
  columns: Map<string, TextColumnLayout>;
}

/** Characters of the longer line when the text is broken into two lines at its best word boundary. */
function twoLineChars(text: string): number {
  const words = text.split(/\s+/).filter(Boolean);
  const total = words.reduce((sum, word) => sum + word.length, 0) + Math.max(0, words.length - 1);
  let best = total;
  let left = 0;
  for (let i = 0; i < words.length - 1; i++) {
    left += words[i]!.length + (i ? 1 : 0);
    best = Math.min(best, Math.max(left, total - left - 1));
  }
  return best;
}

/** Approximate width of one character of table text, in pixels. */
const CHAR_PX = 6.4;

export function planTextColumns(rows: Array<Record<string, Cell>>, textKeys: string[], totalColumns: number): TextLayout {
  const facts = textKeys.map((key) => {
    let longest = 0;
    let twoLines = 0;
    let stamped = false;
    let first: string | null = null;
    let same = rows.length > 1;
    for (const row of rows) {
      const text = textOf(row[key]);
      if (first === null) first = text;
      else if (text !== first) same = false;
      // a trailing DEMO marker is drawn as a stamp that can drop to its own line
      const plain = text.replace(DEMO_SUFFIX, '');
      if (plain.length !== text.length) stamped = true;
      if (plain.length > longest) {
        longest = plain.length;
        twoLines = Math.max(twoLines, twoLineChars(plain));
      } else if (plain.length > 13) {
        twoLines = Math.max(twoLines, twoLineChars(plain));
      }
    }
    return { key, longest, twoLines, stamped, same, value: first ?? '' };
  });
  // something has to identify the row: when every text column is constant, the first one stays in the grid
  const keep = facts.every((f) => f.same) ? facts[0]?.key : undefined;
  const constant = facts.filter((f) => f.same && f.key !== keep).map((f) => ({ key: f.key, value: f.value }));
  // in all but the widest tables a DEMO-stamped label stays on one line with its stamp
  const roomy = totalColumns - constant.length <= 11;
  const columns = new Map<string, TextColumnLayout>();
  for (const f of facts) {
    if (f.same && f.key !== keep) continue;
    const wrap = f.stamped ? !roomy || f.longest > 22 : f.longest > 13;
    // wide enough for the longest value on two lines (three for very long text), never a sliver
    const width = Math.min(190, Math.max(72, Math.round(f.twoLines * CHAR_PX) + 4));
    columns.set(f.key, { wrap, minWidth: wrap ? (f.stamped ? Math.max(width, 96) : width) : undefined });
  }
  return { constant, columns };
}

/**
 * True while the element's content is wider than the element, i.e. it scrolls sideways. Used to say so
 * under a table: the scrollbar sits below the last row and is easy to miss.
 */
export function useSidewaysOverflow<T extends HTMLElement>(deps: unknown[]): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setOverflowing(el.scrollWidth > el.clientWidth + 1);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return [ref, overflowing];
}
