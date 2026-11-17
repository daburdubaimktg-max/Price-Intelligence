/** Diagnostics of a connection test (dry run). Shows exactly what the server reported — nothing is stored by a test. */
import { CircleAlert, CircleCheck, CircleDashed } from 'lucide-react';
import { fmtNumber, fmtPrice } from '@/lib/format.ts';
import { Badge, cn, Notice, type BadgeTone } from '@/components/ui/primitives.tsx';
import type { CollectionTestResult } from '@shared/api/collection.ts';
import { JsonBlock, PanelTitle } from './shared.tsx';

const RESULT_META: Record<string, { label: string; tone: BadgeTone }> = {
  ok: { label: 'Price read', tone: 'good' },
  failed: { label: 'Failed', tone: 'crit' },
  missing: { label: 'Not in response', tone: 'warn' },
  would_discover: { label: 'New item', tone: 'accent' },
};

export function TestResultView({ result, className }: { result: CollectionTestResult; className?: string }) {
  const headlineTone = !result.configured ? 'warn' : result.ok ? 'good' : 'crit';
  const HeadlineIcon = !result.configured ? CircleDashed : result.ok ? CircleCheck : CircleAlert;
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <Notice
        tone={headlineTone}
        icon={HeadlineIcon}
        title={
          !result.configured
            ? 'Not configured — no request was made'
            : result.ok
              ? 'The source answered and at least one price could be read'
              : 'The test did not read a price'
        }
      >
        {!result.configured && result.missing.length ? (
          <ul className="list-disc pl-4">
            {result.missing.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        ) : null}
        {result.fatal ? (
          <p>
            <span className="mono">{result.fatal.code}</span> — {result.fatal.message}
          </p>
        ) : null}
        <p className="mt-1 text-ink-3">{result.note}</p>
      </Notice>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-line px-3.5 py-3 text-[12.5px] sm:grid-cols-4">
        {[
          ['Requests made', fmtNumber(result.requests)],
          ['Duration', `${fmtNumber(result.duration_ms)} ms`],
          ['Items in response', result.items_found === null ? 'n/a' : fmtNumber(result.items_found)],
          ['Listings tested', fmtNumber(result.listings_tested)],
          ['Matched', fmtNumber(result.listings_matched)],
          ['Missing', fmtNumber(result.listings_missing)],
          ['Failed', fmtNumber(result.listings_failed)],
          ['Would be discovered', fmtNumber(result.would_discover)],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-ink-3">{label}</dt>
            <dd className="num font-medium text-ink">{value}</dd>
          </div>
        ))}
      </dl>

      {result.results.length ? (
        <div>
          <PanelTitle>Per-listing result</PanelTitle>
          <div className="table-wrap rounded-md border border-line">
            <table className="grid-table is-dense">
              <thead>
                <tr>
                  <th scope="col">Listing</th>
                  <th scope="col">Result</th>
                  <th scope="col" style={{ textAlign: 'right' }}>
                    Price that would be stored
                  </th>
                  <th scope="col">How / why</th>
                </tr>
              </thead>
              <tbody>
                {result.results.map((r, i) => {
                  const meta = RESULT_META[r.status] ?? { label: r.status, tone: 'neutral' as BadgeTone };
                  const obs = r.observation;
                  return (
                    <tr key={i}>
                      <td>
                        <div className="max-w-[16rem] truncate font-medium text-ink">{r.title ?? r.url ?? 'Listing'}</div>
                        <div className="mono text-ink-3">{r.listing_code ?? 'not a listing yet'}</div>
                      </td>
                      <td>
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                      </td>
                      <td className="num" style={{ textAlign: 'right' }}>
                        {obs && obs.current_price !== null ? (
                          <>
                            <span className="font-medium text-ink">{fmtPrice(obs.current_price, obs.currency_code)}</span>{' '}
                            <span className="text-[11px] text-ink-3">{obs.currency_code}</span>
                            {obs.regular_price !== null && obs.regular_price !== obs.current_price ? (
                              <div className="text-[11.5px] text-ink-3">regular {fmtPrice(obs.regular_price, obs.currency_code)}</div>
                            ) : null}
                            {obs.availability ? <div className="text-[11.5px] text-ink-3">{obs.availability.replace(/_/g, ' ')}</div> : null}
                          </>
                        ) : (
                          <span className="text-ink-4">—</span>
                        )}
                      </td>
                      <td className="text-[12px] text-ink-2">
                        {r.strategy ? <div>Read via {r.strategy.replace(/_/g, ' ')}</div> : null}
                        {r.message ? (
                          <div className={r.status === 'failed' ? 'text-crit-ink' : 'text-ink-3'}>
                            {r.code ? <span className="mono">{r.code}</span> : null} {r.message}
                          </div>
                        ) : null}
                        {r.excerpt ? <div className="mono mt-0.5 max-w-[18rem] truncate text-ink-3" title={r.excerpt}>{r.excerpt}</div> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {result.logs.length ? (
        <div>
          <PanelTitle>Log</PanelTitle>
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line text-[12px]">
            {result.logs.map((log, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-2 px-3 py-1.5">
                <Badge tone={log.level === 'error' ? 'crit' : log.level === 'warn' ? 'warn' : 'neutral'}>{log.level}</Badge>
                <span className="mono text-ink-3">{log.code}</span>
                <span className="min-w-0 flex-1 break-words text-ink-2">{log.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {result.sample_items.length ? (
        <div>
          <PanelTitle>First items of the response (shortened)</PanelTitle>
          <JsonBlock value={result.sample_items} />
        </div>
      ) : null}
    </div>
  );
}
