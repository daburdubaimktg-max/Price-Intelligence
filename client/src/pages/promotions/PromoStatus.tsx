import { CircleDashed, Play } from 'lucide-react';
import { Badge, Tip } from '@/components/ui/primitives.tsx';

const END_REASONS: Record<string, string> = {
  price_restored: 'price restored',
  observation_gap: 'observation gap',
};

/**
 * Status of a promotion episode, strictly observation-based:
 *   Running      – last observation was promotional and the listing is still being observed
 *   Unconfirmed  – last observation was promotional, but the listing has not been observed recently
 *   Ended        – a later observation showed the regular price (or observations stopped for too long)
 */
export function PromoStatus({ status, isCurrent, endReason, stacked }: { status: string; isCurrent: number | boolean; endReason?: string | null; stacked?: boolean }) {
  if (isCurrent) {
    return (
      <Badge tone="accent" icon={Play}>
        Running
      </Badge>
    );
  }
  if (status === 'active') {
    return (
      <Tip content="Last seen on promotion, but the listing has not been observed recently — it cannot be confirmed as still running.">
        <span className="inline-flex">
          <Badge tone="outline" icon={CircleDashed}>
            Unconfirmed
          </Badge>
        </span>
      </Tip>
    );
  }
  const reason = endReason ? (END_REASONS[endReason] ?? endReason.replace(/_/g, ' ')) : null;
  if (stacked) {
    return (
      <span className="flex flex-col whitespace-nowrap">
        <span className="text-[12.5px] text-ink-2">Ended</span>
        {reason ? <span className="text-[11.5px] leading-4 text-ink-3">{reason}</span> : null}
      </span>
    );
  }
  return (
    <span className="text-[12.5px] whitespace-nowrap text-ink-2">
      Ended
      {reason ? <span className="text-ink-3"> · {reason}</span> : null}
    </span>
  );
}
