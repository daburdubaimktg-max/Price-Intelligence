/**
 * "Check a site": before adding a retailer, find out whether one of its product pages can be read directly
 * (POST /api/collection/site-check). The server asks the site's robots.txt first and requests the page once,
 * only if that allows it — the same way permitted website extraction would.
 */
import { useState, type FormEvent } from 'react';
import { CircleCheck, CircleSlash, ShieldAlert, Wrench } from 'lucide-react';
import type { SiteCheckResult } from '@shared/api/collection.ts';
import { apiPost } from '@/lib/api.ts';
import { AvailabilityBadge } from '@/components/domain/domain.tsx';
import { Dialog } from '@/components/ui/overlays.tsx';
import { Button, DescriptionList, Field, Input, Notice } from '@/components/ui/primitives.tsx';
import { fmtMoney } from '@/lib/format.ts';
import { errorText } from './shared.tsx';

const VERDICTS: Record<SiteCheckResult['verdict'], { tone: 'good' | 'info' | 'warn' | 'crit'; title: string; icon: typeof CircleCheck }> = {
  direct: { tone: 'good', title: 'Can be read directly — no provider needed', icon: CircleCheck },
  needs_setup: { tone: 'info', title: 'Opens, but the price is not readable yet', icon: Wrench },
  blocked: { tone: 'warn', title: 'The site does not answer automated visits', icon: ShieldAlert },
  not_permitted: { tone: 'crit', title: 'The site’s rules do not allow it', icon: CircleSlash },
};

export function SiteCheckDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SiteCheckResult | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await apiPost<SiteCheckResult>('/collection/site-check', { url: url.trim() }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const verdict = result ? VERDICTS[result.verdict] : null;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Check a site"
      description="Paste the address of one product page of the retailer. The site’s rules for automated visitors are read first; the page is requested once, and only if they allow it. Nothing is stored."
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <Field label="Product page address" className="min-w-0 flex-1">
          <Input type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.retailer.example/product/…" autoFocus />
        </Field>
        <Button type="submit" variant="primary" loading={busy} disabled={!url.trim()}>
          Check
        </Button>
      </form>

      {error ? (
        <Notice tone="crit" className="mt-4" title="The check could not be run">
          {error}
        </Notice>
      ) : null}

      {result && verdict ? (
        <div className="mt-4 flex flex-col gap-4">
          <Notice tone={verdict.tone} icon={verdict.icon} title={verdict.title}>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {result.advice.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Notice>
          <DescriptionList
            items={[
              { label: 'Site', value: result.host },
              {
                label: 'Rules for automated visitors',
                value: `${result.robots.detail}${result.robots.crawl_delay_s ? ` It asks for ${result.robots.crawl_delay_s} s between requests.` : ''}`,
              },
              { label: 'The page', value: result.page ? `${result.page.detail}${result.page.http_status ? ` (HTTP ${result.page.http_status})` : ''}` : 'Not requested.' },
              ...(result.page?.outcome === 'price_found'
                ? [
                    {
                      label: 'Price read',
                      value: (
                        <span className="num">
                          {fmtMoney(result.page.price, result.page.currency)}
                          {result.page.regular_price !== null && result.page.regular_price !== result.page.price ? `, regular ${fmtMoney(result.page.regular_price, result.page.currency)}` : ''}
                        </span>
                      ),
                    },
                    { label: 'Availability', value: <AvailabilityBadge value={result.page.availability} /> },
                  ]
                : []),
            ]}
          />
          <p className="text-[12px] leading-4 text-ink-3">
            This describes one page as this system saw it just now. It says what is technically possible, not what the retailer’s terms of use permit — that remains for you to confirm.
          </p>
        </div>
      ) : null}
    </Dialog>
  );
}
