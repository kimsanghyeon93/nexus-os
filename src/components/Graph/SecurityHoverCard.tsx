// SecurityHoverCard — small obsidian-style preview when the operator
// hovers a node in `mode='securities'`. Spec §4.4.
//
// Layout — 4 mono rows:
//   1. display_name              (mono-hi, fg)
//   2. ticker · market           (mono-dim, ash)
//   3. sector_label              (mono, cyan)
//   4. last_price · change_pct   (mono-hi fg + lime/amber/ash color)
//
// Visuals — NEXUS tokens only:
//   - panel: `nx-glass` (backdrop blur 18px, --bg-glass background,
//            --border-glass hairline border, --r-2 radius).
//   - typography: var(--type-mono), var(--type-mono-hi), .nx-label.
//   - colors: var(--cyan), var(--lime), var(--amber), var(--ash),
//             var(--fg), var(--fg-dim).
//   - motion: opacity 0→1 in var(--dur-1) on `data-visible=true`;
//             prefers-reduced-motion zeros the transition (handled by
//             the parent stylesheet or inline rule below).
//
// Positioning — the parent passes pixel coords already clamped to the
// canvas bounds; this component just renders at that absolute position
// with a 12px offset to the upper-right of the cursor (or the parent's
// computed anchor when the cursor is near the right/bottom edge).
//
// Hover-show delay (250ms) lives in the parent (RadarCanvas / its
// wrapper) — keeping the card stateless makes it cheap to unit-test
// and lets the parent decide whether to render at all.

import type { CSSProperties } from 'react';
import type { SecurityMarket } from '../../types/api';

export interface SecurityHoverCardProps {
  /** Pixel coordinate (canvas-local) where the card's top-left anchor
   *  should sit. Already 12px offset from the cursor / node and clamped
   *  to viewport bounds by the parent. */
  x: number;
  y: number;
  visible: boolean;
  displayName: string;
  ticker: string;
  market: SecurityMarket | string | undefined;
  sectorLabel: string | undefined;
  lastPrice: number | null | undefined;
  changePct: number | null | undefined;
  /** ISO 4217 — used to pick a thin currency suffix on the price line.
   *  Default 'KRW' for the KIS universe; pass 'USD' for US tickers. */
  currency?: string;
  /** When true (parent reads `window.matchMedia('(prefers-reduced-
   *  motion: reduce)').matches`), the transition is zeroed so the card
   *  appears/disappears instantly. */
  reducedMotion?: boolean;
}

export function SecurityHoverCard(props: SecurityHoverCardProps) {
  const {
    x, y, visible,
    displayName, ticker, market,
    sectorLabel,
    lastPrice, changePct,
    currency = 'KRW',
    reducedMotion = false,
  } = props;

  const changeColor =
    changePct === null || changePct === undefined ? 'var(--ash)' :
    changePct > 0 ? 'var(--lime)' :
    changePct < 0 ? 'var(--amber)' :
    'var(--ash)';

  // Format change with sign + 2-decimal precision. `+1.42%` vs `-0.31%`.
  const changeText =
    changePct === null || changePct === undefined
      ? '—'
      : `${changePct > 0 ? '+' : ''}${changePct.toFixed(2)}%`;

  const priceText =
    lastPrice === null || lastPrice === undefined
      ? '—'
      : formatPrice(lastPrice, currency);

  return (
    <div
      role="tooltip"
      data-testid="security-hover-card"
      data-visible={visible ? 'true' : 'false'}
      className="nx-glass"
      style={{
        ...CARD,
        left: x,
        top:  y,
        opacity: visible ? 1 : 0,
        transition: reducedMotion
          ? 'none'
          : 'opacity var(--dur-1) var(--ease-out)',
        pointerEvents: 'none',
      }}
    >
      <div style={ROW_NAME}>{displayName}</div>
      <div style={ROW_META}>
        <span>{ticker}</span>
        {market ? <span style={DOT_SEP}>·</span> : null}
        {market ? <span>{market}</span> : null}
      </div>
      <div style={ROW_SECTOR}>{sectorLabel ?? '—'}</div>
      <div style={ROW_PRICE}>
        <span style={{ color: 'var(--fg)' }}>{priceText}</span>
        <span style={DOT_SEP}>·</span>
        <span style={{ color: changeColor }}>{changeText}</span>
      </div>
    </div>
  );
}

// ── helpers ────────────────────────────────────────────────────────────

function formatPrice(price: number, currency: string): string {
  // KRW shows as integer (no fractional won in practice); other
  // currencies use 2-decimal. Locale-stable formatting via Intl is
  // overkill for a hover preview — keep it cheap and explicit.
  if (currency === 'KRW') {
    return `${Math.round(price).toLocaleString('en-US')} ₩`;
  }
  const fixed = price.toFixed(2);
  return currency === 'USD' ? `$${fixed}` : `${fixed} ${currency}`;
}

// ── styles ─────────────────────────────────────────────────────────────

const CARD: CSSProperties = {
  position:      'absolute',
  display:       'flex',
  flexDirection: 'column',
  gap:           '2px',
  minWidth:      '160px',
  maxWidth:      '240px',
  padding:       'var(--s-2) var(--s-3)',
  zIndex:        90,
  // nx-glass class supplies background / blur / border / radius
};

const ROW_NAME: CSSProperties = {
  font:          'var(--type-mono-hi)',
  color:         'var(--fg)',
  letterSpacing: 'var(--track-mono)',
  whiteSpace:    'nowrap',
  overflow:      'hidden',
  textOverflow:  'ellipsis',
};

const ROW_META: CSSProperties = {
  display:       'flex',
  gap:           '6px',
  font:          'var(--type-mono)',
  color:         'var(--ash)',
};

const ROW_SECTOR: CSSProperties = {
  font:          'var(--type-mono)',
  color:         'var(--cyan)',
};

const ROW_PRICE: CSSProperties = {
  display:       'flex',
  gap:           '6px',
  alignItems:    'baseline',
  font:          'var(--type-mono-hi)',
  fontVariantNumeric: 'tabular-nums',
};

const DOT_SEP: CSSProperties = {
  color: 'var(--fg-low)',
};
