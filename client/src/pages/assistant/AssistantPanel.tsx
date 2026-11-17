/**
 * Intelligence assistant — natural-language questions answered from the stored price observations.
 * The panel only asks and displays: interpretation and every figure come from the server, and an answer
 * that cannot be given is shown as unavailable.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ArrowUp, Cpu, History, Lightbulb, RotateCcw, Sparkles, Trash2 } from 'lucide-react';
import { apiGet } from '@/lib/api.ts';
import { useAuth } from '@/lib/auth.tsx';
import { fmtRelative } from '@/lib/format.ts';
import { useIsNarrow } from '@/lib/hooks.ts';
import { Drawer, Popover } from '@/components/ui/overlays.tsx';
import { Badge, Button, cn, ErrorState, Notice, Spinner, Textarea, type BadgeTone } from '@/components/ui/primitives.tsx';
import type { AssistantHistoryItem, AssistantStatus } from '@shared/api/assistant.ts';
import { AnswerCard } from './AnswerCard.tsx';
import { ask, clearConversation, retry, useConversation, type Exchange } from './store.ts';

const MAX_QUESTION = 600;
const MIN_QUESTION = 3;

const HISTORY_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  answered: { label: 'Answered', tone: 'neutral' },
  no_data: { label: 'No data', tone: 'warn' },
  needs_clarification: { label: 'Needed detail', tone: 'accent' },
  unsupported: { label: 'Not answerable', tone: 'outline' },
};

function QuestionList({ items, onPick, disabled }: { items: Array<{ key: string | number; question: string; meta?: ReactNode }>; onPick: (question: string) => void; disabled: boolean }) {
  return (
    <ul className="flex flex-col">
      {items.map((item) => (
        <li key={item.key}>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onPick(item.question)}
            className="flex w-full items-start justify-between gap-3 rounded-md px-2.5 py-2 text-left text-[13px] leading-5 text-ink hover:bg-wash disabled:opacity-50"
          >
            <span className="min-w-0">{item.question}</span>
            {item.meta ? <span className="flex shrink-0 items-center gap-2 pt-px">{item.meta}</span> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

function historyItems(rows: AssistantHistoryItem[]) {
  // the same question asked several times is offered once (its most recent outcome)
  const seen = new Set<string>();
  return rows
    .filter((row) => {
      const key = row.question.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((row) => {
      const status = HISTORY_STATUS[row.status] ?? HISTORY_STATUS.answered!;
      return {
        key: row.id,
        question: row.question,
        meta: (
          <>
            {row.status !== 'answered' ? <Badge tone={status.tone}>{status.label}</Badge> : null}
            <span className="num text-[11.5px] whitespace-nowrap text-ink-3">{fmtRelative(row.created_at)}</span>
          </>
        ),
      };
    });
}

function EngineNote({ status, onNavigate, canConfigure }: { status: AssistantStatus; onNavigate: () => void; canConfigure: boolean }) {
  const Icon = status.engine === 'claude' ? Sparkles : Cpu;
  // Claude selected but unusable is worth a warning; the built-in engine on its own is simply how it works
  const degraded = status.provider_setting === 'anthropic' && status.engine !== 'claude';
  return (
    <div className={cn('flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-[12.5px] leading-5', degraded ? 'border-warn/60 bg-warn-soft' : 'border-line bg-sunken')}>
      <Icon className="mt-[3px] size-3.5 shrink-0 text-ink-3" aria-hidden />
      <div className="min-w-0">
        <p className="font-medium text-ink">{status.engine_label}</p>
        <p className="text-ink-2">{status.explanation}</p>
        {canConfigure && status.engine !== 'claude' ? (
          <Link to="/admin?tab=integrations" onClick={onNavigate} className="link mt-1 inline-block">
            {status.api_key_configured ? 'Open the assistant settings' : 'Add an Anthropic API key (optional)'}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function ExchangeView({ exchange, onRetry, onNavigate }: { exchange: Exchange; onRetry: () => void; onNavigate: () => void }) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex justify-end">
        <div className="max-w-[88%] rounded-xl rounded-br-[4px] border border-line bg-wash px-3.5 py-2 text-[13.5px] leading-[21px] text-ink">
          <span className="sr-only">You asked: </span>
          {exchange.question}
        </div>
      </div>
      {exchange.state === 'pending' ? (
        <div className="sheet flex items-center gap-2.5 px-4 py-3.5 text-[13px] text-ink-2" role="status">
          <Spinner label="Searching" /> Searching stored observations…
        </div>
      ) : exchange.state === 'error' ? (
        <Notice
          tone="crit"
          title="This question was not answered"
          action={
            exchange.error?.retryable ? (
              <Button size="sm" icon={RotateCcw} onClick={onRetry}>
                Try again
              </Button>
            ) : undefined
          }
        >
          {exchange.error?.message}
        </Notice>
      ) : exchange.answer ? (
        <AnswerCard answer={exchange.answer} scope={`assistant-${exchange.key}`} onNavigate={onNavigate} />
      ) : null}
    </div>
  );
}

export default function AssistantPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, can } = useAuth();
  const allowed = can('assistant.use');
  const userId = user?.id ?? null;
  const client = useQueryClient();
  const narrow = useIsNarrow();
  const exchanges = useConversation(userId);
  const pending = exchanges.some((e) => e.state === 'pending');

  const status = useQuery({ queryKey: ['assistant', 'status'], queryFn: () => apiGet<AssistantStatus>('/assistant/status'), staleTime: 30_000 });
  const history = useQuery({ queryKey: ['assistant', 'history'], queryFn: () => apiGet<{ rows: AssistantHistoryItem[] }>('/assistant/history'), enabled: allowed });

  const [draft, setDraft] = useState('');
  const [menu, setMenu] = useState<'examples' | 'recent' | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const latestRef = useRef<HTMLDivElement>(null);
  const firstScroll = useRef(true);

  // Bring the newest exchange to the top of the view — when it is asked and again when its answer lands
  // (only then is there enough below it) — so the question stays visible while the answer is read.
  const latestState = exchanges[exchanges.length - 1]?.state;
  useEffect(() => {
    if (!exchanges.length) return;
    latestRef.current?.scrollIntoView({ block: 'start', behavior: firstScroll.current ? 'auto' : 'smooth' });
    firstScroll.current = false;
  }, [exchanges.length, latestState]);

  // On a desktop the cursor starts in the question box; on a phone that would only raise the keyboard.
  useEffect(() => {
    if (narrow || !allowed) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 80);
    return () => window.clearTimeout(id);
  }, [narrow, allowed]);

  const question = draft.trim().replace(/\s+/g, ' ');
  const canSend = allowed && userId !== null && !pending && question.length >= MIN_QUESTION;

  async function send(text: string) {
    const q = text.trim().replace(/\s+/g, ' ').slice(0, MAX_QUESTION);
    if (!allowed || userId === null || pending || q.length < MIN_QUESTION) return;
    setDraft('');
    setMenu(null);
    await ask(userId, q);
    void client.invalidateQueries({ queryKey: ['assistant', 'history'] });
  }

  async function again(key: number) {
    if (userId === null) return;
    await retry(userId, key);
    void client.invalidateQueries({ queryKey: ['assistant', 'history'] });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send(draft);
    }
  }

  const examples = (status.data?.example_questions ?? []).map((q) => ({ key: q, question: q }));
  const recent = historyItems(history.data?.rows ?? []);

  const composer = (
    <form
      className="flex w-full flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void send(draft);
      }}
    >
      {exchanges.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Popover
            open={menu === 'examples'}
            onOpenChange={(next) => setMenu(next ? 'examples' : null)}
            className="w-[26rem]"
            trigger={
              <Button size="sm" variant="ghost" icon={Lightbulb} disabled={!examples.length}>
                Examples
              </Button>
            }
          >
            <div className="max-h-80 overflow-y-auto p-1">
              <QuestionList items={examples} onPick={(q) => void send(q)} disabled={pending || !allowed} />
            </div>
          </Popover>
          <Popover
            open={menu === 'recent'}
            onOpenChange={(next) => setMenu(next ? 'recent' : null)}
            className="w-[26rem]"
            trigger={
              <Button size="sm" variant="ghost" icon={History} disabled={!recent.length}>
                Recent questions
              </Button>
            }
          >
            <div className="max-h-80 overflow-y-auto p-1">
              <QuestionList items={recent} onPick={(q) => void send(q)} disabled={pending || !allowed} />
            </div>
          </Popover>
          <Button size="sm" variant="ghost" icon={Trash2} className="ml-auto" onClick={() => userId !== null && clearConversation(userId)} title="Clear this conversation (your question history is kept)">
            Clear
          </Button>
        </div>
      ) : null}
      <div className="flex items-end gap-2">
        <Textarea
          ref={inputRef}
          rows={2}
          value={draft}
          maxLength={MAX_QUESTION}
          disabled={!allowed}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={allowed ? 'Ask about prices, promotions, retailers or competitors…' : 'Your role cannot use the assistant'}
          aria-label="Your question"
          className="max-h-40 min-h-[58px] resize-none bg-surface"
        />
        <Button type="submit" variant="primary" size="lg" icon={ArrowUp} loading={pending} disabled={!canSend} aria-label="Ask">
          Ask
        </Button>
      </div>
      <p className="flex justify-between gap-3 text-[11.5px] leading-4 text-ink-3">
        <span className="hidden sm:inline">Enter to send · Shift+Enter for a new line</span>
        <span className="sm:hidden">Answers use stored observations only</span>
        {draft.length > MAX_QUESTION - 100 ? <span className="num">{draft.length} / {MAX_QUESTION}</span> : null}
      </p>
    </form>
  );

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="lg"
      title="Intelligence assistant"
      subtitle="Answers come only from stored price observations. If something was never collected, the assistant says so."
      footer={composer}
    >
      {!allowed ? (
        <Notice tone="warn" title="The assistant is not available for your role">
          Ask an administrator for access. Nothing is sent or stored while it is unavailable.
        </Notice>
      ) : exchanges.length === 0 ? (
        <div className="flex flex-col gap-5">
          {status.isError && !status.data ? (
            <ErrorState error={status.error} onRetry={() => void status.refetch()} className="py-6" />
          ) : status.data ? (
            <EngineNote status={status.data} onNavigate={onClose} canConfigure={can('admin.integrations')} />
          ) : (
            <div className="flex items-center gap-2 text-[12.5px] text-ink-3">
              <Spinner /> Checking the assistant…
            </div>
          )}

          {examples.length ? (
            <section aria-label="Example questions">
              <h3 className="eyebrow mb-2">Try a question</h3>
              <ul className="flex flex-wrap gap-2">
                {examples.map((item) => (
                  <li key={item.key} className="max-w-full">
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => void send(item.question)}
                      className="max-w-full rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-left text-[13px] leading-5 text-ink transition-colors hover:border-ink-4 hover:bg-sunken disabled:opacity-50"
                    >
                      {item.question}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section aria-label="Recent questions">
            <h3 className="eyebrow mb-1.5">Recent questions</h3>
            {history.isError ? (
              <p className="text-[12.5px] text-ink-3">
                Your earlier questions could not be loaded.{' '}
                <button type="button" className="link" onClick={() => void history.refetch()}>
                  Try again
                </button>
              </p>
            ) : !history.data ? (
              <div className="flex items-center gap-2 text-[12.5px] text-ink-3">
                <Spinner /> Loading…
              </div>
            ) : recent.length === 0 ? (
              <p className="text-[12.5px] leading-5 text-ink-3">Nothing asked yet. Questions you ask are kept here so they can be asked again.</p>
            ) : (
              <div className="-mx-2.5">
                <QuestionList items={recent.slice(0, 8)} onPick={(q) => void send(q)} disabled={pending} />
              </div>
            )}
          </section>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {status.data && status.data.provider_setting === 'anthropic' && status.data.engine !== 'claude' ? (
            <EngineNote status={status.data} onNavigate={onClose} canConfigure={can('admin.integrations')} />
          ) : null}
          {exchanges.map((exchange, index) => (
            <div key={exchange.key} ref={index === exchanges.length - 1 ? latestRef : undefined} className="scroll-mt-2">
              <ExchangeView exchange={exchange} onRetry={() => void again(exchange.key)} onNavigate={onClose} />
            </div>
          ))}
          {/* room below a short last answer, so its question can still be brought to the top */}
          <div aria-hidden className="h-24" />
        </div>
      )}
    </Drawer>
  );
}
