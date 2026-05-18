// useOrder — single-shot order submission state machine.
//
// Phases: idle → submitting → success | error
// Calling reset() returns to idle so the operator can place another order.
// Inflight requests are aborted on unmount.

import { useCallback, useEffect, useRef, useState } from 'react';

import { submitOrder } from '../services/orderApi';
import type { OrderRequestDTO, OrderResponseDTO } from '../types/api';

export type OrderPhase =
  | { phase: 'idle' }
  | { phase: 'submitting' }
  | { phase: 'success'; result: OrderResponseDTO }
  | { phase: 'error';   message: string };

export interface UseOrderResult {
  state:  OrderPhase;
  submit: (req: OrderRequestDTO) => Promise<void>;
  reset:  () => void;
}

export function useOrder(): UseOrderResult {
  const [state, setState] = useState<OrderPhase>({ phase: 'idle' });
  const mountedRef = useRef(true);
  const ctrlRef    = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      ctrlRef.current?.abort();
    };
  }, []);

  const submit = useCallback(async (req: OrderRequestDTO): Promise<void> => {
    // Abort any previous inflight request.
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;

    if (mountedRef.current) setState({ phase: 'submitting' });

    const result = await submitOrder(req, { signal: ctrl.signal });

    if (!mountedRef.current || ctrl.signal.aborted) return;

    if (result.ok) {
      setState({ phase: 'success', result: result.data });
    } else {
      setState({
        phase:   'error',
        message: result.problem?.detail ?? result.problem?.title ?? 'Order submission failed',
      });
    }
  }, []);

  const reset = useCallback(() => {
    if (mountedRef.current) setState({ phase: 'idle' });
  }, []);

  return { state, submit, reset };
}
