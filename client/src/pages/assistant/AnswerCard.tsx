/**
 * One answer of the assistant. Everything shown is taken from the server's answer, which is computed from
 * stored records: the text, the figures, the table, the chart and the evidence it rests on. An answer that
 * could not be given (no data, unclear question, not answerable) is drawn as such — never as a result.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowUpRight, Ban, ChevronRight, CircleHelp, Cpu, Database, SearchX, Sparkles, type LucideIcon } from 'lucide-react';
import { fmtDate, fmtNumber, plural } from '@/lib/format.ts';
import { cn, DescriptionList, Notice } from '@/components/ui/primitives.tsx';
import { ChartFrame, MAX_SERIES } from '@/components/charts/kit.tsx';
import { seriesTable, TimeSeriesChart, useSeriesChart, type Series } from '@/components/charts/charts.tsx';
import { DataClassBadge, DemoNotice } from '@/components/domain/domain.tsx';
import { ObservationDrawer } from '@/components/domain/observations.tsx';
import { planTextColumns, useSidewaysOverflow } from '@/pages/reports/table-layout.ts';
import { unitFormatter } from '@/pages/reports/units.ts';
import type { AssistantAnswer, AssistantChart, AssistantEvidence, AssistantTable } from '@shared/api/assistant.ts';

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------
/** The plain-text answer: paragraphs separated by blank lines; lines starting with "•" form a list. */
function AnswerText({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => {
    const out: Array<{ kind: 'p'; text: string } | { kind: 'ul'; items: string[] }> = [];
    for (const paragraph of text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
      if (paragraph.startsWith('• ')) {
        const last = out[out.length - 1];
        if (last?.kind === 'ul') last.items.push(paragraph.slice(2));
        else out.push({ kind: 'ul', items: [paragraph.slice(2)] });
      } else {
        out.push({ kind: 'p', text: paragraph });
      }
    }
    return out;
  }, [text]);
  return (
    <div className={cn('flex flex-col gap-2 text-[13.5px] leading-[21px] text-ink', className)}>
      {blocks.map((block, i) =>
        block.kind === 'p' ? (
          <p key={i} className="whitespace-pre-line">
            {block.text}
          </p>
        ) : (
          <ul key={i} className="flex flex-col gap-1.5 border-l-2 border-line pl-3">
            {block.items.map((item, j) => (
              <li key={j}>{item}</li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Table and chart
// ---------------------------------------------------------------------------------------------
/** Decimals (at most two) that give every number of a column the same precision. */
function columnDecimals(table: AssistantTable): Map<string, number> {
  const out = new Map<string, number>();
  for (const column of table.columns) {
    let decimals = 0;
    for (const row of table.rows) {
      const value = row[column.key];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const rounded = Math.round(value * 100) / 100;
      decimals = Math.max(decimals, Number.isInteger(rounded) ? 0 : Number.isInteger(Math.round(rounded * 1000) / 100) ? 1 : 2);
    }
    out.set(column.key, decimals);
  }
  return out;
}

function AnswerTable({ table }: { table: AssistantTable }) {
  // values arrive formatted; left-aligned columns are text, and a text column that is the same in every
  // row (the one product asked about) is stated once above the grid
  const layout = useMemo(() => planTextColumns(table.rows, table.columns.filter((c) => c.align !== 'right').map((c) => c.key), table.columns.length), [table]);
  const folded = new Set(layout.constant.map((c) => c.key));
  const columns = table.columns.filter((c) => !folded.has(c.key));
  // a column that is blank in every row has nothing to state
  const stated = layout.constant.filter((c) => c.value !== '');
  const decimals = useMemo(() => columnDecimals(table), [table]);
  const [wrapRef, overflowing] = useSidewaysOverflow<HTMLDivElement>([table]);
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <h4 className="text-[12.5px] font-semibold text-ink">{table.title}</h4>
        <span className="num shrink-0 text-[11.5px] text-ink-3">{plural(table.rows.length, 'row')}</span>
      </div>
      <div className="overflow-hidden rounded-lg border border-line">
        {stated.length ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 border-b border-line bg-sunken px-3 py-1.5 text-[12px] leading-5" role="note" aria-label="Values that are the same in every row">
            {stated.map(({ key, value }) => (
              <span key={key} className="inline-flex items-center gap-1.5">
                <span className="text-ink-3">{table.columns.find((c) => c.key === key)?.label}</span>
                <span className="font-medium text-ink">{value}</span>
              </span>
            ))}
            <span className="text-ink-4">— the same in every row</span>
          </div>
        ) : null}
        <div className="table-wrap max-h-80 overflow-y-auto" ref={wrapRef}>
          <table className="grid-table is-dense text-[12.5px] [&_td]:px-2 [&_td:first-child]:pl-3 [&_td:last-child]:pr-3 [&_th]:px-2 [&_th]:whitespace-normal [&_th:first-child]:pl-3 [&_th:last-child]:pr-3">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.key} scope="col" style={{ textAlign: c.align ?? 'left', verticalAlign: 'bottom' }}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, r) => (
                <tr key={r}>
                  {columns.map((c) => {
                    const value = row[c.key];
                    const text = layout.columns.get(c.key);
                    const places = decimals.get(c.key) ?? 0;
                    const content =
                      value === null || value === undefined || value === '' ? (
                        <span className="text-ink-4">—</span>
                      ) : typeof value === 'number' ? (
                        value.toLocaleString('en-GB', { minimumFractionDigits: places, maximumFractionDigits: places })
                      ) : (
                        value
                      );
                    return (
                      <td key={c.key} style={{ textAlign: c.align ?? 'left' }} className={cn(c.align === 'right' && 'num', !text?.wrap && 'whitespace-nowrap')}>
                        {text?.wrap ? (
                          <span className="block" style={{ minWidth: text.minWidth }}>
                            {content}
                          </span>
                        ) : (
                          content
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {overflowing ? <p className="border-t border-line bg-sunken px-3 py-1 text-[11.5px] leading-4 text-ink-3">Scroll sideways for the remaining columns.</p> : null}
      </div>
      {table.note ? <p className="mt-1.5 text-[12px] leading-[18px] text-ink-3">{table.note}</p> : null}
    </div>
  );
}

function AnswerChart({ chart, scope, step }: { chart: AssistantChart; scope: string; step: boolean }) {
  const format = useMemo(() => unitFormatter(chart.unit), [chart.unit]);
  // a label shared by every series (the one product asked about) is said once, in the subtitle
  const sharedLabel = chart.series.length > 1 && chart.series.every((s) => s.label === chart.series[0]!.label && s.sublabel) ? chart.series[0]!.label : null;
  const all = useMemo<Series[]>(
    () => chart.series.map((s) => ({ key: s.key, label: sharedLabel ? s.sublabel! : s.label, sublabel: sharedLabel ? null : s.sublabel, points: s.points })),
    [chart.series, sharedLabel],
  );
  const drawn = useMemo(() => all.slice(0, MAX_SERIES), [all]);
  const view = useSeriesChart(drawn, scope);
  const single = drawn.length === 1 ? drawn[0]! : null;
  const subtitle = [sharedLabel ?? (single ? [single.label, single.sublabel].filter(Boolean).join(' · ') : null), chart.subtitle].filter(Boolean).join(' · ');
  return (
    <ChartFrame
      title={chart.title}
      subtitle={subtitle || undefined}
      legend={view.legend}
      table={seriesTable(all, format)}
      footer={all.length > drawn.length ? `Showing ${drawn.length} of ${all.length} series. The others are in the table view.` : undefined}
    >
      <TimeSeriesChart series={drawn} colorScope={scope} height={200} formatValue={format} curve={step ? 'step' : 'linear'} hiddenKeys={view.hidden} valueLabel={chart.title} />
    </ChartFrame>
  );
}

// ---------------------------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------------------------
const SAMPLE_IDS = 8;

function Evidence({ evidence, demo, onNavigate }: { evidence: AssistantEvidence; demo: AssistantAnswer['demo']; onNavigate: () => void }) {
  const [observationId, setObservationId] = useState<number | null>(null);
  const [allIds, setAllIds] = useState(false);
  const ids = allIds ? evidence.observation_ids : evidence.observation_ids.slice(0, SAMPLE_IDS);
  // two links to the same place are one link
  const links = evidence.links.filter((link, i, list) => list.findIndex((other) => other.href === link.href) === i);
  const sameDay = evidence.first_observed_at?.slice(0, 10) === evidence.last_observed_at?.slice(0, 10);
  return (
    <section className="rounded-lg border border-line bg-sunken px-3.5 py-3" aria-label="Evidence">
      <div className="eyebrow mb-2 flex items-center gap-1.5">
        <Database className="size-3" aria-hidden /> Evidence
      </div>
      {evidence.observations === 0 ? (
        <p className="text-[13px] leading-5 text-ink">No stored observation matches this question, so no figure is reported.</p>
      ) : (
        <>
          <p className="text-[13px] leading-5 text-ink">
            Based on <span className="num font-semibold">{plural(evidence.observations, 'stored observation')}</span>
            {evidence.first_observed_at && evidence.last_observed_at ? (
              <span className="num">
                {' '}
                observed {sameDay ? `on ${fmtDate(evidence.first_observed_at)}` : `between ${fmtDate(evidence.first_observed_at)} and ${fmtDate(evidence.last_observed_at)}`}
              </span>
            ) : null}
            {evidence.retailers.length ? (
              <span>
                {' '}
                at <span title={evidence.retailers.join(', ')}>{plural(evidence.retailers.length, 'retailer')}</span> in{' '}
                <span title={evidence.markets.join(', ')}>{evidence.markets.length <= 3 ? evidence.markets.join(', ') : plural(evidence.markets.length, 'market')}</span>
              </span>
            ) : null}
            .
          </p>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5" aria-label="Observations by how they entered the system">
            {evidence.sources.map((s) => (
              <li key={s.data_class} className="inline-flex items-center gap-1.5">
                <DataClassBadge value={s.data_class} />
                <span className="num text-[12.5px] font-medium text-ink">{fmtNumber(s.observations)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <DemoNotice demo={demo} className="mt-2.5 bg-surface" />
      {evidence.observation_ids.length ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[12px] leading-5 text-ink-3">
          <span>Most recent records:</span>
          {ids.map((id) => (
            <button
              key={id}
              type="button"
              className="num rounded-md border border-line-strong bg-surface px-1.5 text-[11.5px] leading-[18px] text-ink-2 hover:border-ink-4 hover:text-ink"
              title="Open the stored observation"
              onClick={() => setObservationId(id)}
            >
              #{id}
            </button>
          ))}
          {evidence.observation_ids.length > SAMPLE_IDS ? (
            <button type="button" className="link" onClick={() => setAllIds((v) => !v)}>
              {allIds ? 'Show fewer' : `+${evidence.observation_ids.length - SAMPLE_IDS} more`}
            </button>
          ) : null}
        </div>
      ) : null}
      {links.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {links.map((link) => (
            <Link
              key={link.href}
              to={link.href}
              onClick={onNavigate}
              className="inline-flex min-h-7 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2.5 py-1 text-[12.5px] leading-4 font-medium text-ink hover:border-ink-4 hover:bg-wash"
            >
              {link.label}
              <ArrowUpRight className="size-3.5 shrink-0 text-ink-3" aria-hidden />
            </Link>
          ))}
        </div>
      ) : null}
      <ObservationDrawer observationId={observationId} onClose={() => setObservationId(null)} />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Interpretation
// ---------------------------------------------------------------------------------------------
function Interpretation({ answer }: { answer: AssistantAnswer }) {
  const { interpretation } = answer;
  const plan = interpretation.plan;
  // the server's summary lists the resolved scope as "Label: value" parts after the question type
  const [kind, ...parts] = interpretation.summary.split(' · ');
  const items: Array<{ label: ReactNode; value: ReactNode; hidden?: boolean }> = [{ label: 'Understood as', value: kind }];
  for (const part of parts) {
    const at = part.indexOf(': ');
    items.push(at > 0 ? { label: part.slice(0, at), value: part.slice(at + 2) } : { label: 'Limited to', value: part });
  }
  if (!parts.some((p) => p.startsWith('Period')) && (plan.intent === 'current_prices' || plan.intent === 'lowest_price')) {
    items.push({ label: 'Period', value: 'The latest observation of each listing' });
  }
  items.push({ label: 'Number of results', value: plan.limit ? `Top ${plan.limit}` : '', hidden: !plan.limit });
  items.push({ label: 'Not recognised', value: interpretation.unresolved.join(', '), hidden: interpretation.unresolved.length === 0 });
  return (
    <details className="group rounded-lg border border-line">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2 text-[12.5px] font-medium text-ink-2 select-none [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 shrink-0 text-ink-3 transition-transform group-open:rotate-90" aria-hidden />
        How this was interpreted
        <span className="ml-auto truncate pl-3 font-normal text-ink-3">{kind}</span>
      </summary>
      <div className="border-t border-line px-3.5 py-3">
        <DescriptionList items={items} className="text-[12.5px]" />
        <p className="mt-2.5 text-[12px] leading-[18px] text-ink-3">
          The question is turned into this structured query; the query is then run against the stored observations. No figure is produced by the interpretation step.
        </p>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------------------------
const UNANSWERED: Record<Exclude<AssistantAnswer['status'], 'answered'>, { icon: LucideIcon; title: string; tone: string }> = {
  no_data: { icon: SearchX, title: 'No stored data', tone: 'border-warn/70 bg-warn-soft' },
  needs_clarification: { icon: CircleHelp, title: 'More detail needed', tone: 'border-accent/30 bg-accent-soft' },
  unsupported: { icon: Ban, title: 'Not answerable from stored records', tone: 'border-line-strong bg-wash' },
};

export function AnswerCard({ answer, scope, onNavigate }: { answer: AssistantAnswer; scope: string; onNavigate: () => void }) {
  const answered = answer.status === 'answered';
  const unanswered = answered ? null : UNANSWERED[answer.status as keyof typeof UNANSWERED];
  const EngineIcon = answer.engine === 'claude' ? Sparkles : Cpu;
  return (
    <article className="sheet overflow-hidden" aria-label={`Answer: ${answer.interpretation.summary.split(' · ')[0]}`}>
      {unanswered ? (
        <div className={cn('border-b px-4 py-3.5', unanswered.tone)} role="status">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">
            <unanswered.icon className="size-4 shrink-0" aria-hidden />
            {unanswered.title}
          </div>
          <AnswerText text={answer.answer} className="mt-2" />
        </div>
      ) : (
        <div className="px-4 pt-3.5 pb-1">
          <div className="eyebrow mb-1.5">{answer.interpretation.summary.split(' · ')[0]}</div>
          <AnswerText text={answer.answer} />
        </div>
      )}

      <div className="flex flex-col gap-3.5 px-4 py-3.5">
        {answer.highlights.length ? (
          <div className="overflow-hidden rounded-lg border border-line" aria-label="Key figures">
            <div className="-mr-px -mb-px flex flex-wrap">
              {answer.highlights.map((h, i) => (
                <div key={i} className="min-w-[120px] flex-1 border-r border-b border-line px-3 py-2">
                  <div className="text-[11.5px] leading-4 font-medium text-ink-3">{h.label}</div>
                  <div className="num mt-0.5 text-[16px] leading-6 font-semibold text-ink">{h.value}</div>
                  {h.detail ? <div className="text-[11.5px] leading-4 text-ink-3">{h.detail}</div> : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {answer.chart ? <AnswerChart chart={answer.chart} scope={scope} step={answer.interpretation.intent === 'price_history'} /> : null}
        {answer.tables.map((table, i) => (
          <AnswerTable key={i} table={table} />
        ))}

        {answer.notes.length ? (
          <ul className="flex flex-col gap-1 text-[12px] leading-[18px] text-ink-3" aria-label="Notes">
            {answer.notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        ) : null}

        {answer.evidence ? (
          <Evidence evidence={answer.evidence} demo={answer.demo} onNavigate={onNavigate} />
        ) : answered ? null : (
          <p className="text-[12px] leading-[18px] text-ink-3">No stored observation was used for this reply, and none was invented.</p>
        )}

        <Interpretation answer={answer} />

        {answer.fallback_reason ? (
          <Notice tone="warn" title="Claude was not used for this question">
            {answer.fallback_reason}
          </Notice>
        ) : null}
        <p className="flex items-start gap-1.5 text-[12px] leading-[18px] text-ink-3">
          <EngineIcon className="mt-[3px] size-3 shrink-0" aria-hidden />
          <span>
            {answer.engine === 'claude'
              ? `Interpreted by ${answer.engine_label}; every number comes from the database.`
              : 'Answered by the built-in query engine; no language model was involved.'}
          </span>
        </p>
      </div>
    </article>
  );
}
