/** Application frame: sidebar navigation, top bar (assistant, alerts, account) and the DEMO-data banner. */
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Bell, FlaskConical, KeyRound, LogOut, Menu as MenuIcon, ShieldAlert, Sparkles, X } from 'lucide-react';
import { apiGet } from '@/lib/api.ts';
import { useAuth } from '@/lib/auth.tsx';
import { fmtNumber, initials } from '@/lib/format.ts';
import { Menu } from '@/components/ui/overlays.tsx';
import { Button, cn, IconButton, LoadingBlock } from '@/components/ui/primitives.tsx';
import { NAV } from './nav.ts';
import { ChangePasswordDialog } from './ChangePassword.tsx';

const AssistantPanel = lazy(() => import('@/pages/assistant/AssistantPanel.tsx'));

function Wordmark({ compact }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-navy" aria-hidden>
        <svg viewBox="0 0 32 32" className="size-5">
          <path d="M6 22l6-6.5 4.2 3.6L26 9" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="26" cy="9" r="2.9" fill="#eb6834" stroke="#14244a" strokeWidth="1.4" />
        </svg>
      </span>
      {!compact ? (
        <span className="leading-none">
          <span className="block text-[14px] font-semibold tracking-[-0.01em] text-ink">Price Intelligence</span>
          <span className="mt-1 block font-serif text-[12px] text-ink-3 italic">Operating system</span>
        </span>
      ) : null}
    </span>
  );
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5 px-3">
      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'group relative flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors',
              isActive ? 'bg-wash text-ink' : 'text-ink-2 hover:bg-wash/70 hover:text-ink',
            )
          }
        >
          {({ isActive }) => (
            <>
              <span aria-hidden className={cn('absolute top-2 bottom-2 left-0 w-[3px] rounded-full transition-colors', isActive ? 'bg-navy' : 'bg-transparent')} />
              <item.icon className={cn('size-4 shrink-0', isActive ? 'text-ink' : 'text-ink-3 group-hover:text-ink-2')} aria-hidden />
              <span className="truncate">{item.label}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

function SidebarFooter() {
  const { app } = useAuth();
  return (
    <div className="mt-auto border-t border-line px-5 py-3 text-[11.5px] leading-4 text-ink-3">
      <div className="num">Version {app?.version ?? '—'}</div>
      <div>All times shown in market-local time.</div>
    </div>
  );
}

export function DemoBanner() {
  const { app, can } = useAuth();
  const navigate = useNavigate();
  if (!app?.demo_data_present) return null;
  const total = app.demo_observations + app.real_observations;
  const allDemo = app.real_observations === 0;
  return (
    <div className="hatch no-print flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-dashed border-warn/70 px-4 py-2 text-[12.5px] leading-5 text-ink-2 sm:px-6" role="note">
      <FlaskConical className="size-3.5 shrink-0 text-warn-ink" aria-hidden />
      <span className="min-w-0 flex-1">
        <strong className="font-semibold text-ink">DEMO DATA.</strong>{' '}
        {allDemo
          ? 'Everything you see is an illustrative dataset. Prices are fictional and were not collected from any retailer.'
          : `${fmtNumber(app.demo_observations)} of ${fmtNumber(total)} observations belong to the illustrative demo dataset and are marked DEMO.`}
      </span>
      {can('admin.demo') ? (
        <button type="button" className="link shrink-0 text-ink" onClick={() => navigate('/admin?tab=database')}>
          Replace with real data
        </button>
      ) : null}
    </div>
  );
}

export function AppShell() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileNav, setMobileNav] = useState(false);
  const [assistant, setAssistant] = useState(false);
  const [changePassword, setChangePassword] = useState(false);

  useEffect(() => setMobileNav(false), [location.pathname]);

  const unread = useQuery({
    queryKey: ['alerts', 'unread-count'],
    queryFn: () => apiGet<{ open: number; critical: number; total_open: number }>('/alerts/unread-count'),
    refetchInterval: 60_000,
  });
  const openAlerts = unread.data?.open ?? 0;

  return (
    <div className="flex min-h-dvh">
      {/* desktop sidebar */}
      <aside className="no-print sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-line bg-surface lg:flex">
        <div className="flex h-14 items-center px-5">
          <Wordmark />
        </div>
        <div className="flex-1 overflow-y-auto py-3">
          <SidebarNav />
        </div>
        <SidebarFooter />
      </aside>

      {/* mobile navigation drawer */}
      {mobileNav ? (
        <div className="no-print fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal aria-label="Navigation">
          <button type="button" aria-label="Close navigation" className="animate-fade absolute inset-0 bg-ink/30" onClick={() => setMobileNav(false)} />
          <aside className="animate-drawer-left absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-line bg-surface">
            <div className="flex h-14 items-center justify-between px-5">
              <Wordmark />
              <IconButton icon={X} label="Close navigation" size="sm" onClick={() => setMobileNav(false)} />
            </div>
            <div className="flex-1 overflow-y-auto py-3">
              <SidebarNav onNavigate={() => setMobileNav(false)} />
            </div>
            <SidebarFooter />
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-surface/95 px-3 backdrop-blur sm:px-6">
          <IconButton icon={MenuIcon} label="Open navigation" className="lg:hidden" onClick={() => setMobileNav(true)} />
          <span className="lg:hidden">
            <Wordmark compact />
          </span>
          <div className="flex-1" />
          <Button variant="accent" icon={Sparkles} onClick={() => setAssistant(true)} aria-label="Ask the intelligence assistant">
            <span className="hidden sm:inline">Ask AI</span>
          </Button>
          <button
            type="button"
            onClick={() => navigate('/alerts')}
            className="relative inline-flex size-[34px] items-center justify-center rounded-lg text-ink-3 hover:bg-wash hover:text-ink"
            aria-label={openAlerts ? `${openAlerts} open alerts` : 'Alerts'}
            title={openAlerts ? `${openAlerts} open alerts` : 'Alerts'}
          >
            <Bell className="size-4" aria-hidden />
            {openAlerts > 0 ? (
              <span className={cn('num absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold text-white', (unread.data?.critical ?? 0) > 0 ? 'bg-crit' : 'bg-navy')}>
                {openAlerts > 99 ? '99+' : openAlerts}
              </span>
            ) : null}
          </button>
          <Menu
            trigger={
              <button type="button" className="flex items-center gap-2 rounded-lg py-1 pr-1 pl-1 hover:bg-wash sm:pr-2.5" aria-label="Account menu">
                <span className="flex size-7 items-center justify-center rounded-full bg-navy text-[11px] font-semibold text-white" aria-hidden>
                  {initials(user?.name)}
                </span>
                <span className="hidden text-left leading-tight sm:block">
                  <span className="block max-w-36 truncate text-[12.5px] font-medium text-ink">{user?.name}</span>
                  <span className="block text-[11px] text-ink-3 capitalize">{user?.role}</span>
                </span>
              </button>
            }
            items={[
              { label: 'Change password', icon: KeyRound, onSelect: () => setChangePassword(true) },
              { label: 'Sign out', icon: LogOut, onSelect: () => void logout(), separatorBefore: true },
            ]}
          />
        </header>
        <DemoBanner />
        {user?.uses_default_password ? (
          <div className="no-print flex flex-wrap items-center gap-2 border-b border-line bg-warn-soft px-4 py-2 text-[12.5px] text-ink-2 sm:px-6" role="alert">
            <ShieldAlert className="size-3.5 shrink-0 text-warn-ink" aria-hidden />
            <span className="min-w-0 flex-1">This account still uses the published demo password. Change it before working with real data.</span>
            <button type="button" className="link shrink-0 text-ink" onClick={() => setChangePassword(true)}>
              Change password
            </button>
          </div>
        ) : null}
        <main className="mx-auto w-full max-w-[1680px] min-w-0 flex-1 px-3 py-5 sm:px-6 sm:py-6">
          <Suspense fallback={<LoadingBlock className="min-h-64" />}>
            <Outlet />
          </Suspense>
        </main>
      </div>

      {assistant ? (
        <Suspense fallback={null}>
          <AssistantPanel open={assistant} onClose={() => setAssistant(false)} />
        </Suspense>
      ) : null}
      <ChangePasswordDialog open={changePassword} onClose={() => setChangePassword(false)} />
    </div>
  );
}

/** Standard page wrapper (staggered reveal on first paint). */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('animate-in', className)}>{children}</div>;
}
