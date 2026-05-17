import { useEffect, useRef, useState } from 'react';
import type { HealthDTO, PublisherKind } from '../types/api';

const HEALTH_URL = (import.meta as unknown as { env?: Record<string, string | undefined> })
  .env?.['VITE_BACKEND_URL'] ?? 'http://localhost:8001';

const POLL_INTERVAL_MS = 5_000;

export interface SystemHealth {
  publisher: PublisherKind;
  loading:   boolean;
}

export function useSystemHealth(): SystemHealth {
  const [publisher, setPublisher] = useState<PublisherKind>('none');
  const [loading,   setLoading]   = useState(true);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`${HEALTH_URL}/v1/health`);
        if (!res.ok || cancelled) return;
        const dto: HealthDTO = await res.json() as HealthDTO;
        if (!cancelled) {
          setPublisher(dto.publisher);
          setLoading(false);
        }
      } catch {
        // network error → keep previous publisher value, don't flip to none
        if (!cancelled) setLoading(false);
      }
    }

    void poll();
    timer.current = window.setInterval(() => { void poll(); }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timer.current !== null) {
        window.clearInterval(timer.current);
        timer.current = null;
      }
    };
  }, []);

  return { publisher, loading };
}
