/**
 * Methods: the collection methods the engine supports, what each one really needs before it can run, and
 * the rules it follows. Nothing here claims a connection — a method with no source says so.
 */
import { useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { CalendarClock, ClipboardList, FlaskConical, Hand, KeyRound, ListTree, Radio, Scale, SearchCheck, ShieldCheck, type LucideIcon } from 'lucide-react';
import { apiGet } from '@/lib/api.ts';
import { fmtNumber, plural } from '@/lib/format.ts';
import { useApiQuery } from '@/lib/hooks.ts';
import { Badge, Button, Card, CardHeader, cn, ErrorState, LoadingBlock } from '@/components/ui/primitives.tsx';
import { FREQUENCIES, FREQUENCY_LABELS, type CollectionMethod } from '@shared/constants.ts';
import type { CollectionSource, ConnectorDescription } from '@shared/api/collection.ts';
import { useCollectionActions } from './shared.tsx';
import { cleared, SOURCE_FILTER_KEYS, useCollectionUrl } from './url.ts';

/** What an observation records, whatever the method (the capture list of the collection engine). */
const CAPTURED_FIELDS: Array<{ group: string; fields: string[] }> = [
  { group: 'What and where', fields: ['Product ID', 'Retailer listing ID', 'Retailer', 'Market', 'Country', 'Currency', 'Product URL'] },
  { group: 'Price', fields: ['Regular listed price', 'Current selling price', 'Promotional price', 'Discount percentage'] },
  { group: 'Promotion and stock', fields: ['Promotion description', 'Promotion start and end dates, when available', 'Availability'] },
  { group: 'When and how', fields: ['Observation timestamp', 'Collection timestamp', 'Source method', 'Evidence reference', 'Extraction confidence', 'Collection status'] },
];

const RULES: Array<{ icon: LucideIcon; title: string; text: string }> = [
  { icon: SearchCheck, title: 'robots.txt is obeyed', text: 'Website extraction checks the site’s robots.txt for every page. Disallowed pages are not fetched, and a site whose robots.txt cannot be read is treated as off-limits.' },
  { icon: ShieldCheck, title: 'Permission comes first', text: 'Website extraction does not run until an administrator has attested that the site’s terms of use allow this access.' },
  { icon: CalendarClock, title: 'Rate limits', text: 'One request at a time per site, with a pause in between (3 seconds unless changed, never below 250 ms; a longer Crawl-delay wins). “Too many requests” from a site stops the run.' },
  { icon: Scale, title: 'No workarounds', text: 'Requests identify themselves with the configured User-Agent. No JavaScript is rendered and no login, cookie-consent or captcha handling is attempted — a page that blocks automated access is reported as a failure.' },
  { icon: KeyRound, title: 'Credentials stay sealed', text: 'API keys and tokens are stored encrypted and are never shown again. They are never part of a source’s visible configuration.' },
  { icon: ClipboardList, title: 'Nothing is assumed', text: 'A source that is not configured makes no request and its run is recorded as “Not configured”. Simulated demo runs are always labelled and never counted as real collection.' },
];

const KIND_META: Record<ConnectorDescription['kind'], { label: string; icon: LucideIcon; tone: 'outline' | 'neutral' | 'demo' }> = {
  real: { label: 'Real integration', icon: Radio, tone: 'outline' },
  people: { label: 'Updated by people', icon: Hand, tone: 'neutral' },
  simulated: { label: 'Simulated demo', icon: FlaskConical, tone: 'demo' },
};

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h4 className="eyebrow mb-1">{title}</h4>
      {children}
    </div>
  );
}

function Bullets({ items, className }: { items: string[]; className?: string }) {
  return (
    <ul className={cn('list-disc space-y-0.5 pl-4 text-[12.5px] leading-5 text-ink-2', className)}>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function MethodCard({ connector, sourceCount, sourcesLoaded, onOpenSources }: { connector: ConnectorDescription; sourceCount: number; sourcesLoaded: boolean; onOpenSources: (method: CollectionMethod) => void }) {
  const kind = KIND_META[connector.kind] ?? KIND_META.real;
  const groups = useMemo(() => {
    const map = new Map<string, { total: number; required: string[] }>();
    for (const f of connector.config_fields) {
      const g = map.get(f.group) ?? { total: 0, required: [] };
      g.total += 1;
      if (f.required) g.required.push(f.label);
      map.set(f.group, g);
    }
    return [...map.entries()];
  }, [connector.config_fields]);

  return (
    <Card className={cn('flex flex-col', connector.kind === 'simulated' && 'border-dashed !border-warn/70')}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-[14px] leading-5 font-semibold text-ink">{connector.label}</h3>
          <p className="mt-0.5 text-[12.5px] leading-5 text-ink-2">{connector.summary}</p>
        </div>
        <Badge tone={kind.tone} icon={kind.icon}>
          {kind.label}
        </Badge>
      </div>

      <div className="flex flex-1 flex-col gap-3.5 px-4 py-3.5">
        <p className="text-[12.5px] leading-5 text-ink-2">{connector.description}</p>

        <Block title="Before it can run">
          <Bullets items={connector.requirements} />
          {connector.credential.needed !== 'never' ? (
            <p className="mt-1.5 flex items-start gap-1.5 text-[12.5px] leading-5 text-ink-2">
              <KeyRound className="mt-[3px] size-3.5 shrink-0 text-ink-3" aria-hidden />
              <span>
                <span className="font-medium text-ink">
                  {connector.credential.label || 'Credential'} — {connector.credential.needed === 'always' ? 'always required' : 'required when the endpoint is protected'}.
                </span>{' '}
                {connector.credential.help}
              </span>
            </p>
          ) : null}
          {connector.needs_permission_attestation ? (
            <p className="mt-1.5 flex items-start gap-1.5 text-[12.5px] leading-5 text-ink-2">
              <ShieldCheck className="mt-[3px] size-3.5 shrink-0 text-ink-3" aria-hidden />
              <span>
                <span className="font-medium text-ink">Access-permission attestation — always required.</span> Recorded by an administrator for each website, with a note.
              </span>
            </p>
          ) : null}
        </Block>

        <Block title="Schedule">
          <p className="text-[12.5px] leading-5 text-ink-2">
            {connector.runnable ? (
              <>
                Run by the scheduler: {FREQUENCIES.filter((f) => f !== 'manual').map((f) => FREQUENCY_LABELS[f].toLowerCase()).join(', ')} — or{' '}
                {FREQUENCY_LABELS.manual.toLowerCase()} only, started with “Run now”.
              </>
            ) : (
              'Not scheduled. It is as fresh as your team keeps it; listings count as stale after a week without a new observation.'
            )}
          </p>
        </Block>

        {connector.limitations.length ? (
          <Block title="Limits">
            <Bullets items={connector.limitations} />
          </Block>
        ) : null}

        {connector.supports_discovery ? (
          <p className="flex items-start gap-1.5 text-[12.5px] leading-5 text-ink-2">
            <ListTree className="mt-[3px] size-3.5 shrink-0 text-ink-3" aria-hidden />
            Can add the items it finds as unmatched listings for review (optional — nothing is matched to a product automatically).
          </p>
        ) : null}

        {groups.length ? (
          <details className="rounded-lg border border-line">
            <summary className="px-3 py-2 text-[12.5px] font-medium text-ink-2">Configuration ({plural(connector.config_fields.length, 'setting')})</summary>
            <ul className="divide-y divide-line border-t border-line text-[12.5px]">
              {groups.map(([group, info]) => (
                <li key={group} className="flex flex-wrap items-baseline justify-between gap-x-4 px-3 py-1.5">
                  <span className="font-medium text-ink-2">{group}</span>
                  <span className="text-ink-3">
                    {plural(info.total, 'setting')}
                    {info.required.length ? ` · required: ${info.required.join(', ')}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {connector.examples.map((example) => (
          <details key={example.title} className="rounded-lg border border-line">
            <summary className="px-3 py-2 text-[12.5px] font-medium text-ink-2">Example: {example.title}</summary>
            <div className="border-t border-line px-3 py-2">
              <p className="text-[12.5px] leading-5 text-ink-2">{example.description}</p>
              {Object.keys(example.config).length ? <pre className="mono mt-2 max-h-56 overflow-auto rounded-md bg-sunken px-2.5 py-2 leading-5 text-ink-2">{JSON.stringify(example.config, null, 2)}</pre> : null}
              {example.notes?.length ? <Bullets items={example.notes} className="mt-2 !text-ink-3" /> : null}
            </div>
          </details>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-[12.5px]">
        {!sourcesLoaded ? (
          <span className="text-ink-4">Counting sources…</span>
        ) : sourceCount > 0 ? (
          <button type="button" className="link" onClick={() => onOpenSources(connector.method)}>
            {plural(sourceCount, 'source')} {sourceCount === 1 ? 'uses' : 'use'} this method
          </button>
        ) : (
          <span className="text-ink-3">{connector.kind === 'simulated' ? 'No simulated source — the demo dataset is not loaded' : 'No source uses this method yet — nothing is connected'}</span>
        )}
      </div>
    </Card>
  );
}

export function MethodsTab() {
  const navigate = useNavigate();
  const actions = useCollectionActions();
  const { set } = useCollectionUrl();
  const connectors = useQuery({ queryKey: ['collection', 'connectors'], queryFn: () => apiGet<{ rows: ConnectorDescription[] }>('/collection/connectors'), staleTime: 10 * 60_000 });
  const sources = useApiQuery<{ rows: CollectionSource[] }>(['collection', 'sources'], '/collection/sources', {});
  const counts = useMemo(() => {
    const map = new Map<CollectionMethod, number>();
    for (const s of sources.data?.rows ?? []) map.set(s.method, (map.get(s.method) ?? 0) + 1);
    return map;
  }, [sources.data]);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Rules the engine follows" subtitle="Collection respects each website’s terms, permitted access and rate limits. These rules are enforced by the engine, not left to configuration." />
          <ul className="grid gap-x-5 gap-y-3 px-4 py-3.5 sm:grid-cols-2">
            {RULES.map((rule) => (
              <li key={rule.title} className="flex items-start gap-2.5">
                <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-wash text-ink-2">
                  <rule.icon className="size-3.5" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block text-[12.5px] leading-5 font-semibold text-ink">{rule.title}</span>
                  <span className="block text-[12.5px] leading-5 text-ink-2">{rule.text}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader title="What every observation records" subtitle="The same fields whatever the method. Timestamps are stored in UTC and shown in the market’s local time; an observation is never overwritten." />
          <div className="grid gap-x-5 gap-y-3 px-4 py-3.5 sm:grid-cols-2">
            {CAPTURED_FIELDS.map((group) => (
              <div key={group.group}>
                <h4 className="eyebrow mb-1">{group.group}</h4>
                <ul className="space-y-0.5 text-[12.5px] leading-5 text-ink-2">
                  {group.fields.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div>
          <h2 className="text-[15px] leading-6 font-semibold text-ink">Collection methods</h2>
          <p className="text-[12.5px] leading-5 text-ink-3">
            {connectors.data ? `${fmtNumber(connectors.data.rows.length)} methods. ` : ''}A retailer uses one of them; new retailers are added as configuration, without changing the application.
          </p>
        </div>
        <Button onClick={() => navigate('/admin?tab=retailers')}>{actions.canManage ? 'Add a source in Administration' : 'Sources in Administration'}</Button>
      </div>

      {connectors.isError && !connectors.data ? (
        <Card>
          <ErrorState error={connectors.error} onRetry={() => void connectors.refetch()} />
        </Card>
      ) : !connectors.data ? (
        <Card>
          <LoadingBlock />
        </Card>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          {connectors.data.rows.map((connector) => (
            <MethodCard
              key={connector.method}
              connector={connector}
              sourceCount={counts.get(connector.method) ?? 0}
              sourcesLoaded={!!sources.data}
              onOpenSources={(method) => set({ ...cleared(SOURCE_FILTER_KEYS), tab: 'sources', s_method: method })}
            />
          ))}
        </div>
      )}
    </div>
  );
}
