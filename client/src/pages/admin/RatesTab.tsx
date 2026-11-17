/** Exchange rates: every conversion in the product states its rate, timestamp and source — this is where they come from. */
import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CloudDownload, FlaskConical, History, Plus } from 'lucide-react';
import { apiGet, apiPost } from '@/lib/api.ts';
import { useCan } from '@/lib/auth.tsx';
import { fmtDateTime, fmtHours, fmtNumber } from '@/lib/format.ts';
import { useReference } from '@/lib/hooks.ts';
import { Dialog, Drawer, useToast } from '@/components/ui/overlays.tsx';
import { Button, Card, CardHeader, EmptyState, ErrorState, Field, IconButton, Input, LoadingBlock, Notice, Select } from '@/components/ui/primitives.tsx';
import { DataTable, type Column } from '@/components/ui/data-table.tsx';
import { DemoBadge } from '@/components/domain/domain.tsx';
import type { ExchangeRateHistoryRow, ExchangeRateRow, ExchangeRatesResponse, FxFetchResult } from '@shared/api/admin.ts';
import { errorText, useRefresh } from './shared.tsx';

const rateText = (rate: number) => (rate >= 100 ? fmtNumber(rate, 2) : rate >= 1 ? fmtNumber(rate, 4) : rate.toPrecision(4));

function ManualRateDialog({ open, onClose, existing }: { open: boolean; onClose: () => void; existing: ExchangeRatesResponse | undefined }) {
  const toast = useToast();
  const refresh = useRefresh();
  const { ref } = useReference();
  const [currency, setCurrency] = useState('');
  const [rate, setRate] = useState('');
  const [asOf, setAsOf] = useState('');
  const [sourceRef, setSourceRef] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setCurrency('');
    setRate('');
    setAsOf('');
    setSourceRef('');
  }, [open]);

  const current = existing?.rates.find((r) => r.currency === currency);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const value = Number(rate);
    if (!currency) return setError('Choose a currency.');
    if (!(value > 0)) return setError('The rate must be a number greater than zero.');
    setBusy(true);
    try {
      await apiPost('/exchange-rates', {
        currency,
        rate: value,
        as_of: asOf ? new Date(asOf).toISOString() : undefined,
        source_ref: sourceRef.trim() || null,
      });
      toast.success('Rate recorded', `1 USD = ${rateText(value)} ${currency}`);
      await refresh(['exchange-rates'], ['integrations'], ['analytics'], ['market-intel'], ['history'], ['competitors']);
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a manual exchange rate"
      description="Rates are recorded against the US dollar and kept as history — a new rate never overwrites an earlier one."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="manual-rate-form" loading={busy}>
            Record rate
          </Button>
        </>
      }
    >
      <form id="manual-rate-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        {error ? (
          <Notice tone="crit" className="sm:col-span-2">
            {error}
          </Notice>
        ) : null}
        <Field label="Currency" required>
          <Select value={currency} onChange={(e) => setCurrency(e.target.value)} required>
            <option value="">Choose…</option>
            {(ref?.currencies ?? [])
              .filter((c) => c.code !== 'USD')
              .map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label={`Units of ${currency || 'the currency'} per 1 USD`} required hint={current ? `Latest on record: ${rateText(current.rate)} (${current.source})` : undefined}>
          <Input type="number" inputMode="decimal" step="any" min="0" value={rate} onChange={(e) => setRate(e.target.value)} required placeholder="e.g. 3.6725" />
        </Field>
        <Field label="Rate valid as of" hint="Your local time. Leave empty to use now.">
          <Input type="datetime-local" value={asOf} onChange={(e) => setAsOf(e.target.value)} max={new Date(Date.now() + 86_400_000).toISOString().slice(0, 16)} />
        </Field>
        <Field label="Where the rate comes from" hint="Shown as the source reference, e.g. “Central bank bulletin, 17 Nov”.">
          <Input value={sourceRef} onChange={(e) => setSourceRef(e.target.value)} maxLength={500} />
        </Field>
      </form>
    </Dialog>
  );
}

function HistoryDrawer({ currency, onClose }: { currency: string | null; onClose: () => void }) {
  const history = useQuery({
    queryKey: ['exchange-rates', 'history', currency],
    queryFn: () => apiGet<{ currency: string; base: string; rows: ExchangeRateHistoryRow[] }>('/exchange-rates/history', { currency: currency ?? '' }),
    enabled: currency !== null,
  });
  const columns: Array<Column<ExchangeRateHistoryRow>> = [
    { key: 'as_of', header: 'As of (UTC)', nowrap: true, cell: (r) => <span className="num">{fmtDateTime(r.as_of, 'UTC')}</span> },
    { key: 'rate', header: 'Per 1 USD', align: 'right', cell: (r) => rateText(r.rate) },
    {
      key: 'source',
      header: 'Source',
      cell: (r) => (
        <div className="min-w-[9rem]">
          <span className="flex items-center gap-1.5 text-ink-2">
            {r.source}
            {r.is_demo ? <DemoBadge /> : null}
          </span>
          {r.source_ref ? <div className="line-clamp-2 text-[11.5px] break-words text-ink-3">{r.source_ref}</div> : null}
        </div>
      ),
    },
    { key: 'by', header: 'Entered by', hideBelow: 'sm', cell: (r) => <span className="text-ink-3">{r.entered_by_name ?? (r.source === 'manual' ? '—' : 'Automatic')}</span> },
  ];
  return (
    <Drawer open={currency !== null} onClose={onClose} width="lg" title={`Rate history — ${currency ?? ''}`} subtitle="Units of the currency per 1 USD. Newest first; nothing is ever overwritten.">
      {history.isPending ? (
        <LoadingBlock />
      ) : history.isError ? (
        <ErrorState error={history.error} onRetry={() => void history.refetch()} />
      ) : (
        <div className="rounded-lg border border-line">
          <DataTable columns={columns} rows={history.data?.rows} rowKey={(r) => r.id} dense empty={<EmptyState title="No rate on record for this currency" />} />
        </div>
      )}
    </Drawer>
  );
}

export function RatesTab() {
  const canWrite = useCan('admin.settings');
  const toast = useToast();
  const refresh = useRefresh();
  const rates = useQuery({ queryKey: ['exchange-rates'], queryFn: () => apiGet<ExchangeRatesResponse>('/exchange-rates') });
  const [manualOpen, setManualOpen] = useState(false);
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchResult, setFetchResult] = useState<{ ok: true; result: FxFetchResult } | { ok: false; error: string } | null>(null);

  async function fetchFromProvider() {
    setFetching(true);
    setFetchResult(null);
    try {
      const result = await apiPost<FxFetchResult>('/exchange-rates/fetch');
      setFetchResult({ ok: true, result });
      toast.success('Rates fetched', `${fmtNumber(result.inserted)} new rate${result.inserted === 1 ? '' : 's'} from ${result.source}`);
      await refresh(['exchange-rates'], ['integrations'], ['analytics'], ['market-intel'], ['history'], ['competitors']);
    } catch (err) {
      setFetchResult({ ok: false, error: errorText(err) });
    } finally {
      setFetching(false);
    }
  }

  const data = rates.data;
  // Currencies just fetched for which a demo rate with a newer timestamp is still the latest on record.
  const shadowed = fetchResult?.ok ? (data?.rates ?? []).filter((r) => r.is_demo && fetchResult.result.currencies.includes(r.currency)).map((r) => r.currency) : [];
  const reporting = data?.reporting_currency;
  const reportingRate = reporting === 'USD' ? 1 : data?.rates.find((r) => r.currency === reporting)?.rate;
  const columns: Array<Column<ExchangeRateRow>> = [
    {
      key: 'currency',
      header: 'Currency',
      cell: (r) => (
        <div>
          <span className="num font-medium text-ink">{r.currency}</span>
          {r.currency === reporting ? <span className="ml-1.5 text-[11.5px] text-ink-3">reporting currency</span> : null}
          <div className="text-[11.5px] text-ink-3">{r.currency_name}</div>
        </div>
      ),
    },
    { key: 'rate', header: 'Per 1 USD', align: 'right', cell: (r) => rateText(r.rate) },
    {
      key: 'cross',
      header: reporting ? `1 unit in ${reporting}` : 'In reporting currency',
      align: 'right',
      hideBelow: 'sm',
      headerTitle: 'Derived from the two USD rates shown in this table',
      cell: (r) => (reportingRate ? rateText(reportingRate / r.rate) : <span className="text-ink-4">—</span>),
    },
    { key: 'as_of', header: 'As of (UTC)', hideBelow: 'md', nowrap: true, cell: (r) => <span className="num text-ink-2">{fmtDateTime(r.as_of, 'UTC')}</span> },
    { key: 'age', header: 'Age', align: 'right', hideBelow: 'lg', cell: (r) => <span className="text-ink-2">{fmtHours(r.age_hours)}</span> },
    {
      key: 'source',
      header: 'Source',
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-1.5 text-ink-2">
          {r.is_demo ? <DemoBadge /> : null}
          <span className="min-w-0">{r.source}</span>
        </span>
      ),
    },
    {
      key: 'history',
      header: <span className="sr-only">History</span>,
      align: 'right',
      width: '44px',
      cell: (r) => <IconButton icon={History} label={`Rate history of ${r.currency}`} size="sm" onClick={() => setHistoryOf(r.currency)} />,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <Notice tone="info">
        Prices in different currencies are never compared raw. Whenever a view converts prices, it states the rate, the rate’s timestamp and its source — taken from this
        table. Rates are stored against the US dollar as an append-only history.
      </Notice>
      {data?.contains_demo_rates ? (
        <Notice tone="demo" icon={FlaskConical} title="Illustrative demo rates are in use">
          Rates marked DEMO are fictional values that ship with the demo dataset. Fetch rates from the provider or record your own before relying on converted comparisons.
        </Notice>
      ) : null}
      {data?.missing.length ? (
        <Notice tone="warn" title="Currencies without a rate">
          No rate is on record for {data.missing.map((m) => m.code).join(', ')}. Conversions involving them are unavailable — a rate is never guessed.
        </Notice>
      ) : null}
      {fetchResult ? (
        fetchResult.ok ? (
          <Notice tone="good" title={`Fetched from ${fetchResult.result.source}`}>
            {fmtNumber(fetchResult.result.inserted)} new rate{fetchResult.result.inserted === 1 ? '' : 's'} stored, {fmtNumber(fetchResult.result.unchanged)} already on record,
            published {fmtDateTime(fetchResult.result.as_of, 'UTC')} UTC. Currencies: {fetchResult.result.currencies.join(', ') || 'none of the configured currencies'}.
            {shadowed.length ? (
              <p className="mt-1">
                For {shadowed.join(', ')} the table still shows the DEMO rate: its timestamp is newer than the provider’s publication time, and the newest rate on record is
                the one in use. Removing the demo dataset (Database tab) leaves only real rates.
              </p>
            ) : null}
          </Notice>
        ) : (
          <Notice tone="crit" title="The provider request failed — nothing was stored">
            {fetchResult.error}
          </Notice>
        )
      ) : null}

      <Card>
        <CardHeader
          title="Latest exchange rates"
          subtitle={`Base currency USD${reporting ? ` · reporting currency ${reporting}` : ''}${data ? ` · automatic daily refresh ${data.auto_refresh ? 'on' : 'off'}` : ''}`}
          actions={
            canWrite ? (
              <>
                <Button icon={CloudDownload} onClick={() => void fetchFromProvider()} loading={fetching}>
                  Fetch from provider
                </Button>
                <Button variant="primary" icon={Plus} onClick={() => setManualOpen(true)}>
                  Add manual rate
                </Button>
              </>
            ) : undefined
          }
        />
        {rates.isError ? (
          <ErrorState error={rates.error} onRetry={() => void rates.refetch()} />
        ) : (
          <DataTable
            columns={columns}
            rows={data?.rates}
            rowKey={(r) => r.currency}
            loading={rates.isPending}
            refetching={rates.isFetching && !rates.isPending}
            empty={<EmptyState title="No exchange rates on record" description="Fetch rates from the provider or add them manually. Until then, cross-currency comparisons are unavailable." />}
          />
        )}
      </Card>
      {!canWrite ? <p className="text-[12px] text-ink-3">Only administrators can record or fetch rates.</p> : null}

      <ManualRateDialog open={manualOpen} onClose={() => setManualOpen(false)} existing={data} />
      <HistoryDrawer currency={historyOf} onClose={() => setHistoryOf(null)} />
    </div>
  );
}
