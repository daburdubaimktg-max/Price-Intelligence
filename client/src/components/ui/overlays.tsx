/** Overlays: modal dialog, side drawer, confirmation, menus, popovers and toasts (Radix for focus + a11y). */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Dialog as RDialog, DropdownMenu as RMenu, Popover as RPopover } from 'radix-ui';
import { CircleAlert, CircleCheck, Info, X, type LucideIcon } from 'lucide-react';
import { Button, cn, IconButton } from './primitives.tsx';

// ---------------------------------------------------------------------------------------------
// Modal dialog
// ---------------------------------------------------------------------------------------------
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const widths = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' } as const;
  return (
    <RDialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <RDialog.Portal>
        <RDialog.Overlay className="animate-fade fixed inset-0 z-50 bg-ink/35 backdrop-blur-[1px]" />
        <RDialog.Content
          aria-describedby={undefined}
          className={cn(
            'animate-in fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-1.5rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-line bg-surface shadow-pop',
            widths[size],
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-3.5">
            <div className="min-w-0">
              <RDialog.Title className="text-[15px] leading-6 font-semibold text-ink">{title}</RDialog.Title>
              {description ? <p className="mt-0.5 text-[12.5px] leading-5 text-ink-3">{description}</p> : null}
            </div>
            <RDialog.Close asChild>
              <IconButton icon={X} label="Close" size="sm" />
            </RDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-sunken px-5 py-3 rounded-b-xl">{footer}</div> : null}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

// ---------------------------------------------------------------------------------------------
// Side drawer (detail panels, assistant)
// ---------------------------------------------------------------------------------------------
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 'md',
  side = 'right',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'xl';
  side?: 'right' | 'left';
}) {
  const widths = { sm: 'sm:max-w-sm', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl', xl: 'sm:max-w-4xl' } as const;
  return (
    <RDialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <RDialog.Portal>
        <RDialog.Overlay className="animate-fade fixed inset-0 z-50 bg-ink/30" />
        <RDialog.Content
          aria-describedby={undefined}
          className={cn(
            'fixed inset-y-0 z-50 flex w-full flex-col border-line bg-surface shadow-pop',
            side === 'right' ? 'animate-drawer right-0 border-l' : 'animate-drawer-left left-0 border-r',
            widths[width],
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-3.5">
            <div className="min-w-0">
              <RDialog.Title className="truncate text-[15px] leading-6 font-semibold text-ink">{title}</RDialog.Title>
              {subtitle ? <div className="mt-0.5 text-[12.5px] leading-5 text-ink-3">{subtitle}</div> : null}
            </div>
            <RDialog.Close asChild>
              <IconButton icon={X} label="Close" size="sm" />
            </RDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-sunken px-5 py-3">{footer}</div> : null}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

// ---------------------------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------------------------
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel = 'Confirm',
  danger,
  loading,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-[13px] leading-5 text-ink-2">{children}</div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Dropdown menu
// ---------------------------------------------------------------------------------------------
export interface MenuItem {
  label: ReactNode;
  icon?: LucideIcon;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  hidden?: boolean;
  separatorBefore?: boolean;
}

export function Menu({ trigger, items, align = 'end' }: { trigger: ReactNode; items: MenuItem[]; align?: 'start' | 'end' }) {
  const visible = items.filter((i) => !i.hidden);
  if (visible.length === 0) return null;
  return (
    <RMenu.Root>
      <RMenu.Trigger asChild>{trigger}</RMenu.Trigger>
      <RMenu.Portal>
        <RMenu.Content align={align} sideOffset={6} className="animate-fade z-[70] min-w-44 rounded-lg border border-line bg-surface p-1 shadow-pop">
          {visible.map((item, index) => (
            <div key={index}>
              {item.separatorBefore ? <RMenu.Separator className="my-1 h-px bg-line" /> : null}
              <RMenu.Item
                disabled={item.disabled}
                onSelect={() => item.onSelect?.()}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] outline-none select-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45 data-[highlighted]:bg-wash',
                  item.danger ? 'text-crit-ink' : 'text-ink',
                )}
              >
                {item.icon ? <item.icon className="size-3.5 text-ink-3" aria-hidden /> : null}
                {item.label}
              </RMenu.Item>
            </div>
          ))}
        </RMenu.Content>
      </RMenu.Portal>
    </RMenu.Root>
  );
}

// ---------------------------------------------------------------------------------------------
// Popover
// ---------------------------------------------------------------------------------------------
export function Popover({
  trigger,
  children,
  align = 'start',
  open,
  onOpenChange,
  className,
}: {
  trigger: ReactNode;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  return (
    <RPopover.Root open={open} onOpenChange={onOpenChange}>
      <RPopover.Trigger asChild>{trigger}</RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content
          align={align}
          sideOffset={6}
          collisionPadding={12}
          className={cn('animate-fade z-[70] max-h-[min(70dvh,28rem)] w-72 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-lg border border-line bg-surface shadow-pop outline-none', className)}
        >
          {children}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}

// ---------------------------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------------------------
type ToastTone = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
}
interface ToastApi {
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
  /** Shows the message of an unknown error (ApiError messages are already human-readable). */
  fromError: (error: unknown, fallbackTitle?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const push = useCallback((tone: ToastTone, title: string, description?: string) => {
    const id = ++seq.current;
    setItems((list) => [...list.slice(-3), { id, tone, title, description }]);
    window.setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), tone === 'error' ? 8000 : 4500);
  }, []);
  const api = useMemo<ToastApi>(
    () => ({
      success: (title, description) => push('success', title, description),
      error: (title, description) => push('error', title, description),
      info: (title, description) => push('info', title, description),
      fromError: (error, fallbackTitle = 'Something went wrong') => {
        const message = error instanceof Error ? error.message : String(error);
        push('error', fallbackTitle, message);
      },
    }),
    [push],
  );
  const icons = { success: CircleCheck, error: CircleAlert, info: Info } as const;
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="no-print pointer-events-none fixed right-3 bottom-3 z-[90] flex w-[min(24rem,calc(100vw-1.5rem))] flex-col gap-2" role="region" aria-label="Notifications">
        {items.map((t) => {
          const Icon = icons[t.tone];
          return (
            <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'} className="animate-in pointer-events-auto flex items-start gap-2.5 rounded-lg border border-line bg-surface px-3.5 py-3 shadow-pop">
              <Icon className={cn('mt-0.5 size-4 shrink-0', t.tone === 'success' ? 'text-good-ink' : t.tone === 'error' ? 'text-crit' : 'text-accent')} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-ink">{t.title}</p>
                {t.description ? <p className="mt-0.5 text-[12.5px] leading-5 break-words text-ink-3">{t.description}</p> : null}
              </div>
              <button type="button" aria-label="Dismiss" className="text-ink-4 hover:text-ink" onClick={() => setItems((list) => list.filter((x) => x.id !== t.id))}>
                <X className="size-3.5" aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
