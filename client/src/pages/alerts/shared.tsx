/** Small pieces shared by the Alerts Centre tabs. */
import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from 'lucide-react';
import { ALERT_TYPE_INFO, type AlertType, type Severity } from '@shared/constants.ts';
import type { AlertRuleRow, AlertStatus, NotificationChannel, NotificationStatus } from '@shared/api/alerts.ts';
import { fmtNumber } from '@/lib/format.ts';
import { Badge, type BadgeTone } from '@/components/ui/primitives.tsx';

export const SEVERITY_META: Record<Severity, { label: string; icon: LucideIcon; tone: BadgeTone }> = {
  critical: { label: 'Critical', icon: CircleAlert, tone: 'crit' },
  warning: { label: 'Warning', icon: TriangleAlert, tone: 'warn' },
  info: { label: 'Info', icon: Info, tone: 'accent' },
};

/** Severity is always an icon plus its name — never colour alone. */
export function SeverityBadge({ severity }: { severity: Severity }) {
  const meta = SEVERITY_META[severity] ?? SEVERITY_META.info;
  return (
    <Badge tone={meta.tone} icon={meta.icon}>
      {meta.label}
    </Badge>
  );
}

export const STATUS_LABELS: Record<AlertStatus, string> = { open: 'Open', acknowledged: 'Acknowledged', resolved: 'Resolved' };

export function AlertStatusBadge({ status }: { status: AlertStatus }) {
  if (status === 'resolved') {
    return (
      <Badge tone="good" icon={CircleCheck}>
        Resolved
      </Badge>
    );
  }
  if (status === 'acknowledged') return <Badge tone="neutral">Acknowledged</Badge>;
  return <Badge tone="outline">Open</Badge>;
}

export const CHANNEL_LABELS: Record<NotificationChannel, string> = { in_app: 'In-app', email: 'E-mail', webhook: 'Webhook' };

export const NOTIFICATION_STATUS_META: Record<NotificationStatus, { label: string; tone: BadgeTone }> = {
  delivered: { label: 'Delivered', tone: 'good' },
  failed: { label: 'Failed', tone: 'crit' },
  not_configured: { label: 'Not configured', tone: 'warn' },
};

export function alertTypeLabel(type: AlertType | string): string {
  return ALERT_TYPE_INFO[type as AlertType]?.label ?? type;
}

/** Alerts raised by the periodic state checks (one per rule and source, updated in place). */
export const isStateAlert = (type: string) => type === 'stale_observation' || type === 'collection_failed';

export function ruleThresholdText(rule: Pick<AlertRuleRow, 'type' | 'threshold_pct' | 'threshold_count' | 'threshold_hours'>): string {
  const kind = ALERT_TYPE_INFO[rule.type]?.threshold ?? 'none';
  if (kind === 'pct') {
    if (rule.threshold_pct === null) return '—';
    if (rule.threshold_pct === 0) return rule.type === 'own_more_expensive' ? 'Any premium' : rule.type === 'competitor_promotion' ? 'Any promotion' : 'Any change';
    return `≥ ${fmtNumber(rule.threshold_pct, 2)}%`;
  }
  if (kind === 'count') return rule.threshold_count === null ? '—' : `${fmtNumber(rule.threshold_count)} in a row`;
  if (kind === 'hours') return rule.threshold_hours === null ? 'From each source’s schedule' : `Older than ${fmtNumber(rule.threshold_hours, 1)} h`;
  return 'Any occurrence';
}

export function ruleScopeParts(rule: Pick<AlertRuleRow, 'market_name' | 'retailer_name' | 'brand_name' | 'category_name' | 'product_name'>): string[] {
  const parts: string[] = [];
  if (rule.market_name) parts.push(`Market: ${rule.market_name}`);
  if (rule.retailer_name) parts.push(`Retailer: ${rule.retailer_name}`);
  if (rule.brand_name) parts.push(`Brand: ${rule.brand_name}`);
  if (rule.category_name) parts.push(`Category: ${rule.category_name}`);
  if (rule.product_name) parts.push(`Product: ${rule.product_name}`);
  return parts;
}

export function errorText(error: unknown, fallback = 'Something went wrong'): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
