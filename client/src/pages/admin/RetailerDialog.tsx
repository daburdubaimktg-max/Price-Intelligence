/** Add / edit a retailer (collection source): basics, schedule, connector configuration, credential, access permission. */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FlaskConical, ShieldCheck } from 'lucide-react';
import { apiGet, apiPatch, apiPost, apiPut } from '@/lib/api.ts';
import { fmtDateTime } from '@/lib/format.ts';
import { useReference } from '@/lib/hooks.ts';
import { Dialog, useToast } from '@/components/ui/overlays.tsx';
import { Button, Checkbox, ErrorState, Field, Input, LoadingBlock, Notice, Select, Switch, Textarea } from '@/components/ui/primitives.tsx';
import {
  AUTOMATED_METHODS, COLLECTION_METHODS, COLLECTION_METHOD_LABELS, FREQUENCIES, FREQUENCY_LABELS, type CollectionMethod, type Frequency,
} from '@shared/constants.ts';
import type { RetailerRow } from '@shared/api/catalogue.ts';
import type { ConnectorDescription } from '@shared/api/collection.ts';
import { cleanConfig, ConnectorConfigForm, type ConfigObject } from './ConnectorConfigForm.tsx';
import { errorText, SecretField, useRefresh } from './shared.tsx';

interface RetailerForm {
  name: string;
  website: string;
  market_id: string;
  collection_method: CollectionMethod;
  collection_frequency: Frequency | '';
  rate_limit_ms: string;
  notes: string;
  is_enabled: boolean;
  config: ConfigObject;
  credential: string;
  attest: boolean;
  attestNote: string;
  withdraw: boolean;
}

const EMPTY: RetailerForm = {
  name: '', website: '', market_id: '', collection_method: 'manual', collection_frequency: '', rate_limit_ms: '3000', notes: '', is_enabled: true,
  config: {}, credential: '', attest: false, attestNote: '', withdraw: false,
};

export function useConnectors(enabled = true) {
  return useQuery({
    queryKey: ['collection', 'connectors'],
    queryFn: () => apiGet<{ rows: ConnectorDescription[] }>('/collection/connectors'),
    staleTime: 10 * 60_000,
    enabled,
  });
}

export function RetailerDialog({ retailer, open, onClose, onSaved }: { retailer: RetailerRow | null; open: boolean; onClose: () => void; onSaved?: (id: number) => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const { ref } = useReference();
  const connectors = useConnectors(open);
  const [form, setForm] = useState<RetailerForm>(EMPTY);
  const [savedId, setSavedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [jsonValid, setJsonValid] = useState(true);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSavedId(retailer?.id ?? null);
    setJsonValid(true);
    setForm(
      retailer
        ? {
            name: retailer.name,
            website: retailer.website ?? '',
            market_id: String(retailer.market_id),
            collection_method: retailer.collection_method,
            collection_frequency: retailer.collection_frequency ?? '',
            rate_limit_ms: String(retailer.rate_limit_ms),
            notes: retailer.notes ?? '',
            is_enabled: retailer.is_enabled === 1,
            config: retailer.collection_method === 'simulated' ? {} : (retailer.connector_config ?? {}),
            credential: '',
            attest: false,
            attestNote: '',
            withdraw: false,
          }
        : EMPTY,
    );
  }, [open, retailer]);

  const update = (changes: Partial<RetailerForm>) => setForm((prev) => ({ ...prev, ...changes }));
  const isDemo = retailer?.is_demo === 1;
  const isSimulated = form.collection_method === 'simulated';
  const marketLocked = !!retailer && (isDemo || retailer.observation_count > 0);
  const market = ref?.markets.find((m) => String(m.id) === form.market_id);
  const connector = connectors.data?.rows.find((c) => c.method === form.collection_method);
  const automated = AUTOMATED_METHODS.includes(form.collection_method);
  const methodOptions = useMemo(() => COLLECTION_METHODS.filter((m) => m !== 'simulated' || isDemo), [isDemo]);
  const attested = retailer?.permission_attested === 1;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!jsonValid) return setError('The connector configuration is not valid JSON yet. Fix it or switch back to the form.');
    if (!form.market_id) return setError('Choose the market this retailer belongs to.');
    const rateLimit = Number(form.rate_limit_ms);
    if (!Number.isFinite(rateLimit) || rateLimit < 250) return setError('The delay between requests must be at least 250 ms.');
    if (connector?.needs_permission_attestation && form.attest && form.attestNote.trim().length < 10) {
      return setError('Describe the basis for permitted access in at least 10 characters (for example the agreement or terms you checked).');
    }
    const base: Record<string, unknown> = {
      name: form.name.trim(),
      website: form.website.trim() || null,
      collection_frequency: form.collection_frequency || null,
      rate_limit_ms: Math.round(rateLimit),
      notes: form.notes.trim() || null,
      is_enabled: form.is_enabled,
    };
    if (!isDemo) base.collection_method = form.collection_method;
    if (!marketLocked) base.market_id = Number(form.market_id);
    if (!isSimulated) base.connector_config = cleanConfig(form.config);

    setBusy(true);
    let id = savedId;
    try {
      if (id) {
        await apiPatch(`/retailers/${id}`, base);
      } else {
        const created = await apiPost<RetailerRow>('/retailers', { ...base, market_id: Number(form.market_id), collection_method: form.collection_method });
        id = created.id;
        setSavedId(id);
      }
      if (form.credential.trim() && connector && connector.credential.needed !== 'never') {
        await apiPut(`/retailers/${id}/credential`, { value: form.credential.trim() });
        update({ credential: '' });
      }
      if (connector?.needs_permission_attestation) {
        if (form.withdraw && attested) await apiPost(`/retailers/${id}/attest-permission`, { attested: false });
        else if (form.attest && !attested) await apiPost(`/retailers/${id}/attest-permission`, { attested: true, note: form.attestNote.trim() });
      }
      toast.success(retailer ? 'Retailer updated' : 'Retailer added', form.name);
      await refresh(['retailers'], ['reference'], ['collection'], ['markets'], ['market-intel']);
      onSaved?.(id);
      onClose();
    } catch (err) {
      setError(
        id && !retailer
          ? `The retailer was created, but a later step failed: ${errorText(err)} You can correct it and save again.`
          : errorText(err),
      );
      if (id) await refresh(['retailers'], ['reference'], ['collection']);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title={retailer ? `Edit retailer — ${retailer.name}` : 'Add retailer'}
      description="A retailer is a collection source. New retailers are added by configuration only — no rebuild."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="retailer-form" loading={busy}>
            {savedId ? 'Save changes' : 'Add retailer'}
          </Button>
        </>
      }
    >
      <form id="retailer-form" onSubmit={submit} className="flex flex-col gap-5">
        {error ? <Notice tone="crit">{error}</Notice> : null}
        {isDemo ? (
          <Notice tone="demo" icon={FlaskConical} title="Demo source">
            This retailer belongs to the illustrative demo dataset. Its prices are simulated, and it cannot be switched to a real collection method or another market —
            create a new retailer for real collection.
          </Notice>
        ) : null}

        <section className="grid gap-4 sm:grid-cols-2">
          <Field label="Retailer name" required>
            <Input value={form.name} onChange={(e) => update({ name: e.target.value })} required maxLength={200} placeholder="e.g. Carrefour UAE" />
          </Field>
          <Field label="Website">
            <Input type="url" value={form.website} onChange={(e) => update({ website: e.target.value })} maxLength={500} placeholder="https://www.retailer.example" />
          </Field>
          <Field
            label="Market"
            required
            hint={
              marketLocked
                ? 'Fixed: this retailer already has price observations (or is a demo source).'
                : market
                  ? `Country ${market.country_name} · prices recorded in ${market.currency_code} · times shown in ${market.timezone}`
                  : 'Country, currency and time zone follow the market.'
            }
          >
            <Select value={form.market_id} onChange={(e) => update({ market_id: e.target.value })} disabled={marketLocked} required>
              <option value="">Choose a market…</option>
              {(ref?.markets ?? [])
                .filter((m) => m.is_active || String(m.id) === form.market_id)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.currency_code})
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Collection method" required hint={connector?.summary}>
            <Select value={form.collection_method} onChange={(e) => update({ collection_method: e.target.value as CollectionMethod, config: {}, attest: false, withdraw: false })} disabled={isDemo}>
              {methodOptions.map((m) => (
                <option key={m} value={m}>
                  {COLLECTION_METHOD_LABELS[m]}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Collection frequency"
            hint={automated ? 'How often the scheduler collects from this source.' : 'This method is driven by people, so nothing is scheduled; the frequency only sets when its data counts as stale.'}
          >
            <Select value={form.collection_frequency} onChange={(e) => update({ collection_frequency: e.target.value as Frequency | '' })}>
              <option value="">Inherit the market default{market ? ` (${FREQUENCY_LABELS[market.default_frequency]})` : ''}</option>
              {FREQUENCIES.map((f) => (
                <option key={f} value={f}>
                  {FREQUENCY_LABELS[f]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Delay between requests (ms)" hint="Minimum wait between two requests to this source. At least 250 ms; website extraction also honours robots.txt crawl delays.">
            <Input type="number" min={250} max={600000} step={50} value={form.rate_limit_ms} onChange={(e) => update({ rate_limit_ms: e.target.value })} />
          </Field>
          <Field label="Notes" className="sm:col-span-2">
            <Textarea value={form.notes} onChange={(e) => update({ notes: e.target.value })} rows={2} maxLength={2000} />
          </Field>
          <div className="flex items-center justify-between gap-4 rounded-lg border border-line px-3.5 py-2.5 sm:col-span-2">
            <div>
              <div className="text-[13px] font-medium text-ink">Collection enabled</div>
              <div className="text-[12px] text-ink-3">Switch off to pause scheduled collection without losing the configuration.</div>
            </div>
            <Switch checked={form.is_enabled} onChange={(next) => update({ is_enabled: next })} label="Collection enabled" />
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-[13.5px] font-semibold text-ink">Connector configuration</h3>
          {isSimulated ? (
            <Notice tone="demo" icon={FlaskConical}>
              Simulated demo sources generate fictional prices from the demo price model. There is nothing to configure, and their runs are always labelled as simulated.
            </Notice>
          ) : connectors.isPending ? (
            <LoadingBlock />
          ) : connectors.isError ? (
            <ErrorState error={connectors.error} onRetry={() => void connectors.refetch()} />
          ) : connector ? (
            <ConnectorConfigForm connector={connector} value={form.config} onChange={(config) => update({ config })} onJsonValidity={setJsonValid} />
          ) : (
            <Notice tone="warn">No connector is registered for this method.</Notice>
          )}
        </section>

        {connector && connector.credential.needed !== 'never' ? (
          <section>
            <h3 className="mb-2 text-[13.5px] font-semibold text-ink">
              Credential <span className="font-normal text-ink-3">({connector.credential.needed === 'always' ? 'required' : 'only if the source needs one'})</span>
            </h3>
            <SecretField
              label={connector.credential.label || 'Credential'}
              status={retailer?.credential ?? null}
              value={form.credential}
              onChange={(credential) => update({ credential })}
              help={`${connector.credential.help} It is stored encrypted and never displayed again.`}
            />
          </section>
        ) : null}

        {connector?.needs_permission_attestation ? (
          <section>
            <h3 className="mb-2 text-[13.5px] font-semibold text-ink">Access permission</h3>
            {attested ? (
              <div className="rounded-lg border border-line px-3.5 py-3">
                <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
                  <ShieldCheck className="size-4 text-good-ink" aria-hidden /> Permission attested
                </div>
                <p className="mt-1 text-[12.5px] leading-5 text-ink-2">
                  By {retailer?.permission_attested_by_name ?? 'an administrator'} on {fmtDateTime(retailer?.permission_attested_at)}: “{retailer?.permission_note}”
                </p>
                <Checkbox className="mt-2" checked={form.withdraw} onChange={(e) => update({ withdraw: e.target.checked })} label="Withdraw this attestation (website extraction stops until it is attested again)" />
              </div>
            ) : (
              <div className="rounded-lg border border-line px-3.5 py-3">
                <p className="mb-2 text-[12.5px] leading-5 text-ink-2">
                  Website extraction only runs after an administrator confirms that access is permitted. Without this the source stays <strong className="font-semibold">not
                  configured</strong> and no request is made.
                </p>
                <Checkbox
                  checked={form.attest}
                  onChange={(e) => update({ attest: e.target.checked })}
                  label="I confirm that we are permitted to access this website for price collection (terms of use or an agreement were checked). robots.txt and the delay between requests are always respected, and no access restriction is bypassed."
                />
                {form.attest ? (
                  <Field label="Basis for permitted access" required hint="At least 10 characters — e.g. the agreement, written permission or terms you checked." className="mt-3">
                    <Textarea value={form.attestNote} onChange={(e) => update({ attestNote: e.target.value })} rows={2} maxLength={1000} />
                  </Field>
                ) : null}
              </div>
            )}
          </section>
        ) : null}
      </form>
    </Dialog>
  );
}
