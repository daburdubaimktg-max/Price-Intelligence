/**
 * Layout by the width of a component's own card rather than by the viewport: the sidebar takes 240px from
 * 1024px up, so the content area at a 1024px viewport is narrower than at 800px and viewport breakpoints
 * would cut table columns off.
 */
import type { RefObject } from 'react';
import { useSize } from '@/components/charts/kit.tsx';

/** Ref for the wrapper to measure, and its width (the viewport width until the first measurement). */
export function useCardWidth(): [RefObject<HTMLDivElement | null>, number] {
  const [ref, size] = useSize<HTMLDivElement>();
  return [ref, size.width || (typeof window === 'undefined' ? 1280 : window.innerWidth)];
}
