// auditApi tests — pure HTTP wrapper. Same patterns as marketApi
// tests; covers the audit-specific surface only.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { fetchRecentAudit } from './auditApi';
import { PROBLEM_TYPE } from '../types/api';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('fetchRecentAudit', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns envelope with rows on 200', async () => {
    const payload = {
      symbol: '005930',
      rows: [{
        ts: '2026-05-11T00:00:00Z',
        symbol: '005930',
        mode: 'noop',
        executed: false,
        intended_action: 'hold',
        intended_quantity: 0,
        order_id: null,
        blocked_by: null,
        reason: null,
        signal_action: 'hold',
        signal_confidence: 0,
        signal_score: 0,
        signal_rationale: [],
      }],
    };
    fetchSpy.mockResolvedValueOnce(jsonResponse(payload, 200, { 'x-request-id': 'req-A' }));
    const result = await fetchRecentAudit('005930');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.rows).toHaveLength(1);
    expect(result.requestId).toBe('req-A');
  });

  it('rejects empty symbol without hitting fetch', async () => {
    const result = await fetchRecentAudit('');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.type).toBe(PROBLEM_TYPE.VALIDATION);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects out-of-range limit', async () => {
    const lo = await fetchRecentAudit('005930', { limit: 0 });
    const hi = await fetchRecentAudit('005930', { limit: 201 });
    expect(lo.ok).toBe(false);
    expect(hi.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('parses RFC 7807 error envelope', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      type: PROBLEM_TYPE.INTERNAL,
      title: 'Server Down',
      status: 503,
      detail: 'database unavailable',
      request_id: 'req-503',
    }, 503));
    const result = await fetchRecentAudit('005930');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.title).toBe('Server Down');
    expect(result.problem.status).toBe(503);
  });

  it('synthesizes NETWORK problem on fetch reject', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const result = await fetchRecentAudit('005930');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.type).toBe(PROBLEM_TYPE.NETWORK);
  });
});
