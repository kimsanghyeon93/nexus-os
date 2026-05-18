import React, { useCallback, useEffect, useRef, useState } from 'react';
import { NEXUS_COLOR, NEXUS_SURFACE, withAlpha } from '../../styles/colors';
import { FONT_MONO } from '../../styles/fonts';
import { useOrder } from '../../hooks/useOrder';
import type { OrderRequestDTO } from '../../types/api';

// ── Props ──────────────────────────────────────────────────────────────────

interface OrderModalProps {
  open:    boolean;
  onClose: () => void;
}

// ── Types ──────────────────────────────────────────────────────────────────

type Step = 'input' | 'confirm' | 'result';
type Action = 'buy' | 'sell';
type OrderType = 'market' | 'limit';
type PublisherKind = 'kis' | 'mock' | 'none';

// ── Styles (module-level constants) ────────────────────────────────────────

const OVERLAY: React.CSSProperties = {
  position:        'fixed',
  inset:           0,
  background:      'rgba(0,0,0,0.55)',
  display:         'flex',
  alignItems:      'center',
  justifyContent:  'center',
  zIndex:          3000,
};

const PANEL: React.CSSProperties = {
  background:      NEXUS_SURFACE.panel,
  backdropFilter:  'blur(18px)',
  border:          `1px solid ${withAlpha(NEXUS_COLOR.cyan, 0.25)}`,
  borderRadius:    4,
  padding:         '20px 24px',
  width:           360,
  fontFamily:      FONT_MONO,
  position:        'relative',
};

const HEADER: React.CSSProperties = {
  display:         'flex',
  justifyContent:  'space-between',
  alignItems:      'center',
  marginBottom:    16,
};

const TITLE: React.CSSProperties = {
  color:           NEXUS_COLOR.cyan,
  fontSize:        11,
  letterSpacing:   '0.12em',
  fontWeight:      700,
  display:         'flex',
  alignItems:      'center',
  gap:             6,
};

const CLOSE_BTN: React.CSSProperties = {
  background:      'transparent',
  border:          'none',
  color:           NEXUS_COLOR.low,
  cursor:          'pointer',
  fontFamily:      FONT_MONO,
  fontSize:        13,
  padding:         '0 4px',
};

const FIELD_LABEL: React.CSSProperties = {
  color:       NEXUS_COLOR.low,
  fontSize:    9,
  letterSpacing: '0.10em',
  marginBottom: 4,
  textTransform: 'uppercase' as const,
};

const INPUT_STYLE: React.CSSProperties = {
  background:    withAlpha(NEXUS_COLOR.cyan, 0.06),
  border:        `1px solid ${withAlpha(NEXUS_COLOR.cyan, 0.20)}`,
  borderRadius:  2,
  color:         NEXUS_COLOR.bone,
  fontFamily:    FONT_MONO,
  fontSize:      11,
  padding:       '5px 8px',
  width:         '100%',
  outline:       'none',
  boxSizing:     'border-box' as const,
};

const SEGMENT_BTN = (active: boolean, color: string): React.CSSProperties => ({
  flex:          1,
  background:    active ? withAlpha(color, 0.18) : 'transparent',
  border:        `1px solid ${active ? withAlpha(color, 0.50) : withAlpha(NEXUS_COLOR.cyan, 0.20)}`,
  borderRadius:  2,
  color:         active ? color : NEXUS_COLOR.low,
  cursor:        'pointer',
  fontFamily:    FONT_MONO,
  fontSize:      10,
  letterSpacing: '0.10em',
  padding:       '4px 0',
  fontWeight:    active ? 700 : 400,
  transition:    'all 100ms ease',
});

const PRIMARY_BTN: React.CSSProperties = {
  background:    withAlpha(NEXUS_COLOR.cyan, 0.15),
  border:        `1px solid ${withAlpha(NEXUS_COLOR.cyan, 0.40)}`,
  borderRadius:  2,
  color:         NEXUS_COLOR.cyan,
  cursor:        'pointer',
  fontFamily:    FONT_MONO,
  fontSize:      10,
  letterSpacing: '0.10em',
  padding:       '5px 14px',
  fontWeight:    700,
};

const GHOST_BTN: React.CSSProperties = {
  background:    'transparent',
  border:        `1px solid ${withAlpha(NEXUS_COLOR.cyan, 0.20)}`,
  borderRadius:  2,
  color:         NEXUS_COLOR.low,
  cursor:        'pointer',
  fontFamily:    FONT_MONO,
  fontSize:      10,
  letterSpacing: '0.10em',
  padding:       '5px 14px',
};

const DIVIDER: React.CSSProperties = {
  borderTop:  `1px solid ${withAlpha(NEXUS_COLOR.cyan, 0.12)}`,
  margin:     '14px 0',
};

const FIELD_ROW: React.CSSProperties = { marginBottom: 12 };

// ── PublisherBadge ─────────────────────────────────────────────────────────

function PublisherBadge({ kind }: { kind: PublisherKind }) {
  const label = kind === 'kis' ? 'LIVE' : 'PAPER';
  const color = kind === 'kis' ? NEXUS_COLOR.amber : NEXUS_COLOR.cyan;
  return (
    <span style={{
      background:    withAlpha(color, 0.15),
      border:        `1px solid ${withAlpha(color, 0.40)}`,
      borderRadius:  2,
      color:         color,
      fontSize:      8,
      letterSpacing: '0.12em',
      padding:       '1px 5px',
      fontWeight:    700,
    }}>
      {label}
    </span>
  );
}

// ── ConfirmRow ─────────────────────────────────────────────────────────────

function ConfirmRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
      <span style={{ color: NEXUS_COLOR.low, fontSize: 10 }}>{label}</span>
      <span style={{ color: NEXUS_COLOR.bone, fontSize: 10, fontWeight: 600 }}>{value}</span>
    </div>
  );
}

// ── OrderModalInner ────────────────────────────────────────────────────────

interface InnerProps {
  onClose: () => void;
}

function OrderModalInner({ onClose }: InnerProps) {
  const { state, submit, reset } = useOrder();

  // Form state
  const [step,      setStep]      = useState<Step>('input');
  const [symbol,    setSymbol]    = useState('');
  const [action,    setAction]    = useState<Action>('buy');
  const [quantity,  setQuantity]  = useState('');
  const [orderType, setOrderType] = useState<OrderType>('market');
  const [price,     setPrice]     = useState('');
  const [publisher, setPublisher] = useState<PublisherKind>('mock');

  // Fetch publisher kind from /v1/health on mount
  useEffect(() => {
    let cancelled = false;
    fetch('/v1/health')
      .then(r => r.json())
      .then(d => {
        if (!cancelled) setPublisher(d.publisher === 'kis' ? 'kis' : 'mock');
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // ESC closes modal
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Sync result phase → step
  useEffect(() => {
    if (state.phase === 'success' || state.phase === 'error') {
      setStep('result');
    }
  }, [state.phase]);

  // Derived
  const qtyNum   = parseInt(quantity, 10);
  const priceNum = parseInt(price,    10);
  const canNext  =
    symbol.trim().length > 0 &&
    !isNaN(qtyNum) && qtyNum > 0 &&
    (orderType === 'market' || (!isNaN(priceNum) && priceNum > 0));

  const handleSubmit = useCallback(async () => {
    const req: OrderRequestDTO = {
      symbol:     symbol.trim().toUpperCase(),
      action,
      quantity:   qtyNum,
      order_type: orderType,
      price:      orderType === 'limit' ? priceNum : 0,
    };
    await submit(req);
  }, [symbol, action, qtyNum, orderType, priceNum, submit]);

  const handleClose = useCallback(() => {
    reset();
    setStep('input');
    onClose();
  }, [reset, onClose]);

  // ── Step: input ──────────────────────────────────────────────────────

  if (step === 'input') {
    return (
      <>
        <div style={HEADER}>
          <div style={TITLE}>
            <span style={{ color: NEXUS_COLOR.cyan }}>◆</span>
            ORDER ENTRY
            <PublisherBadge kind={publisher} />
          </div>
          <button style={CLOSE_BTN} onClick={handleClose} type="button" aria-label="Close">×</button>
        </div>

        <div style={FIELD_ROW}>
          <div style={FIELD_LABEL}>종목코드</div>
          <input
            style={INPUT_STYLE}
            value={symbol}
            onChange={e => setSymbol(e.target.value.toUpperCase())}
            placeholder="005930"
            maxLength={6}
            autoFocus
          />
        </div>

        <div style={FIELD_ROW}>
          <div style={FIELD_LABEL}>방향</div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              type="button"
              style={SEGMENT_BTN(action === 'buy', NEXUS_COLOR.lime)}
              onClick={() => setAction('buy')}
            >BUY</button>
            <button
              type="button"
              style={SEGMENT_BTN(action === 'sell', NEXUS_COLOR.amber)}
              onClick={() => setAction('sell')}
            >SELL</button>
          </div>
        </div>

        <div style={FIELD_ROW}>
          <div style={FIELD_LABEL}>수량</div>
          <input
            style={INPUT_STYLE}
            type="number"
            min={1}
            value={quantity}
            onChange={e => setQuantity(e.target.value)}
            placeholder="100"
          />
        </div>

        <div style={FIELD_ROW}>
          <div style={FIELD_LABEL}>주문 유형</div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              type="button"
              style={SEGMENT_BTN(orderType === 'market', NEXUS_COLOR.cyan)}
              onClick={() => setOrderType('market')}
            >시장가</button>
            <button
              type="button"
              style={SEGMENT_BTN(orderType === 'limit', NEXUS_COLOR.cyan)}
              onClick={() => setOrderType('limit')}
            >지정가</button>
          </div>
        </div>

        {orderType === 'limit' && (
          <div style={FIELD_ROW}>
            <div style={FIELD_LABEL}>지정가 (KRW)</div>
            <input
              style={INPUT_STYLE}
              type="number"
              min={1}
              value={price}
              onChange={e => setPrice(e.target.value)}
              placeholder="72000"
            />
          </div>
        )}

        <div style={{ textAlign: 'right', marginTop: 8 }}>
          <button
            type="button"
            style={{ ...PRIMARY_BTN, opacity: canNext ? 1 : 0.4, cursor: canNext ? 'pointer' : 'not-allowed' }}
            onClick={() => canNext && setStep('confirm')}
            disabled={!canNext}
          >
            다음 →
          </button>
        </div>
      </>
    );
  }

  // ── Step: confirm ────────────────────────────────────────────────────

  if (step === 'confirm') {
    return (
      <>
        <div style={HEADER}>
          <div style={TITLE}>
            <span style={{ color: NEXUS_COLOR.cyan }}>◆</span>
            ORDER ENTRY
            <PublisherBadge kind={publisher} />
          </div>
          <button style={CLOSE_BTN} onClick={handleClose} type="button" aria-label="Close">×</button>
        </div>

        <div style={{ color: NEXUS_COLOR.low, fontSize: 9, letterSpacing: '0.10em', marginBottom: 12 }}>
          CONFIRM ORDER
        </div>

        <div style={DIVIDER} />

        <ConfirmRow label="종목" value={symbol} />
        <ConfirmRow label="방향" value={action.toUpperCase()} />
        <ConfirmRow label="수량" value={`${qtyNum.toLocaleString('ko-KR')}주`} />
        <ConfirmRow label="유형" value={orderType === 'market' ? '시장가' : '지정가'} />
        {orderType === 'limit' && (
          <ConfirmRow label="가격" value={`${priceNum.toLocaleString('ko-KR')} KRW`} />
        )}

        <div style={DIVIDER} />

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
          <button type="button" style={GHOST_BTN} onClick={() => setStep('input')}>← 수정</button>
          <button
            type="button"
            style={{
              ...PRIMARY_BTN,
              background: action === 'buy'
                ? withAlpha(NEXUS_COLOR.lime, 0.18)
                : withAlpha(NEXUS_COLOR.amber, 0.18),
              borderColor: action === 'buy'
                ? withAlpha(NEXUS_COLOR.lime, 0.50)
                : withAlpha(NEXUS_COLOR.amber, 0.50),
              color: action === 'buy' ? NEXUS_COLOR.lime : NEXUS_COLOR.amber,
            }}
            onClick={handleSubmit}
          >
            제출 ▸
          </button>
        </div>
      </>
    );
  }

  // ── Step: result ─────────────────────────────────────────────────────

  const isSuccess  = state.phase === 'success' && state.result.status === 'accepted';
  const isRejected = state.phase === 'success' && state.result.status === 'rejected';
  const isError    = state.phase === 'error';

  const resultColor  = isSuccess ? NEXUS_COLOR.lime : NEXUS_COLOR.amber;
  const resultGlyph  = isSuccess ? '✓' : '✗';
  const resultLabel  = isSuccess
    ? 'ORDER ACCEPTED'
    : isRejected
    ? 'ORDER REJECTED'
    : 'SUBMISSION ERROR';
  const resultDetail = state.phase === 'success'
    ? state.result.message
    : state.phase === 'error'
    ? state.message
    : '';
  const orderId = state.phase === 'success' ? state.result.order_id : null;

  return (
    <>
      <div style={HEADER}>
        <div style={TITLE}>
          <span style={{ color: NEXUS_COLOR.cyan }}>◆</span>
          ORDER ENTRY
          <PublisherBadge kind={publisher} />
        </div>
        <button style={CLOSE_BTN} onClick={handleClose} type="button" aria-label="Close">×</button>
      </div>

      <div style={{ textAlign: 'center', padding: '16px 0' }}>
        <div style={{ color: resultColor, fontSize: 13, fontWeight: 700, letterSpacing: '0.12em', marginBottom: 8 }}>
          {resultGlyph} {resultLabel}
        </div>
        {orderId && (
          <div style={{ color: NEXUS_COLOR.low, fontSize: 10, marginBottom: 4 }}>
            주문번호: {orderId}
          </div>
        )}
        {resultDetail && (
          <div style={{ color: NEXUS_COLOR.ash, fontSize: 9, marginTop: 6 }}>
            {resultDetail}
          </div>
        )}
      </div>

      <div style={{ textAlign: 'right', marginTop: 8 }}>
        <button type="button" style={PRIMARY_BTN} onClick={handleClose}>닫기</button>
      </div>
    </>
  );
}

// ── OrderModal (public export) ──────────────────────────────────────────────

export function OrderModal({ open, onClose }: OrderModalProps) {
  if (!open) return null;
  return (
    <div style={OVERLAY} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={PANEL}>
        <OrderModalInner onClose={onClose} />
      </div>
    </div>
  );
}
