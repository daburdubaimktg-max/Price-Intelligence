/** Alert rules: what is watched, with which threshold and scope, and where notifications go. */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api.ts';
import { useCan } from '@/lib/auth.tsx';
import { fmtHours, fmtNumber, fmtRelative } from '@/lib/format.ts';
import { useReference } from '@/lib/hooks.ts';
import { ConfirmDialog, Dialog, useToast } from '@/components/ui/overlays.tsx';
import { Badge, Button, Card, CardHeader, Checkbox, EmptyState, ErrorState, Field, IconButton, Input, Notice, Select, Switch } from '@/components/ui/primitives.tsx';
import { DataTable, type Column } from '@/components/ui/data-table.tsx';
import { ProductPicker } from '@/components/ui/filters.tsx';
import { DemoBadge } from '@/components/domain/domain.tsx';
import { ALERT_TYPES, ALERT_TYPE_INFO, MANUAL_STALE_HOURS, SEVERITIES, STALE_MULTIPLIER, type AlertType, type Severity } from '@shared/constants.ts';
import type { AlertRuleInput, AlertRuleRow, NotificationChannel } from '@shared/api/alerts.ts';
import type { IntegrationsStatus } from '@shared/api/admin.ts';
import { alertTypeLabel, CHANNEL_LABELS, errorText, ruleScopeParts, ruleThresholdText, SEVERITY_META, SeverityBadge } from './shared.tsx';

interface RulesResponse {
  rows: AlertRuleRow[];
  types: typeof ALERT_TYPE_INFO;
}

interface RuleForm {
  name: string;
  type: AlertType;
  severity: Severity;
  threshold: string;
  market_id: string;
  retailer_id: string;
  brand_id: string;
  category_id: string;
  product_id: string[];
  email: boolean;
  webhook: boolean;
  cooldown: string;
  is_enabled: boolean;
}

function emptyForm(type: AlertType): RuleForm {
  const info = ALERT_TYPE_INFO[type];
  return {
    name: info.label,
    type,
    severity: 'warning',
    threshold: info.defaultThreshold === undefined ? '' : String(info.defaultThreshold),
    market_id: '',
    retailer_id: '',
    brand_id: '',
    category_id: '',
    product_id: [],
    email: false,
    webhook: false,
    cooldown: '0',
    is_enabled: true,
  };
}

function formFromRule(rule: AlertRuleRow): RuleForm {
  const kind = ALERT_TYPE_INFO[rule.type].threshold;
  const threshold = kind === 'pct' ? rule.threshold_pct : kind === 'count' ? rule.threshold_count : kind === 'hours' ? rule.threshold_hours : null;
  return {
    name: rule.name,
    type: rule.type,
    severity: rule.severity,
    threshold: threshold === null ? '' : String(threshold),
    market_id: rule.market_id ? String(rule.market_id) : '',
    retailer_id: rule.retailer_id ? String(rule.retailer_id) : '',
    brand_id: rule.brand_id ? String(rule.brand_id) : '',
    category_id: rule.category_id ? String(rule.category_id) : '',
    product_id: rule.product_id ? [String(rule.product_id)] : [],
    email: rule.channels.includes('email'),
    webhook: rule.channels.includes('webhook'),
    cooldown: String(rule.cooldown_hours ?? 0),
    is_enabled: rule.is_enabled,
  };
}

/** Threshold ranges the server accepts, per kind of rule. */
function thresholdLimits(type: AlertType): { min: number; max: number } | null {
  const kind = ALERT_TYPE_INFO[type].threshold;
  if (kind === 'pct') return { min: 0, max: type === 'competitor_promotion' ? 100 : 1000 };
  if (kind === 'count') return { min: 1, max: 100 };
  if (kind === 'hours') return { min: 0, max: 8760 };
  return null;
}

function RuleDialog({ rule, open, onClose, onSaved }: { rule: AlertRuleRow | null; open: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const { ref } = useReference();
  const canIntegrations = useCan('admin.integrations');
  const integrations = useQuery({
    queryKey: ['integrations'],
    queryFn: () => apiGet<IntegrationsStatus>('/integrations'),
    enabled: open && canIntegrations,
    staleTime: 30_000,
  });
  const [form, setForm] = useState<RuleForm>(() => emptyForm('competitor_price_drop'));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm(rule ? formFromRule(rule) : emptyForm('competitor_price_drop'));
  }, [open, rule]);

  const info = ALERT_TYPE_INFO[form.type];
  const collectionOnly = form.type === 'collection_failed';
  const update = (changes: Partial<RuleForm>) => setForm((prev) => ({ ...prev, ...changes }));

  const retailers = useMemo(
    () => (ref?.retailers ?? []).filter((r) => !form.market_id || String(r.market_id) === form.market_id),
    [ref, form.market_id],
  );
  const topCategories = (ref?.categories ?? []).filter((c) => c.parent_id === null);

  function changeType(type: AlertType) {
    setForm((prev) => {
      const next = emptyForm(type);
      const wasDefaultName = prev.name.trim() === '' || prev.name === ALERT_TYPE_INFO[prev.type].label;
      return {
        ...prev,
        type,
        threshold: next.threshold,
        name: wasDefaultName ? next.name : prev.name,
        ...(type === 'collection_failed' ? { brand_id: '', category_id: '', product_id: [] } : {}),
      };
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const threshold = form.threshold.trim() === '' ? null : Number(form.threshold);
    if (threshold !== null && !Number.isFinite(threshold)) return setError('The threshold must be a number.');
    const thresholdName = info.thresholdLabel ?? 'Threshold';
    if ((info.threshold === 'pct' || info.threshold === 'count') && threshold === null) return setError(`${thresholdName} is required.`);
    // Same limits as the server, said in plain words before the request is made.
    const limits = thresholdLimits(form.type);
    if (info.threshold === 'hours' && threshold !== null && !(threshold > 0 && threshold <= 8760)) {
      return setError('The maximum age must be greater than 0 and at most 8,760 hours (one year) — or leave it empty.');
    }
    if (threshold !== null && limits && info.threshold !== 'hours' && (threshold < limits.min || threshold > limits.max)) {
      return setError(`${thresholdName} must be between ${fmtNumber(limits.min)} and ${fmtNumber(limits.max)}.`);
    }
    if (info.threshold === 'count' && threshold !== null && !Number.isInteger(threshold)) return setError(`${thresholdName} must be a whole number.`);
    const cooldown = form.cooldown.trim() === '' ? 0 : Number(form.cooldown);
    if (!Number.isFinite(cooldown) || cooldown < 0 || cooldown > 720) return setError('The cooldown must be between 0 and 720 hours.');
    const channels: NotificationChannel[] = ['in_app', ...(form.email ? (['email'] as const) : []), ...(form.webhook ? (['webhook'] as const) : [])];
    const body: Partial<AlertRuleInput> = {
      name: form.name.trim(),
      severity: form.severity,
      is_enabled: form.is_enabled,
      threshold_pct: info.threshold === 'pct' ? threshold : null,
      threshold_count: info.threshold === 'count' ? threshold : null,
      threshold_hours: info.threshold === 'hours' ? threshold : null,
      market_id: form.market_id ? Number(form.market_id) : null,
      retailer_id: form.retailer_id ? Number(form.retailer_id) : null,
      brand_id: !collectionOnly && form.brand_id ? Number(form.brand_id) : null,
      category_id: !collectionOnly && form.category_id ? Number(form.category_id) : null,
      product_id: !collectionOnly && form.product_id[0] ? Number(form.product_id[0]) : null,
      channels,
      cooldown_hours: cooldown,
    };
    setBusy(true);
    try {
      if (rule) await apiPatch(`/alert-rules/${rule.id}`, body);
      else await apiPost('/alert-rules', { ...body, type: form.type });
      toast.success(rule ? 'Rule updated' : 'Rule created');
      onSaved();
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const smtpReady = integrations.data?.smtp.configured;
  const webhookReady = integrations.data?.webhook.configured;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={rule ? 'Edit alert rule' : 'New alert rule'}
      description="A rule watches stored observations and raises an alert when its condition is met."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="alert-rule-form" loading={busy}>
            {rule ? 'Save changes' : 'Create rule'}
          </Button>
        </>
      }
    >
      <form id="alert-rule-form" onSubmit={submit} className="flex flex-col gap-4">
        {error ? <Notice tone="crit">{error}</Notice> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="What to watch" hint={rule ? 'The type of an existing rule cannot be changed.' : undefined} className="sm:col-span-2">
            <Select value={form.type} disabled={!!rule} onChange={(e) => changeType(e.target.value as AlertType)}>
              {ALERT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ALERT_TYPE_INFO[t].label}
                </option>
              ))}
            </Select>
          </Field>
          <p className="-mt-2 text-[12.5px] leading-5 text-ink-3 sm:col-span-2">{info.description}</p>
          <Field label="Rule name" required className="sm:col-span-2">
            <Input value={form.name} onChange={(e) => update({ name: e.target.value })} maxLength={120} required />
          </Field>
          <Field label="Severity" hint="Shown on every alert this rule raises.">
            <Select value={form.severity} onChange={(e) => update({ severity: e.target.value as Severity })}>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {SEVERITY_META[s].label}
                </option>
              ))}
            </Select>
          </Field>
          {info.threshold !== 'none' ? (
            <Field
              label={info.thresholdLabel ?? 'Threshold'}
              required={info.threshold !== 'hours'}
              hint={
                info.threshold === 'hours'
                  ? `Leave empty to follow each source: ${STALE_MULTIPLIER}× its collection interval, or ${fmtHours(MANUAL_STALE_HOURS).replace(' d', ' days')} for manual and paused sources.`
                  : undefined
              }
            >
              <Input
                type="number"
                inputMode="decimal"
                min={thresholdLimits(form.type)?.min ?? 0}
                max={thresholdLimits(form.type)?.max}
                step={info.threshold === 'count' ? 1 : 'any'}
                value={form.threshold}
                onChange={(e) => update({ threshold: e.target.value })}
              />
            </Field>
          ) : (
            <Field label="Threshold">
              <Input value="Not applicable — any occurrence raises an alert" disabled readOnly />
            </Field>
          )}
        </div>

        <fieldset className="rounded-lg border border-line p-3.5">
          <legend className="eyebrow px-1">Scope — leave empty to watch everything</legend>
          <div className="grid gap-3.5 sm:grid-cols-2">
            <Field label="Market">
              <Select value={form.market_id} onChange={(e) => update({ market_id: e.target.value, retailer_id: '' })}>
                <option value="">All markets</option>
                {(ref?.markets ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Retailer">
              <Select value={form.retailer_id} onChange={(e) => update({ retailer_id: e.target.value })}>
                <option value="">All retailers</option>
                {retailers.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                    {r.is_demo ? ' (DEMO)' : ''}
                  </option>
                ))}
              </Select>
            </Field>
            {!collectionOnly ? (
              <>
                <Field label="Brand">
                  <Select value={form.brand_id} onChange={(e) => update({ brand_id: e.target.value })}>
                    <option value="">All brands</option>
                    {(ref?.brands ?? []).map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name} ({b.ownership === 'own' ? 'own' : 'competitor'})
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Category">
                  <Select value={form.category_id} onChange={(e) => update({ category_id: e.target.value })}>
                    <option value="">All categories</option>
                    {topCategories.map((c) => (
                      <optgroup key={c.id} label={c.name}>
                        <option value={c.id}>{c.name} (all)</option>
                        {(ref?.categories ?? [])
                          .filter((sub) => sub.parent_id === c.id)
                          .map((sub) => (
                            <option key={sub.id} value={sub.id}>
                              {sub.name}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </Select>
                </Field>
                <div className="flex min-w-0 flex-col gap-1 sm:col-span-2">
                  <span className="text-[12px] font-medium text-ink-2">Product</span>
                  <ProductPicker label="Product" multiple={false} value={form.product_id} onChange={(next) => update({ product_id: next })} />
                </div>
              </>
            ) : (
              <p className="text-[12.5px] text-ink-3 sm:col-span-2">Collection rules watch sources, so they can only be scoped by market or retailer.</p>
            )}
          </div>
        </fieldset>

        <fieldset className="rounded-lg border border-line p-3.5">
          <legend className="eyebrow px-1">Notifications</legend>
          <div className="flex flex-col gap-2">
            <Checkbox checked disabled readOnly label="In-app — every alert appears in the Alerts Centre (always on)" />
            <Checkbox
              checked={form.email}
              onChange={(e) => update({ email: e.target.checked })}
              label={
                <>
                  E-mail
                  {canIntegrations && integrations.data ? (
                    smtpReady ? (
                      <span className="text-ink-3"> — SMTP is configured</span>
                    ) : (
                      <span className="text-warn-ink"> — not configured yet: deliveries will be recorded as “not configured”</span>
                    )
                  ) : null}
                </>
              }
            />
            <Checkbox
              checked={form.webhook}
              onChange={(e) => update({ webhook: e.target.checked })}
              label={
                <>
                  Webhook
                  {canIntegrations && integrations.data ? (
                    webhookReady ? (
                      <span className="text-ink-3"> — a webhook is configured</span>
                    ) : (
                      <span className="text-warn-ink"> — not configured yet: deliveries will be recorded as “not configured”</span>
                    )
                  ) : null}
                </>
              }
            />
            {!canIntegrations ? (
              <p className="text-[12px] leading-4 text-ink-3">
                E-mail and webhook delivery are set up by an administrator. If a channel is not configured, its delivery attempts are recorded as “not configured”.
              </p>
            ) : null}
          </div>
          <div className="mt-3.5 grid gap-3.5 sm:grid-cols-2">
            <Field label="Cooldown (hours)" hint="Suppress repeats for the same listing within this time. 0 = no cooldown.">
              <Input type="number" inputMode="decimal" min={0} max={720} step="any" value={form.cooldown} onChange={(e) => update({ cooldown: e.target.value })} />
            </Field>
            <div className="flex items-center gap-2.5 sm:pt-5">
              <Switch checked={form.is_enabled} onChange={(next) => update({ is_enabled: next })} label="Rule enabled" />
              <span className="text-[13px] text-ink-2">{form.is_enabled ? 'Enabled' : 'Disabled'}</span>
            </div>
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}

export function RulesTab() {
  const canManage = useCan('alerts.manage');
  const toast = useToast();
  const client = useQueryClient();
  const rules = useQuery({ queryKey: ['alert-rules'], queryFn: () => apiGet<RulesResponse>('/alert-rules') });
  const [editing, setEditing] = useState<AlertRuleRow | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<AlertRuleRow | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const refresh = () => client.invalidateQueries({ queryKey: ['alert-rules'] });

  async function toggle(rule: AlertRuleRow, enabled: boolean) {
    setBusyId(rule.id);
    try {
      await apiPost(`/alert-rules/${rule.id}/toggle`, { enabled });
      toast.success(enabled ? 'Rule enabled' : 'Rule disabled', rule.name);
      await refresh();
    } catch (err) {
      toast.error('The rule was not changed', errorText(err));
    } finally {
      setBusyId(null);
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusyId(deleting.id);
    try {
      await apiDelete(`/alert-rules/${deleting.id}`);
      toast.success('Rule deleted', deleting.name);
      setDeleting(null);
      await Promise.all([refresh(), client.invalidateQueries({ queryKey: ['alerts'] })]);
    } catch (err) {
      toast.error('The rule was not deleted', errorText(err));
    } finally {
      setBusyId(null);
    }
  }

  const columns: Array<Column<AlertRuleRow>> = [
    {
      key: 'name',
      header: 'Rule',
      cell: (rule) => (
        <div className="min-w-[12rem]">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-ink">{rule.name}</span>
            {rule.is_demo ? <DemoBadge /> : null}
          </div>
          <div className="text-[11.5px] text-ink-3">{alertTypeLabel(rule.type)}</div>
        </div>
      ),
    },
    {
      key: 'scope',
      header: 'Scope',
      hideBelow: 'lg',
      cell: (rule) => {
        const parts = ruleScopeParts(rule);
        return <span className="text-[12.5px] text-ink-2">{parts.length ? parts.join(' · ') : 'Everything monitored'}</span>;
      },
    },
    { key: 'threshold', header: 'Threshold', hideBelow: 'sm', nowrap: true, cell: (rule) => <span className="num text-[12.5px] text-ink-2">{ruleThresholdText(rule)}</span> },
    { key: 'severity', header: 'Severity', hideBelow: 'md', cell: (rule) => <SeverityBadge severity={rule.severity} /> },
    {
      key: 'channels',
      header: 'Channels',
      hideBelow: 'xl',
      cell: (rule) => (
        <span className="flex flex-wrap gap-1">
          {rule.channels.map((c) => (
            <Badge key={c} tone="outline">
              {CHANNEL_LABELS[c]}
            </Badge>
          ))}
        </span>
      ),
    },
    {
      key: 'alerts',
      header: 'Alerts',
      align: 'right',
      hideBelow: 'md',
      headerTitle: 'Alerts ever raised by this rule · still open or acknowledged',
      cell: (rule) => (
        <span title={rule.last_triggered_at ? `Last triggered ${fmtRelative(rule.last_triggered_at)}` : 'Never triggered'}>
          {fmtNumber(rule.alert_count)}
          <span className="text-ink-3"> · {fmtNumber(rule.open_count)} active</span>
        </span>
      ),
    },
    {
      key: 'enabled',
      header: 'Enabled',
      width: '84px',
      cell: (rule) =>
        canManage ? (
          <Switch checked={rule.is_enabled} onChange={(next) => void toggle(rule, next)} label={`${rule.is_enabled ? 'Disable' : 'Enable'} rule ${rule.name}`} disabled={busyId === rule.id} />
        ) : (
          <Badge tone={rule.is_enabled ? 'good' : 'neutral'}>{rule.is_enabled ? 'Enabled' : 'Disabled'}</Badge>
        ),
    },
    ...(canManage
      ? [
          {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            align: 'right' as const,
            width: '84px',
            cell: (rule: AlertRuleRow) => (
              <span className="inline-flex gap-0.5">
                <IconButton
                  icon={Pencil}
                  label={`Edit rule ${rule.name}`}
                  size="sm"
                  onClick={() => {
                    setEditing(rule);
                    setDialogOpen(true);
                  }}
                />
                <IconButton icon={Trash2} label={`Delete rule ${rule.name}`} size="sm" onClick={() => setDeleting(rule)} />
              </span>
            ),
          } satisfies Column<AlertRuleRow>,
        ]
      : []),
  ];

  return (
    <div>
      <Card>
        <CardHeader
          title="Alert rules"
          subtitle="Rules are evaluated whenever new observations are stored. The stale-data and failing-source rules are checked periodically by the server’s scheduler, or with “Run checks now”."
          actions={
            canManage ? (
              <Button
                variant="primary"
                icon={Plus}
                onClick={() => {
                  setEditing(null);
                  setDialogOpen(true);
                }}
              >
                New rule
              </Button>
            ) : undefined
          }
        />
        {rules.isError ? (
          <ErrorState error={rules.error} onRetry={() => void rules.refetch()} />
        ) : (
          <DataTable
            columns={columns}
            rows={rules.data?.rows}
            rowKey={(rule) => rule.id}
            loading={rules.isPending}
            refetching={rules.isFetching && !rules.isPending}
            empty={<EmptyState title="No alert rules yet" description="Create a rule to be alerted about price drops, promotions, stock-outs or collection problems." />}
          />
        )}
      </Card>
      {!canManage ? <p className="mt-2 text-[12px] text-ink-3">Your role can view rules. Analysts and administrators can change them.</p> : null}

      <RuleDialog rule={editing} open={dialogOpen} onClose={() => setDialogOpen(false)} onSaved={() => void refresh()} />
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => void remove()}
        title="Delete this rule?"
        confirmLabel="Delete rule"
        danger
        loading={busyId !== null && busyId === deleting?.id}
      >
        <p>
          <strong className="font-semibold text-ink">{deleting?.name}</strong> will stop raising alerts. The {fmtNumber(deleting?.alert_count ?? 0)} alert
          {deleting?.alert_count === 1 ? '' : 's'} it already raised stay in the history.
        </p>
      </ConfirmDialog>
    </div>
  );
}
