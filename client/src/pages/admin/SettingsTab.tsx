/** Workspace settings. Each one says what it changes. */
import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiPut } from '@/lib/api.ts';
import { fmtNumber } from '@/lib/format.ts';
import { useReference } from '@/lib/hooks.ts';
import { useToast } from '@/components/ui/overlays.tsx';
import { Button, Card, CardHeader, ErrorState, Field, Input, LoadingBlock, Notice, Select } from '@/components/ui/primitives.tsx';
import type { AdminSettings, SettingsUpdate } from '@shared/api/admin.ts';
import { errorText, useRefresh } from './shared.tsx';

interface SettingsForm {
  reporting_currency: string;
  organisation_name: string;
  promo_gap_days: string;
  alert_max_age_hours: string;
  collection_max_retries: string;
}

const toForm = (s: AdminSettings): SettingsForm => ({
  reporting_currency: s.reporting_currency,
  organisation_name: s.organisation_name ?? '',
  promo_gap_days: String(s.promo_gap_days),
  alert_max_age_hours: String(s.alert_max_age_hours),
  collection_max_retries: String(s.collection_max_retries),
});

export function SettingsTab() {
  const toast = useToast();
  const refresh = useRefresh();
  const { ref } = useReference();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => apiGet<AdminSettings>('/settings') });
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (settings.data) setForm(toForm(settings.data));
  }, [settings.data]);

  if (settings.isPending) return <LoadingBlock />;
  if (settings.isError || !settings.data || !form) return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;

  const saved = toForm(settings.data);
  const dirty = (Object.keys(saved) as Array<keyof SettingsForm>).some((k) => saved[k] !== form[k]);
  const update = (changes: Partial<SettingsForm>) => setForm({ ...form, ...changes });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setError(null);
    // The server's limits, said in plain words before the request is made.
    const inRange = (value: string, min: number, max: number, whole: boolean) => {
      const n = Number(value);
      return value.trim() !== '' && Number.isFinite(n) && n >= min && n <= max && (!whole || Number.isInteger(n));
    };
    if (!inRange(form.promo_gap_days, 1, 60, true)) return setError('Promotion gap must be a whole number of days between 1 and 60.');
    if (!inRange(form.alert_max_age_hours, 1, 720, false)) return setError('Alert maximum age must be between 1 and 720 hours.');
    if (!inRange(form.collection_max_retries, 0, 5, true)) return setError('Automatic collection retries must be a whole number between 0 and 5.');
    const body: SettingsUpdate = {};
    if (form.reporting_currency !== saved.reporting_currency) body.reporting_currency = form.reporting_currency;
    if (form.organisation_name !== saved.organisation_name) body.organisation_name = form.organisation_name.trim();
    if (form.promo_gap_days !== saved.promo_gap_days) body.promo_gap_days = Number(form.promo_gap_days);
    if (form.alert_max_age_hours !== saved.alert_max_age_hours) body.alert_max_age_hours = Number(form.alert_max_age_hours);
    if (form.collection_max_retries !== saved.collection_max_retries) body.collection_max_retries = Number(form.collection_max_retries);
    setBusy(true);
    try {
      const result = await apiPut<{ settings: AdminSettings; rebuilt_listings: number | null }>('/settings', body);
      toast.success(
        'Settings saved',
        result.rebuilt_listings !== null ? `Promotion episodes were recomputed from the ledger for ${fmtNumber(result.rebuilt_listings)} listings.` : undefined,
      );
      await refresh(['settings'], ['auth', 'me'], ['analytics'], ['exchange-rates'], ['promotions'], ['overview'], ['market-intel']);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="max-w-3xl">
      <CardHeader title="Workspace settings" subtitle="These apply to everyone using this installation." />
      <form onSubmit={submit}>
        <div className="grid gap-x-5 gap-y-4 px-4 py-4 sm:grid-cols-2">
          {error ? (
            <Notice tone="crit" className="sm:col-span-2">
              {error}
            </Notice>
          ) : null}
          <Field label="Organisation name" hint="Shown in report headers and exports." className="sm:col-span-2">
            <Input value={form.organisation_name} onChange={(e) => update({ organisation_name: e.target.value })} maxLength={120} placeholder="Your company" />
          </Field>
          <Field label="Reporting currency" hint="The default currency when prices from different markets are compared. Conversions always state the rate, its timestamp and source.">
            <Select value={form.reporting_currency} onChange={(e) => update({ reporting_currency: e.target.value })}>
              {(ref?.currencies ?? [{ code: form.reporting_currency, name: '', symbol: '', decimals: 2 }]).map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code}
                  {c.name ? ` — ${c.name}` : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Promotion gap (days)"
            hint="Two promotional observations of a listing further apart than this count as two separate promotions. 1–60. Changing it recomputes promotion episodes from the ledger."
          >
            <Input type="number" min={1} max={60} step={1} value={form.promo_gap_days} onChange={(e) => update({ promo_gap_days: e.target.value })} />
          </Field>
          <Field
            label="Alert maximum age (hours)"
            hint="Price changes older than this never raise alerts — so importing old history does not flood the Alerts Centre. 1–720."
          >
            <Input type="number" min={1} max={720} step="any" value={form.alert_max_age_hours} onChange={(e) => update({ alert_max_age_hours: e.target.value })} />
          </Field>
          <Field label="Automatic collection retries" hint="How many times a failed collection run is retried automatically — after 2, 10 and 30 minutes, then hourly. 0–5.">
            <Input type="number" min={0} max={5} step={1} value={form.collection_max_retries} onChange={(e) => update({ collection_max_retries: e.target.value })} />
          </Field>
        </div>
        <div className="flex items-center justify-end gap-2 rounded-b-[10px] border-t border-line bg-sunken px-4 py-3">
          <Button onClick={() => setForm(saved)} disabled={!dirty || busy}>
            Discard changes
          </Button>
          <Button variant="primary" type="submit" loading={busy} disabled={!dirty}>
            Save settings
          </Button>
        </div>
      </form>
    </Card>
  );
}
