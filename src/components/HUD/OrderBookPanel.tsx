import type { Quote } from '../../types/api';
import { FONT_MONO } from '../../styles/fonts';

export interface OrderBookPanelProps {
  symbol: string | null;
  quote:  Quote | null;
}

export function OrderBookPanel({ symbol, quote }: OrderBookPanelProps) {
  return (
    <aside className="nx-panel nx-orderbook" aria-label="Order Book">
      <header className="nx-panel__head">
        <div className="nx-panel__title">
          <span className="nx-dot nx-dot--amber" />
          <span>ORDER BOOK</span>
        </div>
        {symbol && (
          <span className="nx-mono-dim" style={{ fontSize: 9, letterSpacing: '0.06em' }}>
            {symbol}
          </span>
        )}
        <span className="nx-panel__chev">▸</span>
      </header>

      {!symbol ? (
        <NoTarget />
      ) : !quote ? (
        <Acquiring />
      ) : (
        <BookLevels quote={quote} />
      )}
    </aside>
  );
}

function NoTarget() {
  return (
    <section className="nx-prop__empty">
      <div className="nx-label" style={{ color: 'var(--color-semantic-warning, #FFB200)' }}>
        NO TARGET LOCKED
      </div>
    </section>
  );
}

function Acquiring() {
  return (
    <section className="nx-prop__empty">
      <div className="nx-mono-dim" style={{ fontSize: 10 }}>— acquiring quote —</div>
    </section>
  );
}

function BookLevels({ quote }: { quote: Quote }) {
  const { bids, asks } = quote;

  // asks[0] = best ask; display order: worst ask at top, best ask just above spread
  const displayAsks = [...asks].reverse();

  // Compute spread from best bid/ask
  const bestAsk = asks[0]?.price ?? 0;
  const bestBid = bids[0]?.price ?? 0;
  const spread    = bestAsk - bestBid;
  const spreadPct = bestBid > 0 ? ((spread / bestBid) * 100).toFixed(2) : '—';

  // Max volume per side for bar scaling
  const maxAskVol = Math.max(1, ...asks.map(l => l.volume));
  const maxBidVol = Math.max(1, ...bids.map(l => l.volume));

  return (
    <section style={{ padding: '4px 0' }}>
      {/* ASK side — amber */}
      <div className="nx-label" style={{
        color: 'var(--color-semantic-warning, #FFB200)',
        padding: '0 10px 2px',
        fontSize: 8,
        letterSpacing: '0.08em',
      }}>
        ASK 매도
      </div>
      {displayAsks.map((lvl, i) => (
        <LevelRow
          key={`ask-${i}`}
          price={lvl.price}
          volume={lvl.volume}
          maxVolume={maxAskVol}
          side="ask"
        />
      ))}

      {/* Spread */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        padding: '3px 10px',
        gap: 6,
        borderTop: '0.8px dashed var(--fg-low, #4A5066)',
        borderBottom: '0.8px dashed var(--fg-low, #4A5066)',
      }}>
        <span className="nx-mono-dim" style={{ fontSize: 8, flex: 1 }}>
          spread
        </span>
        <span className="nx-mono-dim" style={{ fontSize: 9 }}>
          {spread.toLocaleString()} ({spreadPct}%)
        </span>
      </div>

      {/* BID side — lime */}
      {bids.map((lvl, i) => (
        <LevelRow
          key={`bid-${i}`}
          price={lvl.price}
          volume={lvl.volume}
          maxVolume={maxBidVol}
          side="bid"
        />
      ))}
      <div className="nx-label" style={{
        color: 'var(--color-semantic-success, #DEFF9A)',
        padding: '2px 10px 0',
        fontSize: 8,
        letterSpacing: '0.08em',
      }}>
        BID 매수
      </div>
    </section>
  );
}

interface LevelRowProps {
  price:     number;
  volume:    number;
  maxVolume: number;
  side:      'ask' | 'bid';
}

function LevelRow({ price, volume, maxVolume, side }: LevelRowProps) {
  const color = side === 'ask'
    ? 'var(--color-semantic-warning, #FFB200)'
    : 'var(--color-semantic-success, #DEFF9A)';
  const barFraction = volume / maxVolume;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      padding: '1px 10px',
      gap: 6,
      position: 'relative',
    }}>
      {/* Volume bar background */}
      <div style={{
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        width: `${Math.max(0, Math.min(1, barFraction)) * 100}%`,
        background: color,
        opacity: 0.08,
      }} />
      <span style={{
        fontFamily: FONT_MONO,
        fontSize: 10,
        color,
        flex: 1,
        position: 'relative',
      }}>
        {price.toLocaleString()}
      </span>
      <span className="nx-mono-dim" style={{
        fontSize: 9,
        position: 'relative',
        minWidth: 48,
        textAlign: 'right',
      }}>
        {volume.toLocaleString()}
      </span>
    </div>
  );
}
