// marketApi tests — pure HTTP wrappers, fetch mocked at vi level.
// Covers all three surfaces (recent / snapshot / tape): happy path,
// validation guard, RFC 7807 problem parsing, network failure,
// abort/timeout, JSON parse failure.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  fetchRecentTicks,
  fetchTickSnapshot,
  fetchTickTape,
} from './marketApi';
import { PROBLEM_TYPE } from '../types/api';

// ── fetch double ──────────────────────────────────────────────────────
//
// Each test calls one of the API helpers; we stub global fetch to
// return a controllable Response. Reset between tests via the
// vitest.config.ts restoreMocks/clearMocks settings.

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const res = new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
  return res;
}

function textResponse(text: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'text/plain', ...headers },
  });
}

describe('fetchRecentTicks', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns ok=true with parsed payload on 200', async () => {
    const payload = { symbol: '005930', ticks: [{
      ts: '2026-05-11T00:00:00Z', price: 79100, volume: 100, side: 'buy',
    }] };
    fetchSpy.mockResolvedValueOnce(jsonResponse(payload, 200, { 'x-request-id': 'req-1' }));

    const result = await fetchRecentTicks('005930', { limit: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual(payload);
    expect(result.requestId).toBe('req-1');
    // URL should include symbol + limit as query params
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain('symbol=005930');
    expect(url).toContain('limit=10');
  });

  it('rejects empty symbol locally without hitting fetch', async () => {
    const result = await fetchRecentTicks('', { limit: 10 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.type).toBe(PROBLEM_TYPE.VALIDATION);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects out-of-range limit locally', async () => {
    const lo = await fetchRecentTicks('005930', { limit: 0 });
    const hi = await fetchRecentTicks('005930', { limit: 501 });
    expect(lo.ok).toBe(false);
    expect(hi.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('parses RFC 7807 problem on non-2xx', async () => {
    const problem = {
      type: PROBLEM_TYPE.VALIDATION,
      title: 'Validation Error',
      status: 422,
      detail: 'bad params',
      request_id: 'req-bad',
    };
    fetchSpy.mockResolvedValueOnce(jsonResponse(problem, 422));
    const result = await fetchRecentTicks('005930');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.status).toBe(422);
    expect(result.problem.title).toBe('Validation Error');
    expect(result.problem.detail).toBe('bad params');
  });

  it('falls back to status-only title when error body is not JSON', async () => {
    fetchSpy.mockResolvedValueOnce(textResponse('<html>502 Bad Gateway</html>', 502));
    const result = await fetchRecentTicks('005930');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.status).toBe(502);
    expect(result.problem.title).toBe('HTTP 502');
  });

  it('synthesizes NETWORK problem when fetch throws', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const result = await fetchRecentTicks('005930');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.type).toBe(PROBLEM_TYPE.NETWORK);
    expect(result.problem.status).toBe(0);
  });

  it('synthesizes 504 timeout when AbortError fires', async () => {
    const abortErr = new DOMException('aborted', 'AbortError');
    fetchSpy.mockRejectedValueOnce(abortErr);
    const result = await fetchRecentTicks('005930');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.title).toBe('Request Timeout');
    expect(result.problem.status).toBe(504);
  });

  it('caller AbortSignal cancels in-flight request', async () => {
    const ctrl = new AbortController();
    fetchSpy.mockImplementationOnce((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });
    const pending = fetchRecentTicks('005930', { signal: ctrl.signal });
    ctrl.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
  });
});

describe('fetchTickSnapshot', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('short-circuits to empty envelope when symbol list is empty', async () => {
    const result = await fetchTickSnapshot([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ requested: [], snapshots: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('trims and joins symbol list before sending', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ requested: ['A', 'B'], snapshots: [] }));
    await fetchTickSnapshot(['  A  ', '', 'B', '   ']);
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain('symbols=A%2CB');
  });

  it('returns parsed snapshots on 200', async () => {
    const payload = {
      requested: ['005930'],
      snapshots: [{
        symbol: '005930', ts: '2026-05-11T00:00:00Z',
        price: 79100, volume: 250, side: 'buy',
      }],
    };
    fetchSpy.mockResolvedValueOnce(jsonResponse(payload));
    const result = await fetchTickSnapshot(['005930']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.snapshots).toHaveLength(1);
    expect(result.data.snapshots[0]!.price).toBe(79100);
  });
});

describe('fetchTickTape', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('short-circuits when symbol list is empty', async () => {
    const result = await fetchTickTape([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ entries: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects out-of-range limit locally', async () => {
    expect((await fetchTickTape(['005930'], { limit: 0 })).ok).toBe(false);
    expect((await fetchTickTape(['005930'], { limit: 501 })).ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns parsed entries newest-first', async () => {
    const payload = {
      entries: [
        { ts: '2026-05-11T00:00:02Z', symbol: '005930', price: 79100, volume: 100, side: 'buy' },
        { ts: '2026-05-11T00:00:01Z', symbol: '000660', price: 197000, volume: 50, side: 'sell' },
      ],
    };
    fetchSpy.mockResolvedValueOnce(jsonResponse(payload));
    const result = await fetchTickTape(['005930', '000660'], { limit: 50 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.entries).toHaveLength(2);
    expect(result.data.entries[0]!.symbol).toBe('005930');
  });
});
