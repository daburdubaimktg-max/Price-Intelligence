/** The signed-in user's own notification preferences, with an honest statement of what delivery is set up. */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPut } from '@/lib/api.ts';
import { useAuth } from '@/lib/auth.tsx';
import { useToast } from '@/components/ui/overlays.tsx';
import { Badge, Button, Card, CardHeader, ErrorState, LoadingBlock, Notice, Segmented, Switch } from '@/components/ui/primitives.tsx';
import { SEVERITIES, type Severity } from '@shared/constants.ts';
import type { NotificationChannels, NotificationPrefs } from '@shared/api/alerts.ts';
import type { IntegrationsStatus } from '@shared/api/admin.ts';
import { errorText, SEVERITY_META } from './shared.tsx';

export function PreferencesTab() {
  const { user, can } = useAuth();
  const toast = useToast();
  const client = useQueryClient();
  const canIntegrations = can('admin.integrations');
  const prefs = useQuery({ queryKey: ['me', 'notification-prefs'], queryFn: () => apiGet<NotificationPrefs>('/me/notification-prefs') });
  const integrations = useQuery({
    queryKey: ['integrations'],
    queryFn: () => apiGet<IntegrationsStatus>('/integrations'),
    enabled: canIntegrations,
    staleTime: 30_000,
  });
  // Readiness of the delivery channels for people who cannot open the integration settings.
  const channels = useQuery({
    queryKey: ['me', 'notification-channels'],
    queryFn: () => apiGet<NotificationChannels>('/me/notification-channels'),
    enabled: !canIntegrations,
    staleTime: 60_000,
  });
  const [form, setForm] = useState<NotificationPrefs | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (prefs.data) setForm(prefs.data);
  }, [prefs.data]);

  if (prefs.isPending) return <LoadingBlock />;
  if (prefs.isError || !form) return <ErrorState error={prefs.error} onRetry={() => void prefs.refetch()} />;

  const dirty = !!prefs.data && (form.in_app !== prefs.data.in_app || form.email !== prefs.data.email || form.min_severity !== prefs.data.min_severity);

  async function save() {
    if (!form) return;
    setBusy(true);
    try {
      const saved = await apiPut<NotificationPrefs>('/me/notification-prefs', form);
      client.setQueryData(['me', 'notification-prefs'], saved);
      await client.invalidateQueries({ queryKey: ['alerts', 'unread-count'] });
      toast.success('Notification preferences saved');
    } catch (err) {
      toast.error('Your preferences were not saved', errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const smtp = integrations.data?.smtp;
  const webhook = integrations.data?.webhook;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Card>
        <CardHeader title="Your notifications" subtitle={`These settings apply to ${user?.email ?? 'your account'} only.`} />
        <div className="flex flex-col divide-y divide-line">
          <div className="flex items-start justify-between gap-4 px-4 py-3.5">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-ink">In-app</div>
              <p className="mt-0.5 text-[12.5px] leading-5 text-ink-3">Show the open-alert counter on the bell in the top bar. Alerts always stay visible in the Alerts Centre.</p>
            </div>
            <Switch checked={form.in_app} onChange={(next) => setForm({ ...form, in_app: next })} label="In-app notifications" />
          </div>
          <div className="flex items-start justify-between gap-4 px-4 py-3.5">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-ink">E-mail</div>
              <p className="mt-0.5 text-[12.5px] leading-5 text-ink-3">
                Receive alert e-mails at {user?.email ?? 'your address'} for rules that have the e-mail channel switched on. Alerts raised together are sent as one digest.
              </p>
            </div>
            <Switch checked={form.email} onChange={(next) => setForm({ ...form, email: next })} label="E-mail notifications" />
          </div>
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3.5">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-ink">Minimum severity</div>
              <p className="mt-0.5 text-[12.5px] leading-5 text-ink-3">Only alerts of at least this severity count towards your counter and your e-mails.</p>
            </div>
            <Segmented
              label="Minimum severity"
              value={form.min_severity}
              onChange={(next) => setForm({ ...form, min_severity: next as Severity })}
              options={SEVERITIES.map((s) => ({ value: s, label: SEVERITY_META[s].label }))}
            />
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line bg-sunken px-4 py-3 rounded-b-[10px]">
          <Button onClick={() => prefs.data && setForm(prefs.data)} disabled={!dirty || busy}>
            Discard changes
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={busy} disabled={!dirty}>
            Save preferences
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader title="Delivery channels" subtitle="What is actually set up on this installation." />
        <div className="flex flex-col gap-3 px-4 py-3.5 text-[12.5px] leading-5 text-ink-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-medium text-ink">In-app</div>
              <div className="text-ink-3">Always available — it is the Alerts Centre itself.</div>
            </div>
            <Badge tone="good">Ready</Badge>
          </div>
          {canIntegrations ? (
            integrations.isPending ? (
              <LoadingBlock className="min-h-16" />
            ) : integrations.isError ? (
              <ErrorState error={integrations.error} onRetry={() => void integrations.refetch()} className="py-4" />
            ) : (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-ink">E-mail (SMTP)</div>
                    <div className="text-ink-3">{smtp?.configured ? `Sends through ${smtp.host} as ${smtp.from}.` : 'Not set up. E-mail deliveries are recorded as “not configured”.'}</div>
                  </div>
                  <Badge tone={smtp?.configured ? 'good' : 'warn'}>{smtp?.configured ? 'Ready' : 'Not configured'}</Badge>
                </div>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-ink">Webhook</div>
                    <div className="text-ink-3">{webhook?.configured ? `Posts to ${webhook.target}.` : 'Not set up. Webhook deliveries are recorded as “not configured”.'}</div>
                  </div>
                  <Badge tone={webhook?.configured ? 'good' : 'warn'}>{webhook?.configured ? 'Ready' : 'Not configured'}</Badge>
                </div>
                <Link to="/admin?tab=integrations" className="link self-start">
                  Open integration settings
                </Link>
              </>
            )
          ) : (
            <>
              {channels.data ? (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium text-ink">E-mail</div>
                      <div className="text-ink-3">{channels.data.email ? 'Set up by an administrator.' : 'Not set up. E-mail deliveries are recorded as “not configured”.'}</div>
                    </div>
                    <Badge tone={channels.data.email ? 'good' : 'warn'}>{channels.data.email ? 'Ready' : 'Not configured'}</Badge>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium text-ink">Webhook</div>
                      <div className="text-ink-3">{channels.data.webhook ? 'Set up by an administrator.' : 'Not set up. Webhook deliveries are recorded as “not configured”.'}</div>
                    </div>
                    <Badge tone={channels.data.webhook ? 'good' : 'warn'}>{channels.data.webhook ? 'Ready' : 'Not configured'}</Badge>
                  </div>
                </>
              ) : null}
              <Notice tone="info">
                E-mail and webhook delivery are set up by an administrator under Administration → Integrations. Until a channel is configured, its delivery attempts are
                recorded as “not configured” on each alert — nothing is reported as sent.
              </Notice>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
