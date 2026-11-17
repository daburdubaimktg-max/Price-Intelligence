import { Component, type ErrorInfo, type ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import { Button } from '@/components/ui/primitives.tsx';

interface Props {
  children: ReactNode;
  /** 'section' keeps the navigation usable when one screen fails; 'app' covers failures outside the shell. */
  scope?: 'section' | 'app';
}
interface State {
  error: Error | null;
}

/**
 * Contains a rendering failure to the screen it happened on. Without it a single faulty component would blank the
 * whole application. AppShell mounts it with `key={pathname}`, so navigating elsewhere clears the error.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Screen failed to render', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    // A stale tab after a deployment asks for script files that no longer exist; reloading fetches the new ones.
    const stale = /dynamically imported module|Importing a module script failed|Failed to fetch dynamically/i.test(error.message);
    return (
      <div role="alert" className={this.props.scope === 'app' ? 'flex min-h-dvh items-center justify-center p-6' : 'sheet mx-auto mt-6 max-w-xl p-8'}>
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex size-10 items-center justify-center rounded-full bg-crit-soft text-crit-ink">
            <CircleAlert className="size-5" aria-hidden />
          </span>
          <h2 className="text-[15px] font-semibold text-ink">{stale ? 'This page was updated' : 'This screen could not be displayed'}</h2>
          <p className="max-w-md text-[13px] leading-5 text-ink-3">
            {stale
              ? 'A newer version of the application is available. Reload to continue.'
              : 'Something went wrong while drawing this screen. Your data is not affected. Reload the page, or open another section from the menu.'}
          </p>
          {!stale ? <p className="mono max-w-md text-[11.5px] break-words text-ink-4">{error.message}</p> : null}
          <div className="mt-1 flex flex-wrap justify-center gap-2">
            <Button variant="primary" onClick={() => window.location.reload()}>
              Reload
            </Button>
            {!stale ? <Button onClick={() => this.setState({ error: null })}>Try again</Button> : null}
          </div>
        </div>
      </div>
    );
  }
}
