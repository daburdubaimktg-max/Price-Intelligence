/** Core UI primitives. Every screen is assembled from these so spacing, type and states stay consistent. */
import { Children, cloneElement, createContext, forwardRef, isValidElement, useContext, useId, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Tabs as RTabs, Tooltip as RTooltip } from 'radix-ui';
import { clsx, type ClassValue } from 'clsx';
import { ArrowDown, ArrowUp, ChevronDown, CircleAlert, Inbox, LoaderCircle, Minus, type LucideIcon } from 'lucide-react';

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

// ---------------------------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------------------------
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
type ButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-navy text-white border-navy hover:bg-navy-hover active:bg-navy-hover',
  secondary: 'bg-surface text-ink border-line-strong hover:bg-sunken hover:border-ink-4',
  ghost: 'bg-transparent text-ink-2 border-transparent hover:bg-wash hover:text-ink',
  danger: 'bg-surface text-crit-ink border-crit/40 hover:bg-crit-soft',
  accent: 'bg-accent-soft text-accent border-accent/20 hover:border-accent/50',
};
const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-[12.5px] gap-1.5 rounded-md',
  md: 'h-[34px] px-3.5 text-[13px] gap-2 rounded-lg',
  lg: 'h-10 px-4 text-sm gap-2 rounded-lg',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  iconRight?: LucideIcon;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon: Icon, iconRight: IconRight, loading, disabled, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 items-center justify-center border font-medium whitespace-nowrap transition-colors select-none',
        'disabled:opacity-50',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <LoaderCircle className="size-3.5 animate-spin-slow" aria-hidden /> : Icon ? <Icon className="size-3.5" aria-hidden /> : null}
      {children}
      {IconRight ? <IconRight className="size-3.5" aria-hidden /> : null}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: string;
  size?: 'sm' | 'md';
  variant?: 'ghost' | 'secondary';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, size = 'md', variant = 'ghost', className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-lg border transition-colors disabled:opacity-50',
        variant === 'ghost' ? 'border-transparent text-ink-3 hover:bg-wash hover:text-ink' : 'border-line-strong bg-surface text-ink-2 hover:bg-sunken',
        size === 'sm' ? 'size-7' : 'size-[34px]',
        className,
      )}
      {...rest}
    >
      <Icon className={size === 'sm' ? 'size-3.5' : 'size-4'} aria-hidden />
    </button>
  );
});

// ---------------------------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------------------------
const CONTROL =
  'w-full rounded-lg border border-line-strong bg-surface px-3 text-[13px] text-ink placeholder:text-ink-4 transition-colors ' +
  'hover:border-ink-4 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:bg-sunken disabled:text-ink-3';

/** Set by <Field> so the control inside it announces the field's hint or error as its description. */
const FieldContext = createContext<{ describedBy?: string; invalid: boolean } | null>(null);

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input(
  { className, invalid, ...rest },
  ref,
) {
  const field = useContext(FieldContext);
  const bad = invalid || field?.invalid;
  return (
    <input
      ref={ref}
      className={cn(CONTROL, 'h-[34px]', bad && 'border-crit focus:border-crit focus:ring-crit/20', className)}
      aria-invalid={bad || undefined}
      aria-describedby={field?.describedBy}
      {...rest}
    />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(function Textarea(
  { className, invalid, rows = 3, ...rest },
  ref,
) {
  const field = useContext(FieldContext);
  const bad = invalid || field?.invalid;
  return <textarea ref={ref} rows={rows} className={cn(CONTROL, 'py-2 leading-5', bad && 'border-crit', className)} aria-invalid={bad || undefined} aria-describedby={field?.describedBy} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(function Select(
  { className, invalid, children, ...rest },
  ref,
) {
  const field = useContext(FieldContext);
  const bad = invalid || field?.invalid;
  return (
    <span className={cn('relative inline-flex w-full', className)}>
      <select ref={ref} className={cn(CONTROL, 'h-[34px] appearance-none pr-8', bad && 'border-crit')} aria-invalid={bad || undefined} aria-describedby={field?.describedBy} {...rest}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-ink-3" aria-hidden />
    </span>
  );
});

export function Checkbox({ label, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode }) {
  const id = useId();
  return (
    <span className={cn('inline-flex items-start gap-2', className)}>
      <input id={rest.id ?? id} type="checkbox" className="mt-[3px] size-3.5 shrink-0 rounded border-line-strong accent-[var(--color-navy)]" {...rest} />
      {label ? (
        <label htmlFor={rest.id ?? id} className="text-[13px] text-ink-2 select-none">
          {label}
        </label>
      ) : null}
    </span>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50', checked ? 'border-navy bg-navy' : 'border-line-strong bg-wash')}
    >
      <span className={cn('inline-block size-3.5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-[3px]')} />
    </button>
  );
}

/**
 * Label + control + hint/error, stacked.
 *
 * With a single control component inside (Input, Select, a picker…), the label is tied to it by id, so the control's
 * accessible name is exactly the label text and the hint or error is announced as its description. Composite content
 * (several controls in a row) falls back to a wrapping label.
 */
export function Field({ label, hint, error, required, children, className }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; required?: boolean; children: ReactNode; className?: string }) {
  const id = useId();
  const noteId = error || hint ? `${id}-note` : undefined;
  const single = Children.count(children) === 1 && isValidElement<{ id?: string }>(children) && typeof children.type !== 'string' ? children : null;
  const controlId = single ? (single.props.id ?? `${id}-control`) : undefined;
  const caption = (
    <>
      {label}
      {required ? (
        <span className="text-crit-ink" aria-hidden>
          {' '}
          *
        </span>
      ) : null}
    </>
  );
  const context = { describedBy: noteId, invalid: !!error };
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      {single ? (
        <>
          <label htmlFor={controlId} className="text-[12px] font-medium text-ink-2">
            {caption}
          </label>
          <FieldContext.Provider value={context}>{single.props.id ? single : cloneElement(single, { id: controlId })}</FieldContext.Provider>
        </>
      ) : (
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-[12px] font-medium text-ink-2">{caption}</span>
          <FieldContext.Provider value={context}>{children}</FieldContext.Provider>
        </label>
      )}
      {error ? (
        <span id={noteId} className="text-[12px] text-crit-ink">
          {error}
        </span>
      ) : hint ? (
        <span id={noteId} className="text-[12px] text-ink-3">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------------------------
export type BadgeTone = 'neutral' | 'own' | 'comp' | 'good' | 'warn' | 'crit' | 'accent' | 'demo' | 'outline';
const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-wash text-ink-2 border-transparent',
  own: 'bg-own-soft text-own-ink border-transparent',
  comp: 'bg-comp-soft text-comp-ink border-transparent',
  good: 'bg-good-soft text-good-ink border-transparent',
  warn: 'bg-warn-soft text-warn-ink border-transparent',
  crit: 'bg-crit-soft text-crit-ink border-transparent',
  accent: 'bg-accent-soft text-accent border-transparent',
  demo: 'hatch text-warn-ink border-warn/60 border-dashed',
  outline: 'bg-transparent text-ink-2 border-line-strong',
};

export function Badge({ tone = 'neutral', icon: Icon, children, className, title }: { tone?: BadgeTone; icon?: LucideIcon; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] leading-none font-medium whitespace-nowrap', BADGE_TONES[tone], className)}>
      {Icon ? <Icon className="size-3" aria-hidden /> : null}
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Layout: cards, headers
// ---------------------------------------------------------------------------------------------
export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('sheet min-w-0', className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, actions, className }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-3', className)}>
      <div className="min-w-0">
        <h3 className="text-[13.5px] leading-5 font-semibold text-ink">{title}</h3>
        {subtitle ? <p className="mt-0.5 text-[12px] leading-4 text-ink-3">{subtitle}</p> : null}
      </div>
      {/* max-w-full: on a narrow card the controls wrap inside it instead of widening the page */}
      {actions ? <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function PageHeader({ title, description, actions, eyebrow }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        {eyebrow ? <div className="eyebrow mb-1">{eyebrow}</div> : null}
        <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.01em] text-ink">{title}</h1>
        {description ? <p className="mt-1 max-w-3xl text-[13px] leading-5 text-ink-3">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

// ---------------------------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------------------------
export interface StatTileProps {
  label: ReactNode;
  value: ReactNode;
  /** Secondary line under the value. */
  detail?: ReactNode;
  /** Signed delta with a label, e.g. { value: 4.2, label: 'vs previous 30 days' }. */
  delta?: { value: number | null; label?: string; goodWhen?: 'up' | 'down' | 'neutral'; format?: (v: number) => string } | null;
  icon?: LucideIcon;
  tone?: 'default' | 'warn' | 'crit' | 'good';
  onClick?: () => void;
  footer?: ReactNode;
  className?: string;
  title?: string;
}

/** A single headline number. Proportional figures at display size (tabular figures are for columns). */
export function StatTile({ label, value, detail, delta, icon: Icon, tone = 'default', onClick, footer, className, title }: StatTileProps) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      title={title}
      className={cn(
        'sheet flex min-w-0 flex-col gap-1 px-4 py-3 text-left',
        onClick && 'transition-colors hover:border-ink-4',
        tone === 'warn' && 'border-warn/70',
        tone === 'crit' && 'border-crit/50',
        className,
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="truncate text-[12px] leading-4 font-medium text-ink-3">{label}</span>
        {Icon ? <Icon className={cn('size-3.5 shrink-0', tone === 'crit' ? 'text-crit' : tone === 'warn' ? 'text-warn-ink' : tone === 'good' ? 'text-good-ink' : 'text-ink-4')} aria-hidden /> : null}
      </span>
      <span className="text-[24px] leading-8 font-semibold tracking-[-0.01em] text-ink">{value}</span>
      {delta ? <Delta value={delta.value} label={delta.label} goodWhen={delta.goodWhen} format={delta.format} /> : null}
      {detail ? <span className="text-[12px] leading-4 text-ink-3">{detail}</span> : null}
      {footer}
    </Tag>
  );
}

/** Signed change with an arrow. Direction is always carried by the glyph, colour only reinforces it. */
export function Delta({
  value,
  label,
  goodWhen = 'neutral',
  format,
  className,
}: {
  value: number | null | undefined;
  label?: string;
  goodWhen?: 'up' | 'down' | 'neutral';
  format?: (v: number) => string;
  className?: string;
}) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return <span className={cn('text-[12px] text-ink-4', className)}>{label ? `No comparison ${label}` : '—'}</span>;
  }
  const flat = Math.abs(value) < 0.05;
  const up = value > 0;
  const Icon = flat ? Minus : up ? ArrowUp : ArrowDown;
  const good = goodWhen === 'neutral' || flat ? null : (goodWhen === 'up') === up;
  const text = format ? format(value) : `${Math.abs(value).toFixed(1)}%`;
  return (
    <span className={cn('inline-flex items-center gap-1 text-[12px] leading-4', className)}>
      <span className={cn('inline-flex items-center gap-0.5 font-medium', good === null ? 'text-ink-2' : good ? 'text-good-ink' : 'text-crit-ink')}>
        <Icon className="size-3" aria-hidden />
        <span className="num">{text}</span>
        <span className="sr-only">{flat ? 'no change' : up ? 'increase' : 'decrease'}</span>
      </span>
      {label ? <span className="text-ink-3">{label}</span> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------------------------
export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <span role="status" aria-label={label} className={cn('inline-flex items-center justify-center text-ink-3', className)}>
      <LoaderCircle className="size-4 animate-spin-slow" aria-hidden />
    </span>
  );
}

export function LoadingBlock({ label = 'Loading…', className }: { label?: string; className?: string }) {
  return (
    <div className={cn('flex min-h-32 items-center justify-center gap-2 text-[13px] text-ink-3', className)}>
      <Spinner /> {label}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-wash', className)} aria-hidden />;
}

export function EmptyState({ icon: Icon = Inbox, title, description, action, className }: { icon?: LucideIcon; title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-10 text-center', className)}>
      <span className="flex size-9 items-center justify-center rounded-full bg-wash text-ink-3">
        <Icon className="size-4" aria-hidden />
      </span>
      <p className="text-[13.5px] font-medium text-ink">{title}</p>
      {description ? <p className="max-w-md text-[12.5px] leading-5 text-ink-3">{description}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const message = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-10 text-center', className)} role="alert">
      <span className="flex size-9 items-center justify-center rounded-full bg-crit-soft text-crit-ink">
        <CircleAlert className="size-4" aria-hidden />
      </span>
      <p className="text-[13.5px] font-medium text-ink">Could not load this</p>
      <p className="max-w-md text-[12.5px] leading-5 text-ink-3">{message}</p>
      {onRetry ? (
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** Inline notice. `demo` is the hatched DEMO-data treatment. */
export function Notice({ tone = 'info', icon: Icon, title, children, className, action }: { tone?: 'info' | 'warn' | 'crit' | 'good' | 'demo'; icon?: LucideIcon; title?: ReactNode; children?: ReactNode; className?: string; action?: ReactNode }) {
  const tones = {
    info: 'border-accent/25 bg-accent-soft text-ink-2',
    warn: 'border-warn/60 bg-warn-soft text-ink-2',
    crit: 'border-crit/35 bg-crit-soft text-ink-2',
    good: 'border-good/35 bg-good-soft text-ink-2',
    demo: 'hatch border-dashed border-warn/70 text-ink-2',
  } as const;
  return (
    <div className={cn('flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-[12.5px] leading-5', tones[tone], className)}>
      {Icon ? <Icon className="mt-[3px] size-3.5 shrink-0 text-ink-2" aria-hidden /> : null}
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold text-ink">{title}</p> : null}
        {children}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Segmented control, tabs, tooltip
// ---------------------------------------------------------------------------------------------
export function Segmented<T extends string>({ value, onChange, options, size = 'md', className, label }: { value: T; onChange: (next: T) => void; options: Array<{ value: T; label: ReactNode; title?: string }>; size?: 'sm' | 'md'; className?: string; label?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('inline-flex max-w-full shrink-0 overflow-x-auto rounded-lg border border-line-strong bg-surface p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-md px-2.5 font-medium whitespace-nowrap transition-colors',
            size === 'sm' ? 'h-6 text-[12px]' : 'h-7 text-[12.5px]',
            o.value === value ? 'bg-navy text-white' : 'text-ink-2 hover:bg-wash',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs, children, className }: { value: T; onChange: (next: T) => void; tabs: Array<{ value: T; label: ReactNode; count?: number | null }>; children?: ReactNode; className?: string }) {
  return (
    <RTabs.Root value={value} onValueChange={(v) => onChange(v as T)} className={className}>
      <RTabs.List className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
        {tabs.map((t) => (
          <RTabs.Trigger
            key={t.value}
            value={t.value}
            className="relative -mb-px flex shrink-0 items-center gap-1.5 border-b-2 border-transparent px-3 pt-1 pb-2 text-[13px] font-medium text-ink-3 transition-colors hover:text-ink data-[state=active]:border-navy data-[state=active]:text-ink"
          >
            {t.label}
            {t.count !== undefined && t.count !== null ? <span className="num rounded-full bg-wash px-1.5 text-[11px] leading-4 text-ink-2">{t.count}</span> : null}
          </RTabs.Trigger>
        ))}
      </RTabs.List>
      {children}
    </RTabs.Root>
  );
}
export const TabPanel = RTabs.Content;

export function Tip({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  if (!content) return <>{children}</>;
  return (
    <RTooltip.Root delayDuration={250}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content side={side} sideOffset={6} className="animate-fade z-[80] max-w-xs rounded-md bg-ink px-2.5 py-1.5 text-[12px] leading-4 text-white shadow-pop">
          {content}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}
export const TooltipProvider = RTooltip.Provider;

/** Label/value rows for detail panels. */
export function DescriptionList({ items, className, columns = 1 }: { items: Array<{ label: ReactNode; value: ReactNode; hidden?: boolean }>; className?: string; columns?: 1 | 2 }) {
  return (
    <dl className={cn('grid gap-x-6 gap-y-2.5 text-[13px]', columns === 2 ? 'sm:grid-cols-2' : '', className)}>
      {items
        .filter((i) => !i.hidden)
        .map((item, index) => (
          <div key={index} className="flex min-w-0 items-baseline justify-between gap-4 border-b border-line pb-2 last:border-0">
            <dt className="shrink-0 text-ink-3">{item.label}</dt>
            <dd className="min-w-0 text-right font-medium break-words text-ink">{item.value}</dd>
          </div>
        ))}
    </dl>
  );
}
