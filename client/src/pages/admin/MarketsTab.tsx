/** Markets: each has its own currency, time zone, default collection schedule, retailers and listings. */
import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Ellipsis, Pencil, Plus, Trash2 } from 'lucide-react';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api.ts';
import { useCan } from '@/lib/auth.tsx';
import { fmtNumber, tzLabel } from '@/lib/format.ts';
import { useReference } from '@/lib/hooks.ts';
import { ConfirmDialog, Dialog, Menu, useToast } from '@/components/ui/overlays.tsx';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, IconButton, Input, Notice, Select, Switch, Textarea } from '@/components/ui/primitives.tsx';
import { DataTable, type Column } from '@/components/ui/data-table.tsx';
import { FrequencyLabel } from '@/components/domain/domain.tsx';
import { FREQUENCIES, FREQUENCY_LABELS, type Frequency } from '@shared/constants.ts';
import type { MarketRow } from '@shared/api/catalogue.ts';
import { errorText, useRefresh } from './shared.tsx';

interface MarketForm {
  code: string;
  name: string;
  country_name: string;
  country_code: string;
  region: string;
  currency_code: string;
  timezone: string;
  default_frequency: Frequency;
  is_active: boolean;
  notes: string;
}

const EMPTY: MarketForm = {
  code: '', name: '', country_name: '', country_code: '', region: '', currency_code: '', timezone: '', default_frequency: 'daily', is_active: true, notes: '',
};

function MarketDialog({ market, open, onClose }: { market: MarketRow | null; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const { ref } = useReference();
  const [form, setForm] = useState<MarketForm>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm(
      market
        ? {
            code: market.code,
            name: market.name,
            country_name: market.country_name ?? '',
            country_code: market.country_code ?? '',
            region: market.region ?? '',
            currency_code: market.currency_code,
            timezone: market.timezone,
            default_frequency: market.default_frequency,
            is_active: market.is_active === 1,
            notes: market.notes ?? '',
          }
        : EMPTY,
    );
  }, [open, market]);

  const update = (changes: Partial<MarketForm>) => setForm((prev) => ({ ...prev, ...changes }));
  const currencyLocked = !!market && market.retailer_count > 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const body = {
      name: form.name.trim(),
      country_name: form.country_name.trim() || null,
      country_code: form.country_code.trim() || null,
      region: form.region.trim() || null,
      currency_code: form.currency_code,
      timezone: form.timezone.trim(),
      default_frequency: form.default_frequency,
      is_active: form.is_active,
      notes: form.notes.trim() || null,
    };
    try {
      if (market) await apiPatch(`/markets/${market.id}`, body);
      else await apiPost('/markets', { ...body, code: form.code.trim().toUpperCase() });
      toast.success(market ? 'Market updated' : 'Market added', form.name);
      await refresh(['markets'], ['reference'], ['market-intel'], ['overview'], ['retailers']);
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
      size="lg"
      title={market ? `Edit market — ${market.name}` : 'Add market'}
      description="A market has its own currency, time zone and default collection schedule. Retailers are then added to it."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="market-form" loading={busy}>
            {market ? 'Save changes' : 'Add market'}
          </Button>
        </>
      }
    >
      <form id="market-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        {error ? (
          <Notice tone="crit" className="sm:col-span-2">
            {error}
          </Notice>
        ) : null}
        <Field label="Market name" required>
          <Input value={form.name} onChange={(e) => update({ name: e.target.value })} required maxLength={120} placeholder="e.g. Nigeria" />
        </Field>
        <Field label="Code" required hint={market ? 'The code cannot be changed once the market exists.' : '2–12 letters or digits, e.g. the ISO country code.'}>
          <Input value={form.code} onChange={(e) => update({ code: e.target.value.toUpperCase() })} disabled={!!market} required maxLength={12} placeholder="NG" className="mono" />
        </Field>
        <Field label="Country">
          <Input value={form.country_name} onChange={(e) => update({ country_name: e.target.value })} maxLength={120} placeholder="Defaults to the market name" />
        </Field>
        <Field label="Region">
          <Input value={form.region} onChange={(e) => update({ region: e.target.value })} maxLength={80} placeholder="e.g. West Africa" />
        </Field>
        <Field label="Currency" required hint={currencyLocked ? 'Fixed: this market already has retailers.' : 'Prices in this market are recorded in this currency.'}>
          <Select value={form.currency_code} onChange={(e) => update({ currency_code: e.target.value })} disabled={currencyLocked} required>
            <option value="">Choose a currency…</option>
            {(ref?.currencies ?? []).map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} — {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Time zone (IANA)" required hint="For example Africa/Lagos or Asia/Dubai. Observation times are shown in this zone.">
          <Input value={form.timezone} onChange={(e) => update({ timezone: e.target.value })} required maxLength={64} placeholder="Africa/Lagos" />
        </Field>
        <Field label="Default collection frequency" hint="Retailers in this market follow it unless they set their own.">
          <Select value={form.default_frequency} onChange={(e) => update({ default_frequency: e.target.value as Frequency })}>
            {FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {FREQUENCY_LABELS[f]}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex items-center justify-between gap-4 rounded-lg border border-line px-3.5 py-2.5">
          <div>
            <div className="text-[13px] font-medium text-ink">Active</div>
            <div className="text-[12px] text-ink-3">Inactive markets are left out of filters and overviews.</div>
          </div>
          <Switch checked={form.is_active} onChange={(next) => update({ is_active: next })} label="Market active" />
        </div>
        <Field label="Notes" className="sm:col-span-2">
          <Textarea value={form.notes} onChange={(e) => update({ notes: e.target.value })} maxLength={1000} rows={2} />
        </Field>
      </form>
    </Dialog>
  );
}

export function MarketsTab() {
  const canWrite = useCan('admin.settings');
  const toast = useToast();
  const refresh = useRefresh();
  const markets = useQuery({ queryKey: ['markets'], queryFn: () => apiGet<{ rows: MarketRow[] }>('/markets') });
  const [editing, setEditing] = useState<MarketRow | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<MarketRow | null>(null);
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try {
      await apiDelete(`/markets/${deleting.id}`);
      toast.success('Market deleted', deleting.name);
      setDeleting(null);
      await refresh(['markets'], ['reference'], ['market-intel'], ['overview']);
    } catch (err) {
      toast.error('The market was not deleted', errorText(err));
      setDeleting(null);
    } finally {
      setBusy(false);
    }
  }

  async function setActive(market: MarketRow, active: boolean) {
    try {
      await apiPatch(`/markets/${market.id}`, { is_active: active });
      toast.success(active ? 'Market activated' : 'Market deactivated', market.name);
      await refresh(['markets'], ['reference'], ['market-intel'], ['overview']);
    } catch (err) {
      toast.error('The market was not changed', errorText(err));
    }
  }

  const columns: Array<Column<MarketRow>> = [
    {
      key: 'name',
      header: 'Market',
      cell: (m) => (
        <div className="min-w-[6.5rem] sm:min-w-[8rem]">
          <span className="font-medium text-ink">{m.name}</span> <span className="mono text-ink-3">{m.code}</span>
          <div className="text-[11.5px] text-ink-3">{[m.country_name !== m.name ? m.country_name : null, m.region].filter(Boolean).join(' · ') || '—'}</div>
        </div>
      ),
    },
    { key: 'currency', header: 'Currency', cell: (m) => <span className="num font-medium text-ink-2">{m.currency_code}</span> },
    {
      key: 'timezone',
      header: 'Time zone',
      hideBelow: 'md',
      cell: (m) => (
        <span className="whitespace-nowrap text-ink-2">
          {m.timezone} <span className="text-[11px] text-ink-4">{tzLabel(m.timezone)}</span>
        </span>
      ),
    },
    { key: 'frequency', header: 'Default schedule', hideBelow: 'sm', nowrap: true, cell: (m) => <FrequencyLabel frequency={m.default_frequency} /> },
    {
      key: 'retailers',
      header: 'Retailers',
      align: 'right',
      headerTitle: 'Active retailers / all retailers',
      cell: (m) => (
        <span>
          {fmtNumber(m.active_retailer_count)}
          {m.retailer_count !== m.active_retailer_count ? <span className="text-ink-3"> / {fmtNumber(m.retailer_count)}</span> : null}
        </span>
      ),
    },
    { key: 'listings', header: 'Listings', align: 'right', hideBelow: 'sm', cell: (m) => fmtNumber(m.listing_count) },
    { key: 'products', header: 'Products listed', align: 'right', hideBelow: 'lg', cell: (m) => fmtNumber(m.listed_product_count) },
    { key: 'active', header: 'Status', hideBelow: 'md', cell: (m) => <Badge tone={m.is_active ? 'good' : 'outline'}>{m.is_active ? 'Active' : 'Inactive'}</Badge> },
    ...(canWrite
      ? [
          {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            align: 'right' as const,
            width: '52px',
            cell: (m: MarketRow) => (
              <Menu
                trigger={<IconButton icon={Ellipsis} label={`Actions for ${m.name}`} size="sm" />}
                items={[
                  {
                    label: 'Edit',
                    icon: Pencil,
                    onSelect: () => {
                      setEditing(m);
                      setDialogOpen(true);
                    },
                  },
                  { label: m.is_active ? 'Deactivate' : 'Activate', onSelect: () => void setActive(m, !m.is_active) },
                  { label: 'Delete', icon: Trash2, danger: true, separatorBefore: true, onSelect: () => setDeleting(m) },
                ]}
              />
            ),
          } satisfies Column<MarketRow>,
        ]
      : []),
  ];

  return (
    <div>
      <Card>
        <CardHeader
          title="Markets"
          subtitle="The markets being monitored. Add a market here, then add its retailers under Retailers & listings."
          actions={
            canWrite ? (
              <Button
                variant="primary"
                icon={Plus}
                onClick={() => {
                  setEditing(null);
                  setDialogOpen(true);
                }}
              >
                Add market
              </Button>
            ) : undefined
          }
        />
        {markets.isError ? (
          <ErrorState error={markets.error} onRetry={() => void markets.refetch()} />
        ) : (
          <DataTable
            columns={columns}
            rows={markets.data?.rows}
            rowKey={(m) => m.id}
            loading={markets.isPending}
            refetching={markets.isFetching && !markets.isPending}
            empty={<EmptyState title="No markets yet" description="Add the first market to start configuring retailers." />}
          />
        )}
      </Card>
      {!canWrite ? <p className="mt-2 text-[12px] text-ink-3">Only administrators can add or change markets.</p> : null}

      <MarketDialog market={editing} open={dialogOpen} onClose={() => setDialogOpen(false)} />
      <ConfirmDialog open={deleting !== null} onClose={() => setDeleting(null)} onConfirm={() => void remove()} title="Delete this market?" confirmLabel="Delete market" danger loading={busy}>
        <p>
          <strong className="font-semibold text-ink">{deleting?.name}</strong> can only be deleted while it has no retailers. A market with retailers is deactivated instead so
          its price history stays intact.
        </p>
      </ConfirmDialog>
    </div>
  );
}
