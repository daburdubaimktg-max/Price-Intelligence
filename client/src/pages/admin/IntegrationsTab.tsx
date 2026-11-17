/**
 * Integrations: AI assistant, e-mail, webhook, exchange-rate provider.
 * Each card shows the real state reported by the server and exactly what is needed. Credentials are
 * write-only, and every "test" button performs the real action and reports what actually happened.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bot, Coins, Mail, Send, Webhook } from 'lucide-react';
import { apiDelete, apiGet, apiPost, apiPut } from '@/lib/api.ts';
import { useAuth } from '@/lib/auth.tsx';
import { fmtDateTime, fmtNumber } from '@/lib/format.ts';
import { useToast } from '@/components/ui/overlays.tsx';
import { Button, Card, ErrorState, Field, Input, LoadingBlock, Notice, Segmented, Switch, Textarea } from '@/components/ui/primitives.tsx';
import type { AiIntegration, FxIntegration, IntegrationsStatus, IntegrationState, SmtpIntegration, SmtpTestResult, WebhookIntegration, WebhookTestResult } from '@shared/api/admin.ts';
import { errorText, SecretField, StateBadge, useRefresh } from './shared.tsx';
import type { LucideIcon } from 'lucide-react';

function IntegrationCard({ icon: Icon, title, state, explanation, children, footer }: { icon: LucideIcon; title: string; state: IntegrationState; explanation: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <Card className="flex flex-col">
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-wash text-ink-2">
            <Icon className="size-4" aria-hidden />
          </span>
          <h3 className="truncate text-[13.5px] font-semibold text-ink">{title}</h3>
        </div>
        <StateBadge state={state} />
      </div>
      <div className="flex flex-1 flex-col gap-3.5 px-4 py-3.5">
        <p className="text-[12.5px] leading-5 text-ink-2">{explanation}</p>
        {children}
      </div>
      {footer ? <div className="flex flex-wrap items-center justify-end gap-2 rounded-b-[10px] border-t border-line bg-sunken px-4 py-3">{footer}</div> : null}
    </Card>
  );
}

function AiCard({ ai, onChanged }: { ai: AiIntegration; onChanged: () => void }) {
  const toast = useToast();
  const [provider, setProvider] = useState(ai.provider);
  const [model, setModel] = useState(ai.model);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    setProvider(ai.provider);
    setModel(ai.model);
  }, [ai.provider, ai.model]);

  const dirty = provider !== ai.provider || model.trim() !== ai.model || key.trim() !== '';

  async function save() {
    setBusy('save');
    try {
      await apiPut('/integrations/ai', { provider, model: model.trim() || undefined, api_key: key.trim() || undefined });
      setKey('');
      toast.success('Assistant settings saved');
      onChanged();
    } catch (err) {
      toast.error('The assistant settings were not saved', errorText(err));
    } finally {
      setBusy(null);
    }
  }
  async function removeKey() {
    setBusy('remove');
    try {
      await apiDelete('/integrations/ai/key');
      toast.success('API key removed');
      onChanged();
    } catch (err) {
      toast.error('The API key was not removed', errorText(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <IntegrationCard
      icon={Bot}
      title="AI assistant"
      state={ai.state}
      explanation={ai.explanation}
      footer={
        <Button variant="primary" onClick={() => void save()} loading={busy === 'save'} disabled={!dirty}>
          Save
        </Button>
      }
    >
      <div className="flex flex-col gap-1">
        <span className="text-[12px] font-medium text-ink-2">Answer engine</span>
        <Segmented
          label="Answer engine"
          className="self-start"
          value={provider}
          onChange={setProvider}
          options={[
            { value: 'builtin', label: 'Built-in query engine' },
            { value: 'anthropic', label: 'Anthropic Claude' },
          ]}
        />
        <span className="text-[12px] leading-4 text-ink-3">
          Either way, every figure in an answer is computed from the stored records. The built-in engine needs no external service. With Claude, the question and the names
          in your catalogue (markets, retailers, brands, categories, products) are sent to Anthropic so that freer wording is understood — prices are never sent.
        </span>
      </div>
      {provider === 'anthropic' ? (
        <>
          <Field label="Model" hint="The Claude model identifier to use.">
            <Input value={model} onChange={(e) => setModel(e.target.value)} maxLength={100} className="mono" />
          </Field>
          <SecretField
            label="Anthropic API key"
            status={ai.api_key}
            value={key}
            onChange={setKey}
            onRemove={() => void removeKey()}
            removing={busy === 'remove'}
            help={
              ai.env_key_present
                ? 'An ANTHROPIC_API_KEY environment variable is also present on the server and is used when no key is stored here. Keys are stored encrypted and never displayed.'
                : 'Created at console.anthropic.com. Stored encrypted and never displayed again. Without a key the assistant falls back to the built-in engine.'
            }
          />
        </>
      ) : null}
    </IntegrationCard>
  );
}

function SmtpCard({ smtp, onChanged }: { smtp: SmtpIntegration; onChanged: () => void }) {
  const toast = useToast();
  const { user } = useAuth();
  const [host, setHost] = useState(smtp.host ?? '');
  const [port, setPort] = useState(String(smtp.port ?? 587));
  const [secure, setSecure] = useState(smtp.secure ?? false);
  const [username, setUsername] = useState(smtp.user ?? '');
  const [from, setFrom] = useState(smtp.from ?? '');
  const [password, setPassword] = useState('');
  const [recipients, setRecipients] = useState(smtp.recipients.join('\n'));
  const [testTo, setTestTo] = useState(user?.email ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [test, setTest] = useState<{ result?: SmtpTestResult; error?: string } | null>(null);

  const savedRecipients = smtp.recipients.join('\n');
  useEffect(() => {
    setHost(smtp.host ?? '');
    setPort(String(smtp.port ?? 587));
    setSecure(smtp.secure ?? false);
    setUsername(smtp.user ?? '');
    setFrom(smtp.from ?? '');
    setRecipients(savedRecipients);
  }, [smtp.host, smtp.port, smtp.secure, smtp.user, smtp.from, savedRecipients]);

  const recipientList = recipients.split(/[\s,;]+/).map((r) => r.trim()).filter(Boolean);
  const dirty =
    host.trim() !== (smtp.host ?? '') ||
    Number(port) !== (smtp.port ?? 587) ||
    secure !== (smtp.secure ?? false) ||
    username.trim() !== (smtp.user ?? '') ||
    from.trim() !== (smtp.from ?? '') ||
    password !== '' ||
    recipientList.join('\n') !== savedRecipients;

  async function save() {
    setBusy('save');
    try {
      await apiPut('/integrations/smtp', {
        host: host.trim(),
        port: Number(port),
        secure,
        user: username.trim() || null,
        from: from.trim(),
        password: password || undefined,
        recipients: recipientList,
      });
      setPassword('');
      toast.success('E-mail settings saved');
      onChanged();
    } catch (err) {
      toast.error('The e-mail settings were not saved', errorText(err));
    } finally {
      setBusy(null);
    }
  }
  async function clear() {
    setBusy('clear');
    try {
      await apiDelete('/integrations/smtp');
      setTest(null);
      toast.success('E-mail configuration removed');
      onChanged();
    } catch (err) {
      toast.error('The e-mail configuration was not removed', errorText(err));
    } finally {
      setBusy(null);
    }
  }
  async function sendTest() {
    setBusy('test');
    setTest(null);
    try {
      setTest({ result: await apiPost<SmtpTestResult>('/integrations/smtp/test', { to: testTo.trim() }) });
    } catch (err) {
      setTest({ error: errorText(err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <IntegrationCard
      icon={Mail}
      title="E-mail (SMTP)"
      state={smtp.state}
      explanation={smtp.explanation}
      footer={
        <>
          {smtp.configured ? (
            <Button variant="danger" onClick={() => void clear()} loading={busy === 'clear'}>
              Remove configuration
            </Button>
          ) : null}
          <Button variant="primary" onClick={() => void save()} loading={busy === 'save'} disabled={!dirty}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3.5 sm:grid-cols-2">
        <Field label="SMTP host" required>
          <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" maxLength={255} />
        </Field>
        <Field label="Port" required>
          <Input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} />
        </Field>
        <Field label="User name" hint="Leave empty if the server needs no sign-in.">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} maxLength={255} autoComplete="off" />
        </Field>
        <Field label="Sender address" required hint="e.g. alerts@example.com">
          <Input value={from} onChange={(e) => setFrom(e.target.value)} maxLength={255} />
        </Field>
        <div className="flex items-center gap-2.5 sm:col-span-2">
          <Switch checked={secure} onChange={setSecure} label="Connect with TLS from the start" />
          <span className="text-[12.5px] text-ink-2">Connect with TLS from the start (usually port 465). Off = STARTTLS when the server offers it.</span>
        </div>
        <div className="sm:col-span-2">
          <SecretField label="Password" status={smtp.password} value={password} onChange={setPassword} />
        </div>
        <Field
          label="Additional recipients"
          className="sm:col-span-2"
          hint={`One address per line. In addition, ${fmtNumber(smtp.subscribed_users)} active user${smtp.subscribed_users === 1 ? ' has' : 's have'} switched on alert e-mails in their own preferences.`}
        >
          <Textarea value={recipients} onChange={(e) => setRecipients(e.target.value)} rows={2} placeholder="pricing-team@example.com" />
        </Field>
      </div>
      <div className="rounded-lg border border-line px-3.5 py-3">
        <div className="eyebrow mb-2">Send a test e-mail</div>
        <div className="flex flex-wrap gap-2">
          <Input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" className="min-w-0 flex-1" aria-label="Test recipient" />
          <Button icon={Send} onClick={() => void sendTest()} loading={busy === 'test'} disabled={!testTo.trim()}>
            Send test
          </Button>
        </div>
        <p className="mt-1.5 text-[12px] text-ink-3">
          {dirty ? 'You have unsaved changes — the test uses the configuration as last saved. ' : 'Uses the saved configuration. '}
          The result shown is what the mail server actually answered.
        </p>
        {test?.error ? (
          <Notice tone="crit" className="mt-2" title="The test was not sent">
            {test.error}
          </Notice>
        ) : null}
        {test?.result ? (
          test.result.ok ? (
            <Notice tone="good" className="mt-2" title="The mail server accepted the message">
              Accepted for {test.result.accepted.join(', ') || 'the recipient'} in {fmtNumber(test.result.duration_ms)} ms
              {test.result.message_id ? ` (message id ${test.result.message_id})` : ''}. Delivery to the inbox is up to the receiving mail system.
            </Notice>
          ) : (
            <Notice tone="crit" className="mt-2" title="Sending failed">
              {test.result.error ?? 'The mail server rejected the message.'}
              {test.result.rejected.length ? ` Rejected: ${test.result.rejected.join(', ')}.` : ''}
            </Notice>
          )
        ) : null}
      </div>
    </IntegrationCard>
  );
}

function WebhookCard({ webhook, onChanged }: { webhook: WebhookIntegration; onChanged: () => void }) {
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [test, setTest] = useState<{ result?: WebhookTestResult; error?: string } | null>(null);

  async function save(next: string | null) {
    setBusy(next === null ? 'clear' : 'save');
    try {
      await apiPut('/integrations/webhook', { url: next });
      setUrl('');
      setTest(null);
      toast.success(next === null ? 'Webhook removed' : 'Webhook saved');
      onChanged();
    } catch (err) {
      toast.error('The webhook was not saved', errorText(err));
    } finally {
      setBusy(null);
    }
  }
  async function sendTest() {
    setBusy('test');
    setTest(null);
    try {
      setTest({ result: await apiPost<WebhookTestResult>('/integrations/webhook/test') });
    } catch (err) {
      setTest({ error: errorText(err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <IntegrationCard
      icon={Webhook}
      title="Webhook"
      state={webhook.state}
      explanation={webhook.explanation}
      footer={
        <>
          {webhook.configured ? (
            <Button variant="danger" onClick={() => void save(null)} loading={busy === 'clear'}>
              Remove webhook
            </Button>
          ) : null}
          <Button variant="primary" onClick={() => void save(url.trim())} loading={busy === 'save'} disabled={!url.trim()}>
            Save
          </Button>
        </>
      }
    >
      {webhook.configured ? (
        <div className="rounded-lg border border-line px-3.5 py-2.5 text-[12.5px]">
          <span className="text-ink-3">Current target </span>
          <span className="mono break-all text-ink">{webhook.target}</span>
          <div className="mt-0.5 text-[12px] text-ink-3">The path is masked because webhook URLs usually contain a secret token.</div>
        </div>
      ) : null}
      <Field label={webhook.configured ? 'Replace with a new URL' : 'Webhook URL'} hint="One JSON POST per batch of alerts, with a text summary (usable by chat-style incoming webhooks) and an alerts array.">
        <Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.example.com/services/…" maxLength={2000} autoComplete="off" />
      </Field>
      <div className="rounded-lg border border-line px-3.5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="eyebrow">Send a test request</div>
          <Button icon={Send} onClick={() => void sendTest()} loading={busy === 'test'} disabled={!webhook.configured}>
            Send test
          </Button>
        </div>
        <p className="mt-1.5 text-[12px] text-ink-3">Posts a clearly labelled test payload to the saved URL and shows the real HTTP result.</p>
        {test?.error ? (
          <Notice tone="crit" className="mt-2" title="The test was not sent">
            {test.error}
          </Notice>
        ) : null}
        {test?.result ? (
          test.result.ok ? (
            <Notice tone="good" className="mt-2" title="The endpoint accepted the request">
              HTTP {test.result.status} in {fmtNumber(test.result.duration_ms)} ms.
            </Notice>
          ) : (
            <Notice tone="crit" className="mt-2" title="The request failed">
              {test.result.status ? `HTTP ${test.result.status}. ` : ''}
              {test.result.error ?? 'The endpoint did not accept the request.'}
            </Notice>
          )
        ) : null}
      </div>
    </IntegrationCard>
  );
}

function FxCard({ fx, onChanged }: { fx: FxIntegration; onChanged: () => void }) {
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [auto, setAuto] = useState(fx.auto_refresh);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => setAuto(fx.auto_refresh), [fx.auto_refresh]);
  const dirty = url.trim() !== '' || key.trim() !== '' || auto !== fx.auto_refresh;

  async function save(providerUrl?: string) {
    setBusy(providerUrl === 'default' ? 'default' : 'save');
    try {
      await apiPut('/integrations/fx', { provider_url: providerUrl ?? (url.trim() || undefined), auto_refresh: auto, api_key: key.trim() || undefined });
      setUrl('');
      setKey('');
      toast.success('Exchange-rate provider saved');
      onChanged();
    } catch (err) {
      toast.error('The provider settings were not saved', errorText(err));
    } finally {
      setBusy(null);
    }
  }
  async function removeKey() {
    setBusy('remove');
    try {
      await apiDelete('/integrations/fx/key');
      toast.success('Provider API key removed');
      onChanged();
    } catch (err) {
      toast.error('The API key was not removed', errorText(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <IntegrationCard
      icon={Coins}
      title="Exchange-rate provider"
      state={fx.state}
      explanation={fx.explanation}
      footer={
        <>
          {!fx.uses_default_provider ? (
            <Button onClick={() => void save('default')} loading={busy === 'default'}>
              Use the built-in default
            </Button>
          ) : null}
          <Button variant="primary" onClick={() => void save()} loading={busy === 'save'} disabled={!dirty}>
            Save
          </Button>
        </>
      }
    >
      <div className="rounded-lg border border-line px-3.5 py-2.5 text-[12.5px]">
        <div>
          <span className="text-ink-3">Provider </span>
          <span className="mono break-all text-ink">{fx.provider ?? 'none'}</span>
          {fx.uses_default_provider ? <span className="text-ink-3"> (built-in default)</span> : null}
        </div>
        <div className="mt-0.5 text-ink-3">
          {fx.latest_as_of
            ? `Latest real rate: ${fmtDateTime(fx.latest_as_of, 'UTC')} UTC from ${fx.latest_source}.`
            : fx.only_demo_rates
              ? 'No real rate has been fetched or entered yet — only illustrative demo rates exist.'
              : 'No rate has been fetched yet.'}
        </div>
      </div>
      <Field label="Use a different provider URL" hint="A JSON endpoint returning rates against USD (or a base plus USD). Leave empty to keep the current provider.">
        <Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://rates.example.com/latest/USD" maxLength={2000} />
      </Field>
      <div className="flex items-center gap-2.5">
        <Switch checked={auto} onChange={setAuto} label="Refresh rates automatically once a day" />
        <span className="text-[12.5px] text-ink-2">Refresh rates automatically once a day. A failed refresh is written to the server log and tried again after six hours; the last stored rates stay in use with their real timestamp.</span>
      </div>
      <SecretField
        label="Provider API key (optional)"
        status={fx.api_key}
        value={key}
        onChange={setKey}
        onRemove={() => void removeKey()}
        removing={busy === 'remove'}
        help="Only for providers that require one; sent as a bearer token. Stored encrypted and never displayed."
      />
      <p className="text-[12px] text-ink-3">Fetch rates now under Administration → Exchange rates.</p>
    </IntegrationCard>
  );
}

export function IntegrationsTab() {
  const refresh = useRefresh();
  const integrations = useQuery({ queryKey: ['integrations'], queryFn: () => apiGet<IntegrationsStatus>('/integrations') });
  const onChanged = () => void refresh(['integrations'], ['settings'], ['exchange-rates'], ['assistant']);

  if (integrations.isPending) return <LoadingBlock />;
  if (integrations.isError || !integrations.data) return <ErrorState error={integrations.error} onRetry={() => void integrations.refetch()} />;
  const data = integrations.data;
  return (
    <div className="flex flex-col gap-3">
      <Notice tone="info">
        Nothing here is simulated. An integration is only shown as <strong className="font-semibold text-ink">Ready</strong> when the server has what it needs, and the test
        buttons perform the real action. Retailer data sources are configured under <strong className="font-semibold text-ink">Retailers &amp; listings</strong>.
      </Notice>
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <AiCard ai={data.ai} onChanged={onChanged} />
        <WebhookCard webhook={data.webhook} onChanged={onChanged} />
        <SmtpCard smtp={data.smtp} onChanged={onChanged} />
        <FxCard fx={data.fx} onChanged={onChanged} />
      </div>
    </div>
  );
}
