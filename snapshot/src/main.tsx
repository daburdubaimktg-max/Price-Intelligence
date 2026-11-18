/**
 * Entry point of the public, read-only snapshot edition.
 *
 * It mounts the same application as `client/src/main.tsx`. The differences: the API lives in a worker
 * inside the page (see bridge.ts), the address bar uses hash routes (a static host cannot rewrite
 * paths), and the app only starts once the snapshot database has been downloaded and opened.
 */
import './clock.ts'; // must stay the first import: it installs the snapshot's clock
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HashRouter } from 'react-router';
import './styles.css';
import { App } from '@/app/App.tsx';
import { ErrorBoundary } from '@/app/ErrorBoundary.tsx';
import { AuthProvider } from '@/lib/auth.tsx';
import { ApiError } from '@/lib/api.ts';
import { fmtDateTime, fmtNumber } from '@/lib/format.ts';
import { ToastProvider } from '@/components/ui/overlays.tsx';
import { TooltipProvider } from '@/components/ui/primitives.tsx';
import { startSnapshot, type Progress } from './bridge.ts';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return failureCount < 2;
      },
    },
  },
});

let onProgress: ((progress: Progress) => void) | null = null;
const boot = startSnapshot((progress) => onProgress?.(progress));
boot.catch(() => undefined);

const megabytes = (bytes: number) => (bytes / 1_048_576).toFixed(1);

function Opening({ progress, error }: { progress: Progress | null; error: string | null }) {
  const counts = __SNAPSHOT_COUNTS__;
  const fraction = !progress ? 0.02 : progress.phase === 'download' ? Math.min(0.9, (progress.loaded / Math.max(1, progress.total)) * 0.9) : progress.phase === 'unpack' ? 0.94 : 0.98;
  const step = error
    ? null
    : !progress
      ? 'Starting…'
      : progress.phase === 'download'
        ? `Downloading the price database — ${megabytes(progress.loaded)} of ${megabytes(progress.total)} MB`
        : progress.phase === 'unpack'
          ? 'Unpacking…'
          : `Opening ${fmtNumber(counts.observations)} price observations…`;
  return (
    <div className="flex min-h-dvh items-center justify-center bg-paper px-5 py-10">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-navy text-[13px] font-semibold text-white" aria-hidden>
            PI
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-ink">Price Intelligence OS</span>
        </div>
        <h1 className="mt-7 text-[22px] leading-7 font-semibold tracking-tight text-ink">Read-only snapshot</h1>
        <p className="mt-2 text-[13.5px] leading-6 text-ink-2">
          The database as it stood on {fmtDateTime(__SNAPSHOT_AT__)}: {fmtNumber(counts.observations)} price observations for{' '}
          {fmtNumber(counts.products)} products at {fmtNumber(counts.retailers)} retailer sites. It runs entirely in your browser — nothing you do here is sent anywhere or
          changes the data.
        </p>
        {error ? (
          <div className="mt-6 rounded-lg border border-line bg-surface p-4 text-[13px] leading-5 text-ink-2" role="alert">
            <strong className="block font-semibold text-ink">The snapshot could not be opened.</strong>
            <span className="mt-1 block">{error}</span>
            <button type="button" className="link mt-3 text-ink" onClick={() => window.location.reload()}>
              Try again
            </button>
          </div>
        ) : (
          <div className="mt-6" role="status" aria-live="polite">
            <div className="h-1 overflow-hidden rounded-full bg-line">
              <div className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out" style={{ width: `${Math.round(fraction * 100)}%` }} />
            </div>
            <p className="num mt-2.5 text-[12.5px] text-ink-3">{step}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Root() {
  const [ready, setReady] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    onProgress = (p) => {
      if (active) setProgress(p);
    };
    boot.then(
      () => active && setReady(true),
      (err: unknown) => active && setError(err instanceof Error ? err.message : 'Unknown error'),
    );
    return () => {
      active = false;
      onProgress = null;
    };
  }, []);

  if (!ready) return <Opening progress={progress} error={error} />;
  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <TooltipProvider delayDuration={250}>
          <ToastProvider>
            <ErrorBoundary scope="app">
              <AuthProvider>
                <App />
              </AuthProvider>
            </ErrorBoundary>
          </ToastProvider>
        </TooltipProvider>
      </HashRouter>
    </QueryClientProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
