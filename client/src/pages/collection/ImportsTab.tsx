/**
 * Imports & manual entry: the two people-driven ways prices enter the ledger, and the history of every
 * imported file. Voiding an import never deletes anything — its observations are kept and marked void.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router';
import { CircleCheck, CircleX, Download, FileClock, FileSpreadsheet, FileUp, FlaskConical, Keyboard, PackagePlus, TriangleAlert, Undo2, type LucideIcon } from 'lucide-react';
import { apiPost, download, type Paged } from '@/lib/api.ts';
import { useCan } from '@/lib/auth.tsx';
import { DASH, fmtBytes, fmtDate, fmtNumber, plural } from '@/lib/format.ts';
import { useApiQuery } from '@/lib/hooks.ts';
import { ConfirmDialog, Drawer, useToast } from '@/components/ui/overlays.tsx';
import { Badge, Button, Card, CardHeader, DescriptionList, EmptyState, ErrorState, Field, LoadingBlock, Notice, Segmented, Textarea, type BadgeTone } from '@/components/ui/primitives.tsx';
import { DataTable, Pagination, type Column } from '@/components/ui/data-table.tsx';
import { FilterBar, MultiSelect } from '@/components/ui/filters.tsx';
import { DataClassBadge, DemoBadge } from '@/components/domain/domain.tsx';
import { ImportWizard } from '@/components/domain/import-wizard.tsx';
import { ManualObservationDialog } from '@/components/domain/observations.tsx';
import type { EvidenceRecord, ImportBatch, ImportIssue, ImportKind, ImportStatus, ImportSummary, ImportVoidResponse } from '@shared/api/observations.ts';
import { errorText, Fact, SectionTitle, useCollectionActions, ViewerTime } from './shared.tsx';
import { cleared, countActive, IMPORT_FILTER_KEYS, useCollectionUrl } from './url.ts';

/** GET /api/imports/:id — the batch plus the report stored with it. */
interface ImportBatchDetail {
  batch: ImportBatch;
  errors: ImportIssue[];
  error_total: number;
  warnings: ImportIssue[];
  warning_total: number;
  summary: ImportSummary | null;
  result: Record<string, number> | null;
}

const KIND_LABELS: Record<ImportKind, string> = { observations: 'Price history', products: 'Products' };

const STATUS_META: Record<ImportStatus, { label: string; tone: BadgeTone; icon: LucideIcon; hint: string }> = {
  staged: { label: 'Uploaded — not imported', tone: 'neutral', icon: FileClock, hint: 'The file was uploaded but the import was never completed. Nothing from it is in the ledger.' },
  validated: { label: 'Checked — not imported', tone: 'accent', icon: FileClock, hint: 'The file was validated (a dry run) but never imported. Nothing from it is in the ledger.' },
  committed: { label: 'Imported', tone: 'good', icon: CircleCheck, hint: 'The valid rows were written.' },
  failed: { label: 'Failed', tone: 'crit', icon: CircleX, hint: 'The import failed. Nothing was written.' },
  voided: { label: 'Voided', tone: 'outline', icon: Undo2, hint: 'Withdrawn: its observations are kept in the ledger, marked void and excluded from analytics.' },
};
const STATUSES = Object.keys(STATUS_META) as ImportStatus[];

function StatusBadge({ status }: { status: ImportStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.staged;
  return (
    <Badge tone={meta.tone} icon={meta.icon} title={meta.hint}>
      {meta.label}
    </Badge>
  );
}

function IssueList({ issues, total, tone }: { issues: ImportIssue[]; total: number; tone: 'crit' | 'warn' }) {
  if (!total) return null;
  return (
    <div className={tone === 'crit' ? 'rounded-lg border border-crit/35' : 'rounded-lg border border-warn/60'}>
      <div className={`flex items-center gap-2 px-3 py-2 text-[12.5px] font-medium ${tone === 'crit' ? 'bg-crit-soft text-crit-ink' : 'bg-warn-soft text-warn-ink'}`}>
        <TriangleAlert className="size-3.5" aria-hidden />
        {tone === 'crit' ? `${fmtNumber(total)} row${total === 1 ? ' was' : 's were'} rejected and not imported` : `${fmtNumber(total)} warning${total === 1 ? '' : 's'}`}
      </div>
      <ul className="max-h-56 divide-y divide-line overflow-y-auto text-[12.5px]">
        {issues.map((issue, i) => (
          <li key={i} className="flex gap-3 px-3 py-1.5">
            <span className="num w-16 shrink-0 text-ink-3">Row {issue.row}</span>
            <span className="min-w-0 text-ink-2">
              {issue.field ? <span className="mono text-ink-3">{issue.field}: </span> : null}
              {issue.message}
            </span>
          </li>
        ))}
      </ul>
      {total > issues.length ? <p className="border-t border-line px-3 py-1.5 text-[12px] text-ink-3">Showing the first {fmtNumber(issues.length)}.</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Import detail
// ---------------------------------------------------------------------------------------------
function ImportDrawer({ batchId, onClose }: { batchId: number | null; onClose: () => void }) {
  const toast = useToast();
  const actions = useCollectionActions();
  const canVoid = useCan('observations.void');
  const open = batchId !== null;
  const detail = useApiQuery<ImportBatchDetail>(['imports', 'detail', batchId], `/imports/${batchId}`, undefined, { enabled: open });
  const data = open && detail.data?.batch.id === batchId ? detail.data : undefined;
  const batch = data?.batch;
  const evidence = useApiQuery<EvidenceRecord>(['evidence', batch?.evidence_id], `/evidence/${batch?.evidence_id}`, undefined, { enabled: !!batch?.evidence_id });
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  useEffect(() => {
    setVoiding(false);
    setReason('');
    setReasonError(null);
  }, [batchId]);

  const voidImport = useMutation({
    mutationFn: (id: number) => apiPost<ImportVoidResponse>(`/imports/${id}/void`, { reason: reason.trim() }),
    onSuccess: async (result) => {
      setVoiding(false);
      setReason('');
      toast.success(
        'Import voided',
        `${fmtNumber(result.observations_voided)} observation${result.observations_voided === 1 ? '' : 's'} kept in the ledger and marked void` +
          (result.observations_restored ? `; ${fmtNumber(result.observations_restored)} earlier observation${result.observations_restored === 1 ? '' : 's'} restored` : '') +
          `. ${fmtNumber(result.listings_affected)} listing${result.listings_affected === 1 ? '' : 's'} recalculated.`,
      );
      await actions.refresh();
    },
    onError: (err) => toast.error('The import was not voided', errorText(err)),
  });

  const voidable = !!batch && batch.kind === 'observations' && batch.status === 'committed';
  const options = batch ? Object.entries(batch.options ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== '') : [];
  const mapping = batch ? Object.entries(batch.mapping ?? {}) : [];

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        width="lg"
        title={batch ? batch.file_name : 'Import'}
        subtitle={
          batch ? (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>
                Import #{batch.id} · {KIND_LABELS[batch.kind]}
              </span>
              {batch.is_demo ? <DemoBadge /> : null}
            </span>
          ) : undefined
        }
        footer={
          batch && voidable && canVoid ? (
            <Button variant="danger" icon={Undo2} onClick={() => setVoiding(true)}>
              Void this import
            </Button>
          ) : undefined
        }
      >
        {!open ? null : detail.isError && !data ? (
          <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
        ) : !data || !batch ? (
          <LoadingBlock />
        ) : (
          <div className="flex flex-col gap-5">
            <section>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={batch.status} />
                {batch.kind === 'observations' ? <DataClassBadge value="imported" /> : null}
              </div>
              <p className="mt-2 text-[13px] leading-5 text-ink-2">{STATUS_META[batch.status]?.hint}</p>
              {batch.is_demo ? (
                <Notice tone="demo" icon={FlaskConical} className="mt-3" title="Part of the demo dataset">
                  This import and its prices are illustrative. No real file was uploaded.
                </Notice>
              ) : null}
              {batch.status === 'voided' ? (
                <Notice tone="warn" icon={Undo2} className="mt-3" title="This import was voided">
                  {batch.voided_by_name ? `By ${batch.voided_by_name}` : 'Voided'}
                  {batch.voided_at ? (
                    <>
                      {' '}
                      on <ViewerTime iso={batch.voided_at} long />
                    </>
                  ) : null}
                  . Reason: {batch.void_reason ?? 'not recorded'}. Its observations are still in the ledger, marked void, and no analysis uses them.
                </Notice>
              ) : null}
              {voidable && !canVoid ? <p className="mt-2 text-[12px] leading-4 text-ink-3">Voiding an import requires the Administrator role.</p> : null}
            </section>

            <section>
              <SectionTitle>Rows</SectionTitle>
              <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-line px-3 py-3 sm:grid-cols-5">
                <Fact label="In the file" value={fmtNumber(batch.row_count)} />
                <Fact label="Valid" value={fmtNumber(batch.valid_count)} />
                <Fact label={batch.kind === 'observations' ? 'Stored' : 'Written'} value={batch.status === 'committed' || batch.status === 'voided' ? fmtNumber(batch.inserted_count) : DASH} hint={batch.status === 'committed' || batch.status === 'voided' ? undefined : 'nothing was imported'} />
                <Fact label="Duplicates skipped" value={fmtNumber(batch.duplicate_count)} />
                <Fact label="Rejected" value={fmtNumber(batch.error_count)} />
              </div>
              {data.summary?.date_from || data.summary?.date_to ? (
                <p className="mt-2 text-[12px] leading-4 text-ink-3">
                  Observation dates in the file: {fmtDate(data.summary.date_from)} – {fmtDate(data.summary.date_to)}
                  {data.summary.listings ? ` · ${plural(data.summary.listings, 'listing')}` : ''}
                  {data.summary.retailers ? ` · ${plural(data.summary.retailers, 'retailer')}` : ''}
                </p>
              ) : null}
              {batch.kind === 'observations' && (batch.status === 'committed' || batch.status === 'voided') ? (
                <p className="mt-2 text-[12px] leading-4 text-ink-3">
                  Imported rows keep their original observation dates.{' '}
                  <Link className="link" to="/history?data_class=imported&period=all">
                    Open imported history in the Historical Price Explorer
                  </Link>
                  .
                </p>
              ) : null}
            </section>

            <section>
              <SectionTitle>File and evidence</SectionTitle>
              <DescriptionList
                items={[
                  { label: 'File', value: batch.file_name },
                  { label: 'Size', value: fmtBytes(batch.size_bytes), hidden: batch.size_bytes === null },
                  { label: 'SHA-256', value: <span className="mono break-all">{batch.sha256}</span>, hidden: !batch.sha256 },
                  { label: 'Uploaded by', value: batch.created_by_name ?? 'Unknown' },
                  { label: 'Uploaded', value: <ViewerTime iso={batch.created_at} long /> },
                  { label: 'Imported', value: batch.committed_at ? <ViewerTime iso={batch.committed_at} long /> : 'Not imported' },
                  {
                    label: 'Evidence',
                    hidden: !batch.evidence_id,
                    value: evidence.data ? (
                      evidence.data.has_file ? (
                        <button type="button" className="link inline-flex items-center gap-1" onClick={() => void download(`/evidence/${evidence.data!.id}/file`, undefined, batch.file_name).catch((err) => toast.error('The file could not be downloaded', errorText(err)))}>
                          <Download className="size-3" aria-hidden /> Original file retained — download
                        </button>
                      ) : (
                        <span className="font-normal text-ink-2">{evidence.data.note ?? 'Recorded without a stored file'}</span>
                      )
                    ) : evidence.isError ? (
                      'Could not be loaded'
                    ) : (
                      'Loading…'
                    ),
                  },
                ]}
              />
            </section>

            <IssueList issues={data.errors} total={data.error_total} tone="crit" />
            <IssueList issues={data.warnings} total={data.warning_total} tone="warn" />

            {options.length || mapping.length ? (
              <section>
                <SectionTitle>How the file was read</SectionTitle>
                <div className="flex flex-col gap-2">
                  {mapping.length ? (
                    <details className="rounded-lg border border-line">
                      <summary className="px-3 py-2 text-[12.5px] font-medium text-ink-2">Column mapping ({mapping.length})</summary>
                      <ul className="divide-y divide-line border-t border-line text-[12.5px]">
                        {mapping.map(([field, header]) => (
                          <li key={field} className="flex justify-between gap-4 px-3 py-1.5">
                            <span className="mono text-ink-3">{field}</span>
                            <span className="text-ink-2">{header}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  {options.length ? (
                    <details className="rounded-lg border border-line">
                      <summary className="px-3 py-2 text-[12.5px] font-medium text-ink-2">Import options ({options.length})</summary>
                      <ul className="divide-y divide-line border-t border-line text-[12.5px]">
                        {options.map(([key, value]) => (
                          <li key={key} className="flex justify-between gap-4 px-3 py-1.5">
                            <span className="mono text-ink-3">{key}</span>
                            <span className="text-right break-words text-ink-2">{typeof value === 'object' ? JSON.stringify(value) : String(value)}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </div>
              </section>
            ) : null}
          </div>
        )}
      </Drawer>

      <ConfirmDialog
        open={voiding && !!batch}
        onClose={() => {
          if (!voidImport.isPending) setVoiding(false);
        }}
        title="Void this import?"
        confirmLabel="Void import"
        danger
        loading={voidImport.isPending}
        onConfirm={() => {
          if (reason.trim().length < 3) {
            setReasonError('Give a reason of at least 3 characters.');
            return;
          }
          setReasonError(null);
          if (batch) voidImport.mutate(batch.id);
        }}
      >
        <p>
          {batch?.inserted_count === 1 ? 'The observation' : `The ${fmtNumber(batch?.inserted_count ?? 0)} observations`} of <strong className="font-semibold text-ink">{batch?.file_name}</strong> will be marked void.
          Nothing is deleted — the ledger keeps every row — but charts, comparisons, alerts and reports stop using them. Observations this import had replaced are restored.
        </p>
        <Field label="Reason (kept in the audit log)" required error={reasonError} className="mt-3">
          <Textarea
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              if (reasonError) setReasonError(null);
            }}
            rows={2}
            maxLength={500}
            placeholder="e.g. Wrong month was uploaded"
            invalid={!!reasonError}
          />
        </Field>
      </ConfirmDialog>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------------------------
function EntryCard({
  icon: Icon, title, children, action, templates, allowed, needs,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  action: ReactNode;
  templates?: ImportKind;
  allowed: boolean;
  needs: string;
}) {
  const toast = useToast();
  const get = (kind: ImportKind, ext: 'csv' | 'xlsx') => void download(`/imports/templates/${kind}.${ext}`, undefined, `${kind}-template.${ext}`).catch((err) => toast.error('The template could not be downloaded', errorText(err)));
  return (
    <Card className="flex flex-col px-4 py-3.5">
      <div className="flex items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-wash text-ink-2">
          <Icon className="size-3.5" aria-hidden />
        </span>
        <h3 className="text-[13.5px] leading-5 font-semibold text-ink">{title}</h3>
      </div>
      <p className="mt-2 text-[12.5px] leading-5 text-ink-2">{children}</p>
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-2 pt-3">
        {allowed ? action : <span className="text-[12px] text-ink-3">{needs}</span>}
        {templates ? (
          <span className="flex items-center gap-1.5 text-[12px] text-ink-3">
            <Download className="size-3" aria-hidden />
            Template:
            <button type="button" className="link" onClick={() => get(templates, 'csv')}>
              CSV
            </button>
            ·
            <button type="button" className="link" onClick={() => get(templates, 'xlsx')}>
              Excel
            </button>
          </span>
        ) : null}
      </div>
    </Card>
  );
}

export function ImportsTab() {
  const actions = useCollectionActions();
  const canObservations = useCan('observations.write');
  const canProducts = useCan('catalogue.write');
  const { state, set } = useCollectionUrl();
  const [wizard, setWizard] = useState<ImportKind | null>(null);
  const [manual, setManual] = useState(false);
  const page = Math.max(1, Number(state.i_page) || 1);
  const kind = state.i_kind === 'observations' || state.i_kind === 'products' ? state.i_kind : 'all';
  const status = STATUSES.includes(state.i_status as ImportStatus) ? (state.i_status as ImportStatus) : undefined;
  const batches = useApiQuery<Paged<ImportBatch>>(['imports', 'list'], '/imports', { kind: kind === 'all' ? undefined : kind, status, page, page_size: 25 });
  const activeFilters = countActive(state, IMPORT_FILTER_KEYS);

  const columns: Array<Column<ImportBatch>> = [
    {
      key: 'file',
      header: 'File',
      cell: (b) => (
        <div className="max-w-[11rem] min-w-[9rem] sm:max-w-[24rem] sm:min-w-[11rem]">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium text-ink" title={b.file_name}>
              {b.file_name}
            </span>
            {b.is_demo ? <DemoBadge /> : null}
          </div>
          <div className="text-[11.5px] text-ink-3">
            #{b.id} · {KIND_LABELS[b.kind]}
            {b.size_bytes !== null ? ` · ${fmtBytes(b.size_bytes)}` : ''}
          </div>
        </div>
      ),
    },
    { key: 'status', header: 'Status', cell: (b) => <StatusBadge status={b.status} /> },
    { key: 'rows', header: 'Rows', align: 'right', hideBelow: 'sm', headerTitle: 'Data rows in the file', cell: (b) => fmtNumber(b.row_count) },
    {
      key: 'accepted',
      header: 'Accepted',
      align: 'right',
      headerTitle: 'Rows written to the ledger (price history) or the catalogue (products)',
      cell: (b) => (b.status === 'committed' || b.status === 'voided' ? <span className="font-medium text-ink">{fmtNumber(b.inserted_count)}</span> : <span className="text-ink-4">{DASH}</span>),
    },
    { key: 'duplicates', header: 'Duplicates', align: 'right', hideBelow: 'md', headerTitle: 'Rows identical to something already stored — skipped, never stored twice', cell: (b) => <span className={b.duplicate_count ? '' : 'text-ink-4'}>{fmtNumber(b.duplicate_count)}</span> },
    { key: 'rejected', header: 'Rejected', align: 'right', hideBelow: 'md', headerTitle: 'Rows with problems — not imported', cell: (b) => <span className={b.error_count ? 'font-medium text-crit-ink' : 'text-ink-4'}>{fmtNumber(b.error_count)}</span> },
    {
      key: 'who',
      header: 'By · when',
      hideBelow: 'lg',
      cell: (b) => (
        <div className="whitespace-nowrap">
          <div className="text-[12.5px] text-ink-2">{b.created_by_name ?? 'Unknown'}</div>
          <ViewerTime iso={b.committed_at ?? b.created_at} className="text-[11.5px] !text-ink-3" />
        </div>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-4 grid gap-3 md:grid-cols-3">
        <EntryCard
          icon={FileUp}
          title="Import price history"
          templates="observations"
          allowed={canObservations}
          needs="Requires the Analyst or Administrator role."
          action={
            <Button variant="primary" icon={FileSpreadsheet} onClick={() => setWizard('observations')}>
              Import CSV or Excel
            </Button>
          }
        >
          Upload past or periodic prices. Every row is validated first, keeps its original observation date and is stored as <strong className="font-semibold text-ink">Imported history</strong> with the file as evidence.
        </EntryCard>
        <EntryCard
          icon={PackagePlus}
          title="Import products"
          templates="products"
          allowed={canProducts}
          needs="Requires the Analyst or Administrator role."
          action={
            <Button icon={FileSpreadsheet} onClick={() => setWizard('products')}>
              Import CSV or Excel
            </Button>
          }
        >
          Create or update catalogue products — own and competitor — from a file, instead of adding them one by one.
        </EntryCard>
        <EntryCard
          icon={Keyboard}
          title="Add a manual observation"
          allowed={canObservations}
          needs="Requires the Analyst or Administrator role."
          action={
            <Button icon={Keyboard} onClick={() => setManual(true)}>
              Add observation
            </Button>
          }
        >
          Type in one price for a listing, with a screenshot or link as evidence if you have one. It is stored as <strong className="font-semibold text-ink">Manual entry</strong> under your name.
        </EntryCard>
      </div>

      <FilterBar activeCount={activeFilters} onReset={() => set({ ...cleared(IMPORT_FILTER_KEYS), i_page: undefined })}>
        <Segmented
          label="Kind"
          value={kind}
          onChange={(next) => set({ i_kind: next === 'all' ? undefined : next, i_page: undefined })}
          options={[
            { value: 'all', label: 'All imports' },
            { value: 'observations', label: 'Price history' },
            { value: 'products', label: 'Products' },
          ]}
        />
        <MultiSelect single label="Status" options={STATUSES.map((s) => ({ value: s, label: STATUS_META[s].label }))} value={status ? [status] : []} onChange={(next) => set({ i_status: next[0], i_page: undefined })} />
      </FilterBar>

      <Card>
        <CardHeader title="Import history" subtitle="Every uploaded file, newest first — including uploads that were never completed. Select a row for its rejected rows, evidence and the option to void it." />
        {batches.isError && !batches.data ? (
          <ErrorState error={batches.error} onRetry={() => void batches.refetch()} />
        ) : (
          <DataTable
            columns={columns}
            rows={batches.data?.rows}
            rowKey={(b) => b.id}
            loading={batches.isPending}
            refetching={batches.isPlaceholderData}
            onRowClick={(b) => set({ import: String(b.id) })}
            selectedKey={state.import ? Number(state.import) : null}
            empty={
              activeFilters > 0 ? (
                <EmptyState title="No import matches these filters" action={<Button size="sm" onClick={() => set({ ...cleared(IMPORT_FILTER_KEYS), i_page: undefined })}>Reset filters</Button>} />
              ) : (
                <EmptyState
                  title="Nothing has been imported yet"
                  description="Download a template, fill it in and import it — or start from any CSV or Excel file and map its columns."
                  action={
                    canObservations ? (
                      <Button size="sm" variant="primary" icon={FileSpreadsheet} onClick={() => setWizard('observations')}>
                        Import price history
                      </Button>
                    ) : undefined
                  }
                />
              )
            }
            footer={batches.data ? <Pagination page={batches.data.page} pages={batches.data.pages} total={batches.data.total} pageSize={batches.data.page_size} onPage={(p) => set({ i_page: String(p) })} noun="imports" /> : undefined}
          />
        )}
      </Card>

      <ImportDrawer batchId={state.import ? Number(state.import) || null : null} onClose={() => set({ import: undefined })} />
      <ImportWizard open={wizard !== null} kind={wizard ?? 'observations'} onClose={() => setWizard(null)} onCommitted={() => void actions.refresh()} />
      <ManualObservationDialog open={manual} onClose={() => setManual(false)} onSaved={() => void actions.refresh()} />
    </div>
  );
}
