/** Helpers shared by the Administration tabs. */
import { useCallback, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, CircleCheck, CircleDashed, Copy, Cpu, KeyRound, ShieldAlert, Trash2, type LucideIcon } from 'lucide-react';
import { fmtNumber, fmtRelative } from '@/lib/format.ts';
import { Badge, Button, cn, EmptyState, Input, Notice, type BadgeTone } from '@/components/ui/primitives.tsx';
import type { IntegrationState } from '@shared/api/admin.ts';
import type { CollectionJob } from '@shared/api/collection.ts';

export function errorText(error: unknown, fallback = 'Something went wrong'): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Shown instead of a tab the signed-in role may not use (never a broken call). */
export function NoAccess({ what, needs }: { what: string; needs: string }) {
  return (
    <EmptyState
      icon={ShieldAlert}
      title={`Your role cannot open ${what}`}
      description={`${needs} Ask an administrator if you need this access.`}
      className="sheet py-14"
    />
  );
}

const STATE_META: Record<IntegrationState, { label: string; tone: BadgeTone; icon: LucideIcon }> = {
  ready: { label: 'Ready', tone: 'good', icon: CircleCheck },
  not_configured: { label: 'Not configured', tone: 'warn', icon: CircleDashed },
  built_in: { label: 'Built-in', tone: 'neutral', icon: Cpu },
};

/** The real state of an integration, as reported by the server. */
export function StateBadge({ state }: { state: IntegrationState }) {
  const meta = STATE_META[state] ?? STATE_META.not_configured;
  return (
    <Badge tone={meta.tone} icon={meta.icon}>
      {meta.label}
    </Badge>
  );
}

/** A value that is displayed exactly once (generated passwords) with a copy button. */
export function CopyBox({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard access can be refused (insecure context, embedded frame): select the text so it can be copied by hand.
      const el = document.getElementById('copy-box-value') as HTMLInputElement | null;
      el?.focus();
      el?.select();
    }
    window.setTimeout(() => setCopied(false), 2500);
  }
  return (
    <div>
      <div className="mb-1 text-[12px] font-medium text-ink-2">{label}</div>
      <div className="flex gap-2">
        <Input id="copy-box-value" readOnly value={value} className="mono !text-[13px]" onFocus={(e) => e.currentTarget.select()} aria-label={label} />
        <Button icon={copied ? Check : Copy} onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}

export interface SecretInfo {
  configured: boolean;
  hint: string | null;
  updated_at: string | null;
}

/**
 * Write-only credential field. The stored value is never shown — only whether one exists and a short
 * recognition hint. Typing a value replaces the stored one on save; leaving it empty keeps it.
 */
export function SecretField({
  label,
  status,
  value,
  onChange,
  onRemove,
  removing,
  placeholder,
  help,
  disabled,
}: {
  label: string;
  status: SecretInfo | null | undefined;
  value: string;
  onChange: (next: string) => void;
  onRemove?: () => void;
  removing?: boolean;
  placeholder?: string;
  help?: ReactNode;
  disabled?: boolean;
}) {
  const configured = !!status?.configured;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] font-medium text-ink-2">
        {label}
        <Badge tone={configured ? 'good' : 'outline'} icon={KeyRound}>
          {configured ? `Stored ${status?.hint ?? ''}`.trim() : 'None stored'}
        </Badge>
        {configured && status?.updated_at ? <span className="font-normal text-ink-3">updated {fmtRelative(status.updated_at)}</span> : null}
      </span>
      <div className="flex gap-2">
        <Input
          type="password"
          autoComplete="new-password"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? (configured ? 'Enter a new value to replace the stored one' : 'Enter the value')}
          aria-label={label}
        />
        {configured && onRemove ? (
          <Button variant="danger" icon={Trash2} onClick={onRemove} loading={removing} disabled={disabled}>
            Remove
          </Button>
        ) : null}
      </div>
      <span className="text-[12px] leading-4 text-ink-3">{help ?? 'Stored encrypted. It is never displayed again — only this status is shown.'}</span>
    </div>
  );
}

/** Invalidate helper: `refresh(['users'], ['reference'])`. */
export function useRefresh() {
  const client = useQueryClient();
  return useCallback((...keys: unknown[][]) => Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey }))), [client]);
}

export function YesNo({ value, yes = 'Yes', no = 'No' }: { value: boolean | number | null | undefined; yes?: string; no?: string }) {
  return <span className={cn('text-[12.5px]', value ? 'text-ink' : 'text-ink-3')}>{value ? yes : no}</span>;
}

/** Card section title used inside admin panels. */
export function PanelTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-3">
      <h3 className="eyebrow">{children}</h3>
      {aside}
    </div>
  );
}

/** JSON rendered for people: small, wrapped, scrollable. */
export function JsonBlock({ value, className }: { value: unknown; className?: string }) {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return <pre className={cn('mono max-h-72 overflow-auto rounded-md border border-line bg-sunken p-3 text-[11.5px] leading-[1.5] whitespace-pre-wrap break-words text-ink-2', className)}>{text}</pre>;
}

/** A file-system path is long and unbreakable, so it gets its own left-aligned line instead of a right-aligned cell. */
export function PathLine({ label, path }: { label: string; path: string }) {
  return (
    <div className="border-b border-line pb-2 text-[13px] last:border-0">
      <div className="text-ink-3">{label}</div>
      <div className="mono mt-0.5 font-medium break-all text-ink">{path}</div>
    </div>
  );
}

/**
 * What a collection job really did, in the state the server recorded: running, succeeded, partial, failed,
 * "not configured" (nothing was attempted) or cancelled. A simulated demo run is always labelled as such.
 */
export function JobOutcome({ job, children }: { job: CollectionJob; children?: ReactNode }) {
  const simulated = job.data_class === 'simulated';
  const kind = simulated ? 'Simulated demo run' : 'Collection job';
  const counts = `${fmtNumber(job.listings_succeeded)} of ${fmtNumber(job.listings_total)} listing${job.listings_total === 1 ? '' : 's'} read · ${fmtNumber(job.observations_created)} new observation${
    job.observations_created === 1 ? '' : 's'
  } stored${job.duplicates_skipped ? ` · ${fmtNumber(job.duplicates_skipped)} unchanged duplicate${job.duplicates_skipped === 1 ? '' : 's'} skipped` : ''}`;
  const problems = [job.listings_failed ? `${fmtNumber(job.listings_failed)} failed` : null, job.listings_missing ? `${fmtNumber(job.listings_missing)} not found at the source` : null]
    .filter(Boolean)
    .join(' · ');
  const demoNote = simulated ? ' These are illustrative DEMO figures, not a real collection.' : '';

  if (job.status === 'queued' || job.status === 'running') {
    return (
      <Notice tone="info" title={`${kind} #${job.id} is ${job.status === 'queued' ? 'queued' : 'running'}…`}>
        This updates by itself when the run has finished. {children}
      </Notice>
    );
  }
  if (job.status === 'not_configured') {
    return (
      <Notice tone="warn" title={`Job #${job.id}: nothing was collected — the source is not configured`}>
        {job.error_message ?? 'No request was made.'} {children}
      </Notice>
    );
  }
  if (job.status === 'succeeded') {
    return (
      <Notice tone={simulated ? 'demo' : 'good'} title={`${kind} #${job.id} finished`}>
        {counts}.{demoNote} {children}
      </Notice>
    );
  }
  if (job.status === 'partial') {
    return (
      <Notice tone="warn" title={`${kind} #${job.id} finished with problems`}>
        {counts}
        {problems ? ` · ${problems}` : ''}.{job.error_message ? ` ${job.error_message}` : ''}
        {demoNote} {children}
      </Notice>
    );
  }
  if (job.status === 'cancelled') {
    return (
      <Notice tone="warn" title={`${kind} #${job.id} was cancelled`}>
        {counts}. {children}
      </Notice>
    );
  }
  return (
    <Notice tone="crit" title={`${kind} #${job.id} failed`}>
      {job.error_message ?? 'The run failed without an error message.'}
      {job.error_code ? <span className="mono"> ({job.error_code})</span> : null} {children}
    </Notice>
  );
}
