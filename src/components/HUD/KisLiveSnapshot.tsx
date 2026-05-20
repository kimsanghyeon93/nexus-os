// KisLiveSnapshot — Sprint 5p-D right-column panel.
//
// All 12 KIS-subscribed symbols at a glance. One row per symbol with:
//   • live indicator (lime dot if a tick landed within LIVE_WINDOW_MS)
//   • ID + human label
//   • current price (right-aligned)
//   • % delta vs the previous-recorded tick (small, color-coded)
//
// Polls /v1/ticks/snapshot at 2s — DISTINCT ON server side coalesces
// the 12 reads into one round-trip, so the budget is the same as one
// /v1/ticks/recent call. Click any row to select that entity in the
// canvas + propagate selection to PropertyHUD.
//
// Hides itself entirely when no KIS symbols are configured (defensive
// — the prop arrives empty in test harnesses, no point rendering an
// empty frame).

import { useEffect, useRef, useState } from 'react';

import { fetchTickSnapshot } from '../../services/marketApi';
import { NEXUS_COLOR, withAlpha } from '../../styles/colors';
import { FONT_MONO } from '../../styles/fonts';
import { useLanguage } from '../../utils/i18n';
import type { MarketTickSnapshot } from '../../types/api';
import type { NexusEntity } from '../../types/nexus';

const POLL_INTERVAL_MS = 2000;
const LIVE_WINDOW_MS   = 4000;     // mirrors useMarketData's pulse window + slack

export interface KisLiveSnapshotProps {
  /** Universe to render — typically the 12 KIS subscriptions from the
   *  current dataset. Pass an empty array to hide the panel. */
  symbols:    ReadonlyArray<string>;
  /** All entities so the panel can map symbol → label without an extra
   *  network round-trip. Lookup is via `Map<string, NexusEntity>` built
   *  in the parent — passing here keeps this component dumb. */
  entityMap:  ReadonlyMap<string, NexusEntity>;
  /** Click handler — selects the entity in the canvas + HUD. */
  onSelect?:  ((id: string) => void) | undefined;
  /** Currently-selected entity (so we can highlight the matching row). */
  selectedId?: string | null;
}

interface PriceSample {
  price:  number;
  ts:     number;   // wall-clock ms when we last RECEIVED this sample
}

/** Per-symbol price history kept locally — we compare current vs
 *  previous to compute the %-delta arrow. Snapshot endpoint returns
 *  only the latest tick, so the previous price has to come from
 *  whatever we saw last poll. Two slots so the render always sees
 *  yesterday's value vs today's — see comment in the fetch effect
 *  for the lifecycle. First-load delta is 0. */
interface PriceSlots {
  prev:    Map<string, PriceSample>;  // last poll's distinct price
  current: Map<string, PriceSample>;  // most recent price (any poll)
}

function newSlots(): PriceSlots {
  return { prev: new Map(), current: new Map() };
}

export function KisLiveSnapshot({
  symbols, entityMap, onSelect, selectedId,
}: KisLiveSnapshotProps) {
  const { t } = useLanguage();
  const [snapshots, setSnapshots] = useState<MarketTickSnapshot[]>([]);
  const slotsRef = useRef<PriceSlots>(newSlots());
  // Wall-clock at the last successful poll; drives the per-row "live"
  // indicator below. Keeping it on a 1s render tick avoids a setState
  // burst when 12 symbols update in lockstep.
  const [, setNowTick] = useState(0);

  useEffect(() => {
    if (symbols.length === 0) return;
    let mounted = true;
    let ctrl: AbortController | null = null;

    const pull = async () => {
      ctrl?.abort();
      ctrl = new AbortController();
      const result = await fetchTickSnapshot(symbols, { signal: ctrl.signal });
      if (!mounted) return;
      if (result.ok) {
        // Two-slot lifecycle. For each symbol whose price has CHANGED:
        //   1. Move the current value into the `prev` slot (so the
        //      delta arrow compares yesterday vs today).
        //   2. Write the new value into the `current` slot.
        // If the price hasn't changed across polls, neither slot moves
        // — the `prev` baseline stays anchored to the last actual move,
        // so a long quiet period doesn't slowly collapse the delta to
        // zero. First sighting (no prior current) only fills `current`.
        const now = Date.now();
        const slots = slotsRef.current;
        for (const s of result.data.snapshots) {
          const cur = slots.current.get(s.symbol);
          if (!cur) {
            slots.current.set(s.symbol, { price: s.price, ts: now });
            continue;
          }
          if (cur.price !== s.price) {
            slots.prev.set(s.symbol, cur);
            slots.current.set(s.symbol, { price: s.price, ts: now });
          } else {
            // Same price, just refresh the "ts" on current so the live
            // dot fade-out still considers it "recently observed".
            slots.current.set(s.symbol, { price: cur.price, ts: now });
          }
        }
        setSnapshots(result.data.snapshots);
      }
      // Silent on error — keep last frame, next poll retries.
    };

    pull();
    const id = setInterval(pull, POLL_INTERVAL_MS);
    return () => {
      mounted = false;
      clearInterval(id);
      ctrl?.abort();
    };
  }, [symbols]);

  // 1Hz re-render tick — drives the "live" dot fade-out without a
  // dedicated state update for every symbol every second.
  useEffect(() => {
    const id = setInterval(() => setNowTick(n => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (symbols.length === 0) return null;

  // Render in operator-input order — `requested` from the backend is
  // authoritative, but we work from the prop here to avoid lag on the
  // very first poll when snapshots[] hasn't arrived yet.
  const snapBySymbol = new Map<string, MarketTickSnapshot>();
  for (const s of snapshots) snapBySymbol.set(s.symbol, s);

  return (
    <section
      className="nx-panel"
      aria-label="KIS Live Snapshot"
      data-testid="kis-live-snapshot"
      style={PANEL}
    >
      <header className="nx-panel__head">
        <div className="nx-panel__title">
          <span className="nx-dot nx-dot--lime nx-dot--pulse" />
          <span>{t('hud.kis.header')}</span>
        </div>
        <span className="nx-mono-dim" style={{ fontSize: 9 }}>
          {symbols.length} SYMS · 2s
        </span>
      </header>

      <ul style={LIST}>
        {symbols.map(sym => {
          const snap   = snapBySymbol.get(sym);
          const entity = entityMap.get(sym);
          // Sprint 5s+ — prefer the securities-master display_name when
          // available; falls through to legacy `label`, then the raw
          // symbol code as the last resort.
          const label  = entity?.display_name ?? entity?.label ?? sym;
          const cur    = slotsRef.current.current.get(sym);
          const prev   = slotsRef.current.prev.get(sym);
          // Live = we've seen this symbol's price (or refreshed its ts)
          // within the window. cur.ts is updated on EVERY poll where the
          // backend returned this symbol, even when the price was flat.
          const live   = cur !== undefined
                       && (Date.now() - cur.ts) <= LIVE_WINDOW_MS;
          const pctDelta = (snap && prev && prev.price > 0)
            ? ((snap.price - prev.price) / prev.price) * 100
            : 0;
          const isSelected = sym === selectedId;

          return (
            <li
              key={sym}
              data-testid="kis-snapshot-row"
              style={{
                ...ROW,
                ...(isSelected ? ROW_SELECTED : null),
              }}
              role="button"
              tabIndex={0}
              onClick={() => onSelect?.(sym)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect?.(sym);
                }
              }}
            >
              <span style={dotStyle(live, pctDelta)} aria-hidden />
              <span style={SYM_TEXT}>{sym}</span>
              <span style={LABEL_TEXT} title={label}>{label}</span>
              <span style={PRICE_TEXT}>
                {snap ? formatPrice(snap.price) : '—'}
              </span>
              <span style={pctStyle(pctDelta)}>
                {snap && pctDelta !== 0
                  ? `${pctDelta > 0 ? '+' : ''}${pctDelta.toFixed(2)}%`
                  : '·'}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── helpers / styles ───────────────────────────────────────────────────

function formatPrice(p: number): string {
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (p >= 1)    return p.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return p.toFixed(4);
}

function dotStyle(live: boolean, pct: number): React.CSSProperties {
  // Live dot color: lime when ticking, low-grey when quiet. The %-delta
  // tints the LIVE state slightly (positive → lime, negative → amber)
  // so the operator picks up direction without reading numbers.
  const color = !live
    ? '#4A5066'
    : pct > 0.05  ? '#DEFF9A'
    : pct < -0.05 ? '#FFB200'
    :               '#00BFFF';
  return {
    width:        6,
    height:       6,
    borderRadius: '50%',
    background:   color,
    boxShadow:    live ? `0 0 6px ${color}` : 'none',
    flexShrink:   0,
  };
}

function pctStyle(pct: number): React.CSSProperties {
  const color = pct > 0.05  ? '#DEFF9A'
              : pct < -0.05 ? '#FFB200'
              :               '#4A5066';
  return {
    color,
    fontSize:     9,
    fontVariantNumeric: 'tabular-nums',
    minWidth:     52,
    textAlign:    'right',
  };
}

const PANEL: React.CSSProperties = {
  marginTop: 8,
};

const LIST: React.CSSProperties = {
  listStyle: 'none',
  margin:    0,
  padding:   '4px 12px 8px',
  display:   'flex',
  flexDirection: 'column',
  gap:       1,
};

const ROW: React.CSSProperties = {
  display:       'grid',
  gridTemplateColumns: '8px 56px 1fr auto auto',
  alignItems:    'center',
  gap:           8,
  padding:       '3px 6px',
  borderRadius:  2,
  fontFamily:    FONT_MONO,
  fontSize:      10,
  cursor:        'pointer',
  // Keeping idle bg transparent so the panel reads as one block; only
  // the selected row gets a tint to anchor the cross-reference with
  // PropertyHUD above.
  background:    'transparent',
  transition:    'background 0.15s ease',
};

const ROW_SELECTED: React.CSSProperties = {
  background: withAlpha(NEXUS_COLOR.cyan, 0.10),
};

const SYM_TEXT: React.CSSProperties = {
  color:         '#DEFF9A',
  fontWeight:    500,
  letterSpacing: '0.04em',
};

const LABEL_TEXT: React.CSSProperties = {
  color:         '#8A93A8',
  whiteSpace:    'nowrap',
  overflow:      'hidden',
  textOverflow:  'ellipsis',
};

const PRICE_TEXT: React.CSSProperties = {
  color:         '#E8ECF5',
  fontVariantNumeric: 'tabular-nums',
};
