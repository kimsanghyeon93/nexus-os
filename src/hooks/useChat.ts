// useChat — Conversation state + send/receive pipeline for the
// NEXUS · ASSISTANT panel. Sprint 5s+ "원래 채팅 디자인이 있던거 같은데 구현해".
//
// Architecture:
//   • History persists in localStorage so a reload doesn't wipe the
//     operator's running thread.
//   • `send(text)` immediately appends an operator message, then calls
//     the `respond` strategy to produce an assistant reply (which it
//     appends when resolved). The pending state is exposed as
//     `isResponding` so the UI can render a "..." typing indicator.
//   • `respond` is a swappable async function — today's default is a
//     deterministic context-aware stub that pattern-matches the message
//     against the operator's vocabulary (entity ids, command words).
//     The seam is positioned so a future backend `/v1/chat` endpoint
//     can be dropped in without touching the panel UI.
//
// Persistence shape: `{ messages: ChatMessage[] }`. Older fields are
// gracefully ignored, missing fields fall back to defaults — same
// defensive parse as the other persistence helpers.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const STORAGE_KEY = 'nexus_os_v1_chat_history';
const MAX_HISTORY = 60;

export type ChatRole = 'operator' | 'assistant' | 'system';

export interface ChatMessage {
  id:     string;
  role:   ChatRole;
  text:   string;
  ts:     number;     // unix ms — display sorted ascending
}

/** Response strategy. The default below is the synchronous context-aware
 *  stub; a future backend integration would pass an async function that
 *  calls `/v1/chat` and resolves with the assistant reply. */
export type ChatRespond = (
  text: string,
  history: ReadonlyArray<ChatMessage>,
) => Promise<string>;

const WELCOME: ChatMessage = {
  id:   '_welcome',
  role: 'system',
  text:
    'NEXUS · ASSISTANT online. Ask about an entity (e.g. "AAPL", "OBSIDIAN"), ' +
    'request a command (snapshot / audit / isolate), or query market state.',
  ts:   0,
};

function loadHistory(): ChatMessage[] {
  try {
    if (typeof window === 'undefined') return [WELCOME];
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [WELCOME];
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return [WELCOME];
    const obj = parsed as { messages?: unknown };
    if (!Array.isArray(obj.messages)) return [WELCOME];
    const out: ChatMessage[] = [];
    for (const m of obj.messages) {
      if (!m || typeof m !== 'object') continue;
      const x = m as Partial<ChatMessage>;
      if (typeof x.id !== 'string' || typeof x.text !== 'string') continue;
      if (x.role !== 'operator' && x.role !== 'assistant' && x.role !== 'system') continue;
      const ts = typeof x.ts === 'number' && Number.isFinite(x.ts) ? x.ts : Date.now();
      out.push({ id: x.id, role: x.role, text: x.text, ts });
    }
    // Always anchor with the welcome message at the top if storage was
    // empty after filtering; otherwise return the saved thread as-is.
    return out.length > 0 ? out : [WELCOME];
  } catch {
    return [WELCOME];
  }
}

function saveHistory(messages: ReadonlyArray<ChatMessage>): void {
  try {
    if (typeof window === 'undefined') return;
    const trimmed = messages.slice(-MAX_HISTORY);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ messages: trimmed }));
  } catch {
    // Quota / private-mode — best-effort.
  }
}

/* ------------------------------------------------------------------ */
/*  Default response strategy — context-aware stub                     */
/* ------------------------------------------------------------------ */

const ENTITY_HINTS: Record<string, string> = {
  // KIS / KRX
  '005930': 'Samsung Electronics (KRX 005930). KIS WS live during hours, Yahoo `.KS` off-hours.',
  '000660': 'SK Hynix (KRX 000660). Yahoo backend price observed ~1,880,000 KRW on 2026-05-11.',
  // US
  'AAPL':   'Apple Inc. (NASDAQ AAPL). Backend Yahoo /v8/finance/chart; latest ~$293.',
  'NVDA':   'NVIDIA Corp. (NASDAQ NVDA). Cross-sector tie to SMH + KRX_SEMI.',
  'BTC':    'Bitcoin (BTC-USD). Backend Yahoo, latest ~$81K.',
  'VIX':    'CBOE Volatility Index (^VIX). 30-day implied vol on S&P 500.',
  'XAU':    'Gold front-month (CL=F sister: GC=F). Backend Yahoo.',
  'EURUSD': 'Euro / US Dollar spot. Yahoo `EURUSD=X`, latest ~1.178.',
  'OBSIDIAN': 'Synthetic AML watchlist entity. No tradable counterpart — anomaly here is investigator-flagged, not market-driven.',
};

const COMMAND_HINTS: Record<string, string> = {
  snapshot: 'Capture snapshot is bound to ⌘S — it downloads the current dataset JSON.',
  audit:    'Audit transactions is ⌘L. Select an entity first, then ⌘L opens the audit modal with auto-refresh.',
  isolate:  'Isolate entity is ⌘I. Dims everything except the selected entity\'s 1-hop neighborhood.',
  trace:    'Trace flow path is ⌘T. Forward BFS along directed edges up to 4 hops downstream.',
  alert:    'Raise alert is ⌘! (Shift+1). Fires a 4-hop cascading shock animation centered on the selection.',
  replay:   'Replay last shock is ⌘R — fires `triggerAnomaly` against the last-shocked target id.',
  analyze:  'Analyze cluster is ⌘A. Tweens the viewport to scale 3 with the cluster center at canvas midpoint.',
};

/** Pattern-match the prompt against vocabulary + entity ids. Designed to
 *  feel like a helpful operator coach, not a search engine. */
function stubRespond(text: string): string {
  const t = text.trim();
  if (!t) return 'Type a question or an entity id (e.g. "AAPL", "005930", "OBSIDIAN").';
  const upper = t.toUpperCase();
  // Entity lookups — case-insensitive substring against the key.
  for (const [id, hint] of Object.entries(ENTITY_HINTS)) {
    if (upper.includes(id.toUpperCase())) return hint;
  }
  const lower = t.toLowerCase();
  for (const [cmd, hint] of Object.entries(COMMAND_HINTS)) {
    if (lower.includes(cmd)) return hint;
  }
  if (lower.includes('help')) {
    return 'Try: "AAPL", "what is OBSIDIAN", "how do I audit", "snapshot the canvas". ' +
           'Commands: snapshot/audit/isolate/trace/analyze/alert/replay.';
  }
  if (lower.includes('price') || lower.includes('가격')) {
    return 'Price ticks land in TimescaleDB via the Yahoo + KIS publishers. ' +
           'Ask about a specific symbol (AAPL, 005930, BTC, …) for its live status.';
  }
  return `Got it — "${t}". I can describe entities, point you to a command, ` +
         `or summarize live market state. Try saying an entity id or a command name.`;
}

const defaultRespond: ChatRespond = async (text) => {
  // Small simulated latency so the typing indicator actually shows up
  // (≈300-700ms). Real backend integration will replace this with a fetch.
  await new Promise<void>(resolve => setTimeout(resolve, 280 + Math.random() * 400));
  return stubRespond(text);
};

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

export interface UseChatOptions {
  /** Override the default stub responder. Most callers leave this default
   *  and let the stub handle responses; backend integration would pass
   *  a function that calls `/v1/chat`. */
  respond?: ChatRespond;
}

export interface UseChatApi {
  messages:     ReadonlyArray<ChatMessage>;
  isResponding: boolean;
  send:         (text: string) => void;
  clear:        () => void;
}

export function useChat(opts: UseChatOptions = {}): UseChatApi {
  const respondImpl = useMemo<ChatRespond>(() => opts.respond ?? defaultRespond, [opts.respond]);
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadHistory());
  const [isResponding, setIsResponding] = useState(false);
  // Counter for monotonic ids without coupling to crypto.randomUUID
  // (jsdom test envs may not have it).
  const idCounterRef = useRef(0);

  // Persist on every mutation. Cheap (<60 small records) and avoids a
  // catastrophic-tab-close losing the thread.
  useEffect(() => { saveHistory(messages); }, [messages]);

  const nextId = useCallback((): string => {
    idCounterRef.current += 1;
    return `m${Date.now()}-${idCounterRef.current}`;
  }, []);

  const send = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const operatorMsg: ChatMessage = {
      id:   nextId(),
      role: 'operator',
      text: trimmed,
      ts:   Date.now(),
    };
    setMessages(prev => [...prev, operatorMsg]);
    setIsResponding(true);
    // Capture the pre-response history snapshot so the responder gets
    // a stable view — even if more messages arrive while it's running.
    setMessages(prev => {
      const snapshot = prev.concat(operatorMsg);
      void (async () => {
        let answer: string;
        try {
          answer = await respondImpl(trimmed, snapshot);
        } catch (e: unknown) {
          answer = `Responder error: ${e instanceof Error ? e.message : 'unknown'}`;
        }
        const assistantMsg: ChatMessage = {
          id:   nextId(),
          role: 'assistant',
          text: answer,
          ts:   Date.now(),
        };
        setMessages(curr => [...curr, assistantMsg]);
        setIsResponding(false);
      })();
      // The state update is just the operator message; the assistant
      // arrives in the async callback above via the second setMessages.
      return snapshot;
    });
  }, [nextId, respondImpl]);

  const clear = useCallback(() => {
    setMessages([WELCOME]);
    try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* ok */ }
  }, []);

  return { messages, isResponding, send, clear };
}
