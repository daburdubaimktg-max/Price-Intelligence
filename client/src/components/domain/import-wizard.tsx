/**
 * Staged CSV / Excel import (upload → map columns → validate → commit) for price history and products.
 * Nothing reaches the ledger before the final step; validation is a dry run.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Download, FileSpreadsheet, TriangleAlert, Upload } from 'lucide-react';
import { apiPost, apiUpload, download } from '@/lib/api.ts';
import { fmtDate, fmtNumber, fmtPrice } from '@/lib/format.ts';
import { Dialog, useToast } from '@/components/ui/overlays.tsx';
import { Badge, Button, Checkbox, cn, Field, Input, Notice, Select } from '@/components/ui/primitives.tsx';
import { AVAILABILITY, AVAILABILITY_LABELS } from '@shared/constants.ts';
import type {
  ImportCommitResponse, ImportIssue, ImportStageResponse, ImportValidateResponse, ObservationImportOptions, ObservationImportPreviewRow,
  ProductImportOptions, ProductImportPreviewRow,
} from '@shared/api/observations.ts';
import { MarketTime } from './domain.tsx';

export interface ImportWizardProps {
  open: boolean;
  kind: 'observations' | 'products';
  onClose: () => void;
  onCommitted?: () => void;
}

type Step = 'upload' | 'map' | 'review' | 'done';
type Options = Partial<ObservationImportOptions & ProductImportOptions>;

const STEPS: Array<{ key: Step; label: string }> = [
  { key: 'upload', label: 'Upload' },
  { key: 'map', label: 'Map columns' },
  { key: 'review', label: 'Validate' },
  { key: 'done', label: 'Import' },
];

function Stepper({ step }: { step: Step }) {
  const index = STEPS.findIndex((s) => s.key === step);
  return (
    <ol className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
      {STEPS.map((s, i) => (
        <li key={s.key} className="flex items-center gap-2">
          <span className={cn('flex size-5 items-center justify-center rounded-full text-[11px] font-semibold', i < index ? 'bg-good-soft text-good-ink' : i === index ? 'bg-navy text-white' : 'bg-wash text-ink-3')}>
            {i + 1}
          </span>
          <span className={cn(i === index ? 'font-medium text-ink' : 'text-ink-3')}>{s.label}</span>
          {i < STEPS.length - 1 ? <span aria-hidden className="h-px w-5 bg-line-strong" /> : null}
        </li>
      ))}
    </ol>
  );
}

function IssueList({ issues, total, tone }: { issues: ImportIssue[]; total: number; tone: 'crit' | 'warn' }) {
  if (!total) return null;
  return (
    <div className={cn('rounded-lg border', tone === 'crit' ? 'border-crit/35' : 'border-warn/60')}>
      <div className={cn('flex items-center gap-2 px-3 py-2 text-[12.5px] font-medium', tone === 'crit' ? 'bg-crit-soft text-crit-ink' : 'bg-warn-soft text-warn-ink')}>
        <TriangleAlert className="size-3.5" aria-hidden />
        {tone === 'crit' ? `${fmtNumber(total)} row${total === 1 ? '' : 's'} cannot be imported and will be skipped` : `${fmtNumber(total)} warning${total === 1 ? '' : 's'}`}
      </div>
      <ul className="max-h-44 overflow-y-auto px-3 py-2 text-[12.5px] leading-5">
        {issues.map((issue, i) => (
          <li key={i} className="flex gap-2">
            <span className="num w-16 shrink-0 text-ink-3">Row {issue.row}</span>
            <span className="min-w-0 text-ink-2">
              {issue.field ? <span className="font-medium text-ink">{issue.field}: </span> : null}
              {issue.message}
            </span>
          </li>
        ))}
        {total > issues.length ? <li className="mt-1 text-ink-3">…and {fmtNumber(total - issues.length)} more.</li> : null}
      </ul>
    </div>
  );
}

export function ImportWizard({ open, kind, onClose, onCommitted }: ImportWizardProps) {
  const toast = useToast();
  const client = useQueryClient();
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<ImportStageResponse | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [options, setOptions] = useState<Options>({});
  const [validation, setValidation] = useState<ImportValidateResponse | null>(null);
  const [result, setResult] = useState<ImportCommitResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep('upload');
    setFile(null);
    setStage(null);
    setMapping({});
    setOptions({});
    setValidation(null);
    setResult(null);
    setError(null);
  }, [open, kind]);

  const fail = (err: unknown) => setError(err instanceof Error ? err.message : 'Something went wrong');
  const applyStage = (res: ImportStageResponse) => {
    setStage(res);
    setMapping(res.suggested_mapping);
    setOptions(res.suggested_options);
    setValidation(null);
    setStep('map');
  };

  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('Choose a CSV or Excel file first.');
      const form = new FormData();
      form.append('kind', kind);
      form.append('file', file);
      return apiUpload<ImportStageResponse>('/imports', form);
    },
    onMutate: () => setError(null),
    onSuccess: applyStage,
    onError: fail,
  });
  const switchSheet = useMutation({
    mutationFn: (sheet: string) => apiPost<ImportStageResponse>(`/imports/${stage!.batch.id}/sheet`, { sheet }),
    onMutate: () => setError(null),
    onSuccess: applyStage,
    onError: fail,
  });
  const validate = useMutation({
    mutationFn: () => apiPost<ImportValidateResponse>(`/imports/${stage!.batch.id}/validate`, { mapping, options }),
    onMutate: () => setError(null),
    onSuccess: (res) => {
      setValidation(res);
      setStep('review');
    },
    onError: fail,
  });
  const commit = useMutation({
    mutationFn: () => apiPost<ImportCommitResponse>(`/imports/${stage!.batch.id}/commit`, {}),
    onMutate: () => setError(null),
    onSuccess: async (res) => {
      setResult(res);
      setStep('done');
      await client.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
      onCommitted?.();
    },
    onError: fail,
  });

  const fieldGroups = useMemo(() => {
    const groups = new Map<string, NonNullable<typeof stage>['fields']>();
    for (const f of stage?.fields ?? []) {
      const list = groups.get(f.group);
      if (list) list.push(f);
      else groups.set(f.group, [f]);
    }
    return [...groups.entries()];
  }, [stage]);
  const mappedCount = Object.values(mapping).filter(Boolean).length;
  const setOption = <K extends keyof Options>(key: K, value: Options[K]) => setOptions((o) => ({ ...o, [key]: value }));
  const noun = kind === 'products' ? 'products' : 'price observations';
  const summary = validation?.summary;
  const importable = summary ? (kind === 'products' ? (summary.to_create ?? 0) + (summary.to_update ?? 0) : summary.will_insert) : 0;

  const footer =
    step === 'upload' ? (
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={upload.isPending} disabled={!file} onClick={() => upload.mutate()}>
          Upload and continue
        </Button>
      </>
    ) : step === 'map' ? (
      <>
        <Button onClick={() => setStep('upload')}>Back</Button>
        <Button variant="primary" loading={validate.isPending} onClick={() => validate.mutate()}>
          Validate {fmtNumber(stage?.row_count ?? 0)} rows
        </Button>
      </>
    ) : step === 'review' ? (
      <>
        <Button onClick={() => setStep('map')}>Back to mapping</Button>
        <Button variant="primary" loading={commit.isPending} disabled={importable === 0} onClick={() => commit.mutate()}>
          Import {fmtNumber(importable)} {importable === 1 ? 'row' : 'rows'}
        </Button>
      </>
    ) : (
      <Button variant="primary" onClick={onClose}>
        Done
      </Button>
    );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title={kind === 'products' ? 'Import products' : 'Import price history'}
      description={
        kind === 'products'
          ? 'Add or update catalogue products from a CSV or Excel file.'
          : 'Load historical prices from a CSV or Excel file. Rows keep their original observation dates and are labelled as imported.'
      }
      footer={footer}
    >
      <Stepper step={step} />
      {error ? (
        <Notice tone="crit" className="mb-4">
          {error}
        </Notice>
      ) : null}

      {step === 'upload' ? (
        <div className="flex flex-col gap-4">
          <label className={cn('flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center transition-colors', file ? 'border-navy/50 bg-sunken' : 'border-line-strong hover:border-ink-4')}>
            <span className="flex size-10 items-center justify-center rounded-full bg-wash text-ink-2">{file ? <FileSpreadsheet className="size-4" aria-hidden /> : <Upload className="size-4" aria-hidden />}</span>
            <span className="text-[13.5px] font-medium text-ink">{file ? file.name : 'Choose a CSV or Excel (.xlsx) file'}</span>
            <span className="text-[12.5px] text-ink-3">{file ? `${fmtNumber(Math.max(1, Math.round(file.size / 1024)))} KB · select again to replace` : 'Up to 30 MB. The first row must contain the column names.'}</span>
            <input type="file" className="sr-only" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
            <span>Need a starting point?</span>
            <Button size="sm" icon={Download} onClick={() => void download(`/imports/templates/${kind}.xlsx`, undefined, `${kind}-template.xlsx`).catch((e) => toast.fromError(e))}>
              Excel template
            </Button>
            <Button size="sm" icon={Download} onClick={() => void download(`/imports/templates/${kind}.csv`, undefined, `${kind}-template.csv`).catch((e) => toast.fromError(e))}>
              CSV template
            </Button>
          </div>
          {kind === 'observations' ? (
            <Notice tone="info">
              Each row needs the listing (a listing code, or retailer plus the retailer's item id, URL or a product identifier), a price and — where available — the original observation
              date. Re-importing the same file never creates duplicates. The original file is kept as evidence.
            </Notice>
          ) : (
            <Notice tone="info">Each row needs a product name, brand and category. Existing products can be updated by product ID, SKU or barcode.</Notice>
          )}
        </div>
      ) : null}

      {step === 'map' && stage ? (
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-ink-3">
            <span>
              <span className="font-medium text-ink">{stage.batch.file_name}</span> · {fmtNumber(stage.row_count)} rows · {stage.headers.length} columns · {mappedCount} mapped
            </span>
            {stage.sheets.length > 1 ? (
              <label className="flex items-center gap-2">
                Worksheet
                <Select className="w-48" value={stage.sheet ?? ''} onChange={(e) => switchSheet.mutate(e.target.value)} disabled={switchSheet.isPending}>
                  {stage.sheets.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}
          </div>

          <section>
            <h4 className="eyebrow mb-2">Columns</h4>
            <div className="flex flex-col gap-4">
              {fieldGroups.map(([group, fields]) => (
                <div key={group}>
                  <div className="mb-1.5 text-[12px] font-medium text-ink-2">{group}</div>
                  <div className="grid gap-x-4 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3">
                    {fields.map((f) => (
                      <Field
                        key={f.field}
                        label={
                          <span title={f.description}>
                            {f.label}
                            {f.required === 'yes' ? <span className="text-crit-ink"> *</span> : f.required === 'conditional' ? <span className="text-ink-4"> (one of)</span> : null}
                          </span>
                        }
                        hint={f.description}
                      >
                        <Select value={mapping[f.field] ?? ''} onChange={(e) => setMapping((m) => ({ ...m, [f.field]: e.target.value }))}>
                          <option value="">Not in the file</option>
                          {stage.headers.map((h) => (
                            <option key={h} value={h}>
                              {h}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h4 className="eyebrow mb-2">Options</h4>
            {kind === 'observations' ? (
              <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Date format" hint="Used when a date such as 03/04/2026 is ambiguous.">
                  <Select value={options.date_order ?? 'auto'} onChange={(e) => setOption('date_order', e.target.value as ObservationImportOptions['date_order'])}>
                    <option value="auto">Detect (ISO, or unambiguous)</option>
                    <option value="dmy">Day / month / year</option>
                    <option value="mdy">Month / day / year</option>
                  </Select>
                </Field>
                <Field label="Times without a time zone are in" hint="Timestamps are stored in UTC.">
                  <Select value={options.timezone_mode ?? 'market'} onChange={(e) => setOption('timezone_mode', e.target.value as ObservationImportOptions['timezone_mode'])}>
                    <option value="market">Each market's local time</option>
                    <option value="utc">UTC</option>
                  </Select>
                </Field>
                <Field label="Evidence type" hint="How these prices were originally captured.">
                  <Select value={options.evidence_kind ?? 'csv_file'} onChange={(e) => setOption('evidence_kind', e.target.value as ObservationImportOptions['evidence_kind'])}>
                    <option value="csv_file">Data file / export</option>
                    <option value="screenshot">Transcribed from screenshots</option>
                    <option value="document">Document (price list, report)</option>
                  </Select>
                </Field>
                <Field label="Confidence when a row has none">
                  <Select value={String(options.default_confidence ?? 0.7)} onChange={(e) => setOption('default_confidence', Number(e.target.value))}>
                    <option value="0.95">High</option>
                    <option value="0.7">Medium</option>
                    <option value="0.4">Low</option>
                  </Select>
                </Field>
                <Field label="Availability when a row has none">
                  <Select value={options.default_availability ?? 'unknown'} onChange={(e) => setOption('default_availability', e.target.value as ObservationImportOptions['default_availability'])}>
                    {AVAILABILITY.map((a) => (
                      <option key={a} value={a}>
                        {AVAILABILITY_LABELS[a]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Evidence note" hint="Shown with every imported observation.">
                  <Input value={options.evidence_note ?? ''} onChange={(e) => setOption('evidence_note', e.target.value || null)} placeholder="e.g. retailer screenshots, week 45" maxLength={300} />
                </Field>
                <div className="flex flex-col gap-2 sm:col-span-2 lg:col-span-3">
                  <Checkbox label="Numbers use a decimal comma (12,50)" checked={!!options.decimal_comma} onChange={(e) => setOption('decimal_comma', e.target.checked)} />
                  <Checkbox
                    label="Rows without a date: use the import time and flag them as “original date not available”"
                    checked={!!options.allow_missing_dates}
                    onChange={(e) => setOption('allow_missing_dates', e.target.checked)}
                  />
                  <Checkbox
                    label="Create a listing when the retailer and product are recognised but no listing exists yet"
                    checked={!!options.create_missing_listings}
                    onChange={(e) => setOption('create_missing_listings', e.target.checked)}
                  />
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <Checkbox label="Update products that already exist (matched by product ID, SKU or barcode)" checked={!!options.update_existing} onChange={(e) => setOption('update_existing', e.target.checked)} />
                <Checkbox label="Create brands that do not exist yet (needs an ownership column: own / competitor)" checked={!!options.create_missing_brands} onChange={(e) => setOption('create_missing_brands', e.target.checked)} />
                <Checkbox label="Create categories and subcategories that do not exist yet" checked={!!options.create_missing_categories} onChange={(e) => setOption('create_missing_categories', e.target.checked)} />
              </div>
            )}
          </section>

          <section>
            <h4 className="eyebrow mb-2">First rows of the file</h4>
            <div className="table-wrap max-h-48 overflow-y-auto rounded-lg border border-line">
              <table className="grid-table is-dense">
                <thead>
                  <tr>
                    {stage.headers.map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {stage.sample_rows.slice(0, 6).map((row, i) => (
                    <tr key={i}>
                      {stage.headers.map((h) => (
                        <td key={h} className="max-w-56 truncate whitespace-nowrap">
                          {row[h] ?? ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      ) : null}

      {step === 'review' && validation && summary ? (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: 'Rows in file', value: summary.rows },
              { label: kind === 'products' ? 'To create' : 'New observations', value: kind === 'products' ? (summary.to_create ?? 0) : summary.will_insert, good: true },
              ...(kind === 'products'
                ? [{ label: 'To update', value: summary.to_update ?? 0 }]
                : [{ label: 'Already in the ledger', value: summary.already_in_ledger }]),
              { label: 'Cannot be imported', value: summary.invalid, bad: summary.invalid > 0 },
            ].map((t) => (
              <div key={t.label} className={cn('rounded-lg border px-3 py-2.5', 'bad' in t && t.bad ? 'border-crit/40' : 'border-line')}>
                <div className="eyebrow">{t.label}</div>
                <div className="mt-0.5 text-[20px] leading-7 font-semibold text-ink">{fmtNumber(t.value)}</div>
              </div>
            ))}
          </div>
          <p className="text-[12.5px] leading-5 text-ink-3">
            {kind === 'observations' ? (
              <>
                {summary.listings !== undefined ? `${fmtNumber(summary.listings)} listings at ${fmtNumber(summary.retailers ?? 0)} retailers. ` : ''}
                {summary.date_from ? `Observation dates ${fmtDate(summary.date_from)} – ${fmtDate(summary.date_to)}. ` : ''}
                {summary.duplicates_in_file ? `${fmtNumber(summary.duplicates_in_file)} repeated rows inside the file are imported once. ` : ''}
                {summary.will_supersede ? `${fmtNumber(summary.will_supersede)} rows correct an existing observation for the same timestamp — the earlier record is kept and marked void. ` : ''}
                {summary.listings_to_create ? `${fmtNumber(summary.listings_to_create)} listings will be created. ` : ''}
              </>
            ) : (
              <>
                {summary.brands_to_create ? `${fmtNumber(summary.brands_to_create)} brands will be created. ` : ''}
                {summary.categories_to_create ? `${fmtNumber(summary.categories_to_create)} categories will be created. ` : ''}
              </>
            )}
            {summary.example_rows_skipped ? `${fmtNumber(summary.example_rows_skipped)} template example rows are ignored. ` : ''}
            Nothing has been written yet.
          </p>
          <IssueList issues={validation.errors} total={validation.error_total} tone="crit" />
          <IssueList issues={validation.warnings} total={validation.warning_total} tone="warn" />
          {validation.preview.length ? (
            <section>
              <h4 className="eyebrow mb-2">How the first rows will be stored</h4>
              <div className="table-wrap max-h-64 overflow-y-auto rounded-lg border border-line">
                {kind === 'observations' ? (
                  <table className="grid-table is-dense">
                    <thead>
                      <tr>
                        <th>Row</th>
                        <th>Product</th>
                        <th>Retailer</th>
                        <th>Observed</th>
                        <th style={{ textAlign: 'right' }}>Regular</th>
                        <th style={{ textAlign: 'right' }}>Selling</th>
                        <th>Promotion</th>
                        <th>Availability</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(validation.preview as ObservationImportPreviewRow[]).map((r) => (
                        <tr key={r.row}>
                          <td className="num">{r.row}</td>
                          <td>
                            {r.product ?? '—'} {r.new_listing ? <Badge tone="accent">new listing</Badge> : null}
                          </td>
                          <td className="whitespace-nowrap">
                            {r.retailer} · {r.market}
                          </td>
                          <td className="whitespace-nowrap">
                            <MarketTime iso={r.observed_at} short /> {r.observed_basis !== 'exact' ? <Badge tone="outline">{r.observed_basis === 'date_only' ? 'date only' : 'import time'}</Badge> : null}
                          </td>
                          <td className="num" style={{ textAlign: 'right' }}>
                            {fmtPrice(r.regular_price, r.currency)}
                          </td>
                          <td className="num" style={{ textAlign: 'right' }}>
                            {fmtPrice(r.current_price, r.currency)} <span className="text-[11px] text-ink-3">{r.currency}</span>
                          </td>
                          <td>{r.is_promo ? `${r.discount_pct !== null ? `${r.discount_pct}% ` : ''}${r.promo_type ?? ''}` : '—'}</td>
                          <td>{AVAILABILITY_LABELS[r.availability]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <table className="grid-table is-dense">
                    <thead>
                      <tr>
                        <th>Row</th>
                        <th>Action</th>
                        <th>Product</th>
                        <th>Brand</th>
                        <th>Category</th>
                        <th>Pack</th>
                        <th>SKU</th>
                        <th>Markets</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(validation.preview as ProductImportPreviewRow[]).map((r) => (
                        <tr key={r.row}>
                          <td className="num">{r.row}</td>
                          <td>
                            <Badge tone={r.action === 'create' ? 'good' : 'accent'}>{r.action === 'create' ? 'Create' : 'Update'}</Badge>
                          </td>
                          <td>{r.name}</td>
                          <td>
                            {r.brand} {r.new_brand ? <Badge tone="accent">new</Badge> : null}
                          </td>
                          <td>{[r.category, r.subcategory].filter(Boolean).join(' › ')}</td>
                          <td className="whitespace-nowrap">{r.pack}</td>
                          <td className="mono">{r.sku ?? '—'}</td>
                          <td>{r.markets.join(', ') || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}

      {step === 'done' && result ? (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <span className="flex size-11 items-center justify-center rounded-full bg-good-soft text-good-ink">
            <CircleCheck className="size-5" aria-hidden />
          </span>
          <p className="text-[15px] font-semibold text-ink">
            {kind === 'products'
              ? `${fmtNumber(result.inserted)} products created, ${fmtNumber(result.updated)} updated`
              : `${fmtNumber(result.inserted)} ${noun} added to the ledger`}
          </p>
          <p className="max-w-lg text-[12.5px] leading-5 text-ink-3">
            {result.duplicates ? `${fmtNumber(result.duplicates)} rows were already present and were not duplicated. ` : ''}
            {result.superseded ? `${fmtNumber(result.superseded)} earlier records were superseded (kept, marked void). ` : ''}
            {result.listings_created ? `${fmtNumber(result.listings_created)} listings were created. ` : ''}
            {result.skipped_invalid ? `${fmtNumber(result.skipped_invalid)} invalid rows were skipped. ` : ''}
            {kind === 'observations' ? 'Imported observations are labelled “Imported history” everywhere, with their original dates and this file as evidence.' : ''}
          </p>
          {result.error_total ? <IssueList issues={result.errors} total={result.error_total} tone="crit" /> : null}
        </div>
      ) : null}
    </Dialog>
  );
}
