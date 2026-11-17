/**
 * The assistant conversation of this browser session. It lives outside the panel component because the
 * panel is unmounted when it closes: an answer that arrives after closing still lands here, and reopening
 * shows the conversation again. Conversations are kept per signed-in user and never cross accounts.
 */
import { useSyncExternalStore } from 'react';
import { ApiError, apiPost } from '@/lib/api.ts';
import type { AssistantAnswer } from '@shared/api/assistant.ts';

export interface Exchange {
  key: number;
  question: string;
  askedAt: string;
  state: 'pending' | 'done' | 'error';
  answer: AssistantAnswer | null;
  error: { message: string; retryable: boolean } | null;
}

const MAX_EXCHANGES = 40;
const EMPTY: Exchange[] = [];
const conversations = new Map<number, Exchange[]>();
const listeners = new Set<() => void>();
let sequence = 0;

function update(userId: number, change: (list: Exchange[]) => Exchange[]): void {
  conversations.set(userId, change(conversations.get(userId) ?? EMPTY).slice(-MAX_EXCHANGES));
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useConversation(userId: number | null): Exchange[] {
  return useSyncExternalStore(subscribe, () => (userId === null ? EMPTY : (conversations.get(userId) ?? EMPTY)));
}

function describeError(err: unknown): Exchange['error'] {
  if (err instanceof ApiError) {
    if (err.status === 429) return { message: 'Too many questions in a short time. Wait a moment, then ask again.', retryable: true };
    if (err.status === 403) return { message: 'Your role is not allowed to use the assistant.', retryable: false };
    // validation problems (400 / 422) will not change on a retry; server faults might
    return { message: err.message, retryable: err.status >= 500 };
  }
  return { message: 'The question could not be sent. Check the connection and try again.', retryable: true };
}

async function run(userId: number, key: number, question: string): Promise<void> {
  try {
    const answer = await apiPost<AssistantAnswer>('/assistant/query', { question });
    update(userId, (list) => list.map((e) => (e.key === key ? { ...e, state: 'done', answer, error: null } : e)));
  } catch (err) {
    update(userId, (list) => list.map((e) => (e.key === key ? { ...e, state: 'error', answer: null, error: describeError(err) } : e)));
  }
}

/** Adds the question to the conversation and resolves when its answer (or error) has been recorded. */
export function ask(userId: number, question: string): Promise<void> {
  const key = ++sequence;
  update(userId, (list) => [...list, { key, question, askedAt: new Date().toISOString(), state: 'pending', answer: null, error: null }]);
  return run(userId, key, question);
}

/** Sends a failed question again in place. */
export function retry(userId: number, key: number): Promise<void> {
  const exchange = conversations.get(userId)?.find((e) => e.key === key);
  if (!exchange || exchange.state !== 'error') return Promise.resolve();
  update(userId, (list) => list.map((e) => (e.key === key ? { ...e, state: 'pending', error: null } : e)));
  return run(userId, key, exchange.question);
}

export function clearConversation(userId: number): void {
  // a question still on its way keeps its place so its answer is not lost
  update(userId, (list) => list.filter((e) => e.state === 'pending'));
}
