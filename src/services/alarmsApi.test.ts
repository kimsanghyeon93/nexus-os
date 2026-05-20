// alarmsApi tests — pure HTTP wrapper. Same patterns as auditApi /
// marketApi tests; verifies the alarms-specific surface only:
//   • happy 200 path returns the parsed envelope
//   • local validation guard for limit out of range
//   • RFC 7807 ProblemDetail parsing on 4xx / 5xx
//   • NETWORK synthesis on fetch reject (PROBLEM_TYPE.NETWORK)
//   • auth-failed (401) preserves the backend's type URI
//   • CSV serialization of severity / status / source filters

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { fetchAlarms } from './alarmsApi';
import { PROBLEM_TYPE } from '../types/api';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('fetchAlarms', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns envelope shape on 200', async () => {
    const payload = {
      items: [{
        id:              '01HXYR3K9P7M4Q8N2V5W6X7Y8Z',
        severity:        'anomaly',
        status:          'active',
        source:          'trading-coordinator',
        code:            'VOLATILITY_BREAKER_TRIPPED',
        title:           'VOLATILITY BREAKER TRIPPED',
        message:         'SMH 6 sigma in 30s window — fills paused.',
        entity_id:       'SMH',
        occurred_at:     '2026-05-13T08:42:11.314Z',
        acknowledged_at: null,
        resolved_at:     null,
        metadata:        { symbol: 'SMH', sigma: 6.1 },
      }],
      total:                1,
      unacknowledged_count: 1,
      window_since:         '2026-05-12T08:42:11.314Z',
      server_time:          '2026-05-13T08:42:11.500Z',
    };
    fetchSpy.mockResolvedValueOnce(jsonResponse(payload, 200, { 'x-request-id': 'req-A' }));

    const result = await fetchAlarms();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items).toHaveLength(1);
    const [alarm] = result.data.items;
    expect(alarm?.id).toBe('01HXYR3K9P7M4Q8N2V5W6X7Y8Z');
    expect(alarm?.severity).toBe('anomaly');
    expect(alarm?.entity_id).toBe('SMH');
    expect(alarm?.acknowledged_at).toBeNull();
    expect(result.data.unacknowledged_count).toBe(1);
    expect(result.data.window_since).toBe('2026-05-12T08:42:11.314Z');
    expect(result.requestId).toBe('req-A');
  });

  it('rejects out-of-range limit locally without hitting fetch', async () => {
    const lo = await fetchAlarms({ limit: 0 });
    const hi = await fetchAlarms({ limit: 201 });
    expect(lo.ok).toBe(false);
    expect(hi.ok).toBe(false);
    if (lo.ok || hi.ok) return;
    expect(lo.problem.type).toBe(PROBLEM_TYPE.VALIDATION);
    expect(hi.problem.type).toBe(PROBLEM_TYPE.VALIDATION);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('serializes CSV filter params correctly', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      items: [],
      total: 0,
      unacknowledged_count: 0,
      window_since: null,
      server_time: '2026-05-13T08:42:11Z',
    }, 200));

    await fetchAlarms({
      limit:      25,
      since:      '2026-05-13T00:00:00Z',
      severities: ['anomaly', 'critical'],
      statuses:   ['active'],
      sources:    ['trading-coordinator', 'kis-publisher'],
    });

    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain('limit=25');
    expect(url).toContain('since=2026-05-13T00%3A00%3A00Z');
    expect(url).toContain('severity=anomaly%2Ccritical');
    expect(url).toContain('status=active');
    expect(url).toContain('source=trading-coordinator%2Ckis-publisher');
  });

  it('parses RFC 7807 envelope on 401', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      type:       PROBLEM_TYPE.AUTH,
      title:      'Unauthorized',
      status:     401,
      detail:     'missing or invalid bearer token',
      request_id: 'req-401',
    }, 401));

    const result = await fetchAlarms();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.type).toBe(PROBLEM_TYPE.AUTH);
    expect(result.problem.status).toBe(401);
    expect(result.problem.title).toBe('Unauthorized');
  });

  it('parses RFC 7807 envelope on 503', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      type:       'https://nexus-os.local/problems/upstream-error',
      title:      'Alarm store unavailable',
      status:     503,
      detail:     'alarm repository ping failed — retry',
      request_id: 'req-503',
    }, 503));

    const result = await fetchAlarms();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.title).toBe('Alarm store unavailable');
    expect(result.problem.status).toBe(503);
  });

  it('synthesizes NETWORK problem on fetch reject', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const result = await fetchAlarms();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.type).toBe(PROBLEM_TYPE.NETWORK);
    expect(result.problem.status).toBe(0);
  });

  it('falls back to INTERNAL on non-JSON error body', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('not json', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    }));
    const result = await fetchAlarms();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.type).toBe(PROBLEM_TYPE.INTERNAL);
    expect(result.problem.status).toBe(500);
  });
});
