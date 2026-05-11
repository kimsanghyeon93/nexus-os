// PriceSparkline tests — exercises the SVG render logic directly
// (volume bars, polyline geometry, trend tone) without going through
// useRecentTicks. The fetcher is tested in marketApi.test.ts; this
// file focuses on the rendering math.

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { PriceSparkline } from './PropertyHUD';
import type { MarketTick } from '../../types/api';

function tick(price: number, side: 'buy' | 'sell' = 'buy', volume = 100, sec = 0): MarketTick {
  const d = new Date(Date.UTC(2026, 4, 11, 0, 0, sec));
  return { ts: d.toISOString(), price, volume, side };
}

describe('PriceSparkline', () => {
  it('renders "acquiring tape" placeholder when fewer than 2 ticks', () => {
    const { container } = render(<PriceSparkline ticks={[]} tone="cyan" />);
    expect(container.textContent).toContain('acquiring tape');
  });

  it('renders one volume <rect> per tick + one price polyline', () => {
    const ticks = [tick(100, 'buy', 10), tick(102, 'sell', 20, 1), tick(101, 'buy', 30, 2)];
    const { container } = render(<PriceSparkline ticks={ticks} tone="cyan" />);
    const rects = container.querySelectorAll('svg rect');
    const polylines = container.querySelectorAll('svg polyline');
    expect(rects).toHaveLength(3);
    expect(polylines).toHaveLength(1);
  });

  it('volume bar fill follows side: buy → lime, sell → amber', () => {
    const ticks = [tick(100, 'buy', 10), tick(100, 'sell', 10, 1)];
    const { container } = render(<PriceSparkline ticks={ticks} tone="cyan" />);
    const rects = container.querySelectorAll('svg rect');
    expect(rects[0]!.getAttribute('fill')).toBe('#DEFF9A');   // buy lime
    expect(rects[1]!.getAttribute('fill')).toBe('#FFB200');   // sell amber
  });

  it('viewBox includes the volume band height (PRICE_H + GUTTER + VOL_H = 48)', () => {
    const ticks = [tick(100), tick(101, 'buy', 10, 1)];
    const { container } = render(<PriceSparkline ticks={ticks} tone="cyan" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 240 48');
  });

  it('renders +X% delta when last > first', () => {
    const ticks = [tick(100), tick(105, 'buy', 10, 1)];
    const { container } = render(<PriceSparkline ticks={ticks} tone="cyan" />);
    expect(container.textContent).toContain('+5.00%');
  });

  it('renders negative delta without a +sign when last < first', () => {
    const ticks = [tick(100), tick(98, 'sell', 10, 1)];
    const { container } = render(<PriceSparkline ticks={ticks} tone="cyan" />);
    expect(container.textContent).toContain('-2.00%');
  });

  it('formats KRW prices with thousands separators', () => {
    const ticks = [tick(79100), tick(79150, 'buy', 10, 1)];
    const { container } = render(<PriceSparkline ticks={ticks} tone="cyan" />);
    expect(container.textContent).toContain('79,150');
  });
});
