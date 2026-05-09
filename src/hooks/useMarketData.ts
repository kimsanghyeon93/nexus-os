// useMarketData — hook that returns the NEXUS ontology + live telemetry.
//
// Today: builds a deterministic 80-node mock dataset. Live data comes from
// an injected IMarketStreamer (the harness MockStreamer in dev, the real
// WebSocket client in prod). When no streamer is provided, falls back to a
// purely synthetic telemetry tick — useful for screenshot/static modes.
//
// The returned `dataset` reference is stable across renders so RadarCanvas's
// force-sim does NOT rebuild on every incoming packet. Mutations are applied
// in-place; the canvas reads them via the SimNode.ref pointer each frame.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ApiTelemetry,
  ClusterColor,
  ClusterDef,
  NexusDataset,
  NexusEdge,
  NexusEntity,
  SsoSession,
} from '../types/nexus';
import type { ConnectionState, IMarketStreamer } from '../types/streamer';
import { computeDiff, type EntityDelta } from '../utils/diff';

export type EdgeDiffKind = 'new' | 'broken';

/* ------------------------------------------------------------------ */
/*  Dataset builder — deterministic                                    */
/* ------------------------------------------------------------------ */

function rng(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type MemberSeed = Pick<
  NexusEntity,
  'id' | 'label' | 'type' | 'jurisdiction' | 'anomaly' | 'sanctioned' | 'txVol'
> & { mark?: string; founded?: number | null };

function buildDataset(): NexusDataset {
  const CLUSTERS: ClusterDef[] = [
    { id: 'CB',     label: 'CENTRAL BANKS',      cx: 0.20, cy: 0.22, color: 'cyan',   mark: 'doubleRing' },
    { id: 'SOV',    label: 'SOVEREIGN BONDS',    cx: 0.50, cy: 0.18, color: 'cyan',   mark: 'diamond' },
    { id: 'EQ',     label: 'US EQUITY SECTORS',  cx: 0.78, cy: 0.28, color: 'cyan',   mark: 'hexagon' },
    { id: 'FX',     label: 'FX PAIRS',           cx: 0.18, cy: 0.55, color: 'purple', mark: 'star' },
    { id: 'COMM',   label: 'COMMODITIES',        cx: 0.50, cy: 0.55, color: 'amber',  mark: 'triangle' },
    { id: 'CRYPTO', label: 'DIGITAL ASSETS',     cx: 0.82, cy: 0.62, color: 'purple', mark: 'ringDot' },
    { id: 'MACRO',  label: 'MACRO INDICATORS',   cx: 0.34, cy: 0.82, color: 'cyan',   mark: 'cross' },
    { id: 'WATCH',  label: 'SANCTION / WATCH',   cx: 0.70, cy: 0.88, color: 'lime',   mark: 'hexagon', anomaly: true },
    { id: 'KRX',    label: 'KRX · KOSPI SECTORS',cx: 0.92, cy: 0.45, color: 'purple', mark: 'hexagon' },
    { id: 'MOMENTUM', label: 'MOMENTUM · US TICKERS', cx: 0.62, cy: 0.40, color: 'cyan', mark: 'hexagon' },
  ];

  const ENTITIES: NexusEntity[] = [];
  const TX: NexusEdge[] = [];

  const placeMembers = (cluster: ClusterDef, members: MemberSeed[], seed: number) => {
    const r = rng(seed);
    const N = members.length;
    members.forEach((m, i) => {
      const angle = (i / N) * Math.PI * 2 + r() * 0.4;
      const radius = 0.06 + r() * 0.05;
      const x = cluster.cx + Math.cos(angle) * radius;
      const y = cluster.cy + Math.sin(angle) * radius * 0.65;
      ENTITIES.push({
        ...m,
        founded: m.founded ?? null,
        cluster: cluster.id,
        clusterColor: cluster.color,
        x, y, baseX: x, baseY: y,
        orbitR: 0.005 + r() * 0.012,
        orbitSpeed: 0.05 + r() * 0.18,
        orbitPhase: r() * Math.PI * 2,
        mark: m.mark || cluster.mark,
        isHub: false,
      });
    });
  };

  // Hubs
  CLUSTERS.forEach(c => {
    ENTITIES.push({
      id: `HUB_${c.id}`, label: c.label, type: 'hub',
      cluster: c.id, clusterColor: c.color, mark: c.mark,
      x: c.cx, y: c.cy, baseX: c.cx, baseY: c.cy,
      orbitR: 0, orbitSpeed: 0, orbitPhase: 0,
      isHub: true, jurisdiction: 'GLOBAL', founded: null,
      anomaly: c.anomaly ? 0.82 : 0.04,
      sanctioned: false, txVol: 9999,
    });
  });

  placeMembers(CLUSTERS[0]!, [
    { id: 'FED',  label: 'US Federal Reserve',     type: 'central_bank', jurisdiction: 'US', founded: 1913, anomaly: 0.05, sanctioned: false, txVol: 8400 },
    { id: 'ECB',  label: 'European Central Bank',  type: 'central_bank', jurisdiction: 'EU', founded: 1998, anomaly: 0.07, sanctioned: false, txVol: 6100 },
    { id: 'BOJ',  label: 'Bank of Japan',          type: 'central_bank', jurisdiction: 'JP', founded: 1882, anomaly: 0.12, sanctioned: false, txVol: 3700 },
    { id: 'BOE',  label: 'Bank of England',        type: 'central_bank', jurisdiction: 'GB', founded: 1694, anomaly: 0.08, sanctioned: false, txVol: 2200 },
    { id: 'PBOC', label: 'People\u2019s Bank of China', type: 'central_bank', jurisdiction: 'CN', founded: 1948, anomaly: 0.31, sanctioned: false, txVol: 7800 },
    { id: 'SNB',  label: 'Swiss National Bank',    type: 'central_bank', jurisdiction: 'CH', founded: 1907, anomaly: 0.09, sanctioned: false, txVol: 1400 },
    { id: 'RBI',  label: 'Reserve Bank of India',  type: 'central_bank', jurisdiction: 'IN', founded: 1935, anomaly: 0.18, sanctioned: false, txVol: 1900 },
  ], 1);

  placeMembers(CLUSTERS[1]!, [
    { id: 'UST10', label: 'US 10Y Treasury',  type: 'bond', jurisdiction: 'US', anomaly: 0.22, sanctioned: false, txVol: 5800 },
    { id: 'UST2',  label: 'US 2Y Treasury',   type: 'bond', jurisdiction: 'US', anomaly: 0.41, sanctioned: false, txVol: 4200 },
    { id: 'BUND',  label: 'German Bund 10Y',  type: 'bond', jurisdiction: 'DE', anomaly: 0.14, sanctioned: false, txVol: 2900 },
    { id: 'JGB',   label: 'JGB 10Y',          type: 'bond', jurisdiction: 'JP', anomaly: 0.36, sanctioned: false, txVol: 2100 },
    { id: 'GILT',  label: 'UK Gilt 10Y',      type: 'bond', jurisdiction: 'GB', anomaly: 0.19, sanctioned: false, txVol: 1300 },
    { id: 'BTP',   label: 'Italian BTP 10Y',  type: 'bond', jurisdiction: 'IT', anomaly: 0.58, sanctioned: false, txVol:  890 },
    { id: 'OAT',   label: 'French OAT 10Y',   type: 'bond', jurisdiction: 'FR', anomaly: 0.24, sanctioned: false, txVol: 1100 },
  ], 2);

  placeMembers(CLUSTERS[2]!, [
    { id: 'XLK',  label: 'Tech Sector',         type: 'equity_sector', jurisdiction: 'US', anomaly: 0.31, sanctioned: false, txVol: 4400 },
    { id: 'XLF',  label: 'Financials Sector',   type: 'equity_sector', jurisdiction: 'US', anomaly: 0.27, sanctioned: false, txVol: 3700 },
    { id: 'XLE',  label: 'Energy Sector',       type: 'equity_sector', jurisdiction: 'US', anomaly: 0.62, sanctioned: false, txVol: 2900 },
    { id: 'XLV',  label: 'Healthcare Sector',   type: 'equity_sector', jurisdiction: 'US', anomaly: 0.18, sanctioned: false, txVol: 2400 },
    { id: 'XLI',  label: 'Industrials',         type: 'equity_sector', jurisdiction: 'US', anomaly: 0.21, sanctioned: false, txVol: 1800 },
    { id: 'XLU',  label: 'Utilities',           type: 'equity_sector', jurisdiction: 'US', anomaly: 0.09, sanctioned: false, txVol:  920 },
    { id: 'XLY',  label: 'Cons. Discretionary', type: 'equity_sector', jurisdiction: 'US', anomaly: 0.34, sanctioned: false, txVol: 1600 },
    { id: 'XLRE', label: 'Real Estate',         type: 'equity_sector', jurisdiction: 'US', anomaly: 0.71, sanctioned: false, txVol: 1100 },
    { id: 'SMH',  label: 'Semiconductors',      type: 'equity_sector', jurisdiction: 'US', anomaly: 0.78, sanctioned: false, txVol: 3300 },
  ], 3);

  placeMembers(CLUSTERS[3]!, [
    { id: 'EURUSD', label: 'EUR / USD', type: 'fx', jurisdiction: '—', anomaly: 0.18, sanctioned: false, txVol: 5400 },
    { id: 'USDJPY', label: 'USD / JPY', type: 'fx', jurisdiction: '—', anomaly: 0.66, sanctioned: false, txVol: 4100 },
    { id: 'GBPUSD', label: 'GBP / USD', type: 'fx', jurisdiction: '—', anomaly: 0.22, sanctioned: false, txVol: 2300 },
    { id: 'USDCNH', label: 'USD / CNH', type: 'fx', jurisdiction: '—', anomaly: 0.74, sanctioned: false, txVol: 2900 },
    { id: 'USDCHF', label: 'USD / CHF', type: 'fx', jurisdiction: '—', anomaly: 0.14, sanctioned: false, txVol: 1100 },
    { id: 'AUDUSD', label: 'AUD / USD', type: 'fx', jurisdiction: '—', anomaly: 0.27, sanctioned: false, txVol:  980 },
    { id: 'USDTRY', label: 'USD / TRY', type: 'fx', jurisdiction: '—', anomaly: 0.92, sanctioned: false, txVol:  680 },
  ], 4);

  placeMembers(CLUSTERS[4]!, [
    { id: 'WTI',   label: 'WTI Crude',   type: 'commodity', jurisdiction: '—', anomaly: 0.69, sanctioned: false, txVol: 3100 },
    { id: 'BRT',   label: 'Brent Crude', type: 'commodity', jurisdiction: '—', anomaly: 0.61, sanctioned: false, txVol: 2700 },
    { id: 'XAU',   label: 'Gold',        type: 'commodity', jurisdiction: '—', anomaly: 0.34, sanctioned: false, txVol: 4800 },
    { id: 'XAG',   label: 'Silver',      type: 'commodity', jurisdiction: '—', anomaly: 0.41, sanctioned: false, txVol: 1400 },
    { id: 'CU',    label: 'Copper',      type: 'commodity', jurisdiction: '—', anomaly: 0.52, sanctioned: false, txVol: 1900 },
    { id: 'NG',    label: 'Nat Gas',     type: 'commodity', jurisdiction: '—', anomaly: 0.84, sanctioned: false, txVol: 1500 },
    { id: 'WHEAT', label: 'Wheat',       type: 'commodity', jurisdiction: '—', anomaly: 0.46, sanctioned: false, txVol:  610 },
  ], 5);

  placeMembers(CLUSTERS[5]!, [
    { id: 'BTC',      label: 'Bitcoin',         type: 'crypto',   jurisdiction: '—',  anomaly: 0.54, sanctioned: false, txVol: 4200 },
    { id: 'ETH',      label: 'Ether',           type: 'crypto',   jurisdiction: '—',  anomaly: 0.48, sanctioned: false, txVol: 3100 },
    { id: 'USDT',     label: 'Tether',          type: 'crypto',   jurisdiction: 'AE', anomaly: 0.71, sanctioned: false, txVol: 5800 },
    { id: 'USDC',     label: 'USD Coin',        type: 'crypto',   jurisdiction: 'US', anomaly: 0.18, sanctioned: false, txVol: 2400 },
    { id: 'WALLET_X', label: 'Wallet 0x9F3A\u2026', type: 'wallet', jurisdiction: '—', anomaly: 0.95, sanctioned: false, txVol: 320 },
    { id: 'TORNADO',  label: 'Tornado Cash',    type: 'mixer',    jurisdiction: '—',  anomaly: 0.97, sanctioned: true,  txVol: 410 },
    { id: 'CYGNUS',   label: 'Cygnus Exchange', type: 'exchange', jurisdiction: 'SG', anomaly: 0.21, sanctioned: false, txVol: 2240 },
  ], 6);

  placeMembers(CLUSTERS[6]!, [
    { id: 'CPI_US',  label: 'US CPI YoY',          type: 'macro', jurisdiction: 'US', anomaly: 0.61, sanctioned: false, txVol: 3200 },
    { id: 'NFP',     label: 'Nonfarm Payrolls',    type: 'macro', jurisdiction: 'US', anomaly: 0.34, sanctioned: false, txVol: 2100 },
    { id: 'PMI_US',  label: 'US ISM PMI',          type: 'macro', jurisdiction: 'US', anomaly: 0.42, sanctioned: false, txVol: 1100 },
    { id: 'GDP_US',  label: 'US GDP',              type: 'macro', jurisdiction: 'US', anomaly: 0.18, sanctioned: false, txVol: 1900 },
    { id: 'CPI_EU',  label: 'EU HICP',             type: 'macro', jurisdiction: 'EU', anomaly: 0.48, sanctioned: false, txVol: 1400 },
    { id: 'OIL_INV', label: 'EIA Crude Inventory', type: 'macro', jurisdiction: 'US', anomaly: 0.55, sanctioned: false, txVol:  780 },
    { id: 'VIX',     label: 'VIX',                 type: 'macro', jurisdiction: '—',  anomaly: 0.79, sanctioned: false, txVol: 2400 },
    { id: 'DXY',     label: 'DXY (USD Index)',     type: 'macro', jurisdiction: '—',  anomaly: 0.36, sanctioned: false, txVol: 3300 },
  ], 7);

  placeMembers(CLUSTERS[7]!, [
    { id: 'BAKU_TR', label: 'Baku Transit LLC',  type: 'corporation', jurisdiction: 'AZ',  anomaly: 0.88, sanctioned: true,  txVol: 410 },
    { id: 'OBSIDIAN',label: 'Obsidian Holdings', type: 'holding',     jurisdiction: 'KY',  anomaly: 0.91, sanctioned: false, txVol: 980 },
    { id: 'NORDSEE', label: 'NordSee Treuhand',  type: 'bank',        jurisdiction: 'CH',  anomaly: 0.74, sanctioned: false, txVol: 1610 },
    { id: 'HELIX',   label: 'Helix Industries',  type: 'corporation', jurisdiction: 'US',  anomaly: 0.84, sanctioned: false, txVol: 1840 },
    { id: 'SAFFRON', label: 'Saffron Capital',   type: 'corporation', jurisdiction: 'AE',  anomaly: 0.78, sanctioned: false, txVol: 720  },
    { id: 'TIDE_FX', label: 'Tidewater FX',      type: 'exchange',    jurisdiction: 'BVI', anomaly: 0.81, sanctioned: false, txVol: 460  },
  ], 8);

  // Hub-to-member intra-cluster ties
  CLUSTERS.forEach(c => {
    ENTITIES.filter(e => e.cluster === c.id && !e.isHub).forEach(m => {
      TX.push({
        from: `HUB_${c.id}`, to: m.id,
        usd: 5_000_000 + Math.random() * 60_000_000,
        n: 4 + ((Math.random() * 18) | 0),
        anomaly: m.anomaly * 0.7, kind: 'cluster',
      });
    });
  });

  const interLinks: [string, string, number][] = [
    ['FED','UST10',0.18], ['FED','UST2',0.42], ['ECB','BUND',0.16], ['BOJ','JGB',0.38], ['BOE','GILT',0.21],
    ['ECB','BTP',0.55], ['ECB','OAT',0.22],
    ['FED','EURUSD',0.31], ['FED','USDJPY',0.62], ['ECB','EURUSD',0.28], ['BOJ','USDJPY',0.71],
    ['PBOC','USDCNH',0.74], ['SNB','USDCHF',0.18],
    ['FED','DXY',0.45], ['ECB','DXY',0.32],
    ['UST10','XLF',0.41], ['UST10','XLU',0.34], ['UST10','XLRE',0.74], ['UST2','XLK',0.39],
    ['UST2','SMH',0.62],
    ['XLE','WTI',0.66], ['XLE','BRT',0.63], ['XLE','NG',0.78],
    ['XAU','DXY',0.41], ['WTI','DXY',0.55], ['CU','AUDUSD',0.36],
    ['BTC','XAU',0.42], ['ETH','BTC',0.55], ['USDT','CYGNUS',0.78],
    ['CYGNUS','USDC',0.31], ['CYGNUS','BTC',0.48],
    ['CPI_US','UST10',0.71], ['CPI_US','FED',0.81], ['NFP','FED',0.62], ['NFP','UST2',0.51],
    ['PMI_US','XLI',0.55], ['VIX','XLK',0.61], ['VIX','SMH',0.74],
    ['DXY','EURUSD',0.84], ['DXY','XAU',0.42],
    ['OIL_INV','WTI',0.85], ['CPI_EU','BUND',0.55], ['GDP_US','XLY',0.41],
    ['BAKU_TR','WALLET_X',0.92], ['WALLET_X','TORNADO',0.96], ['TORNADO','USDT',0.94],
    ['HELIX','OBSIDIAN',0.88], ['OBSIDIAN','SAFFRON',0.79], ['SAFFRON','BAKU_TR',0.71],
    ['NORDSEE','OBSIDIAN',0.61], ['NORDSEE','HELIX',0.44], ['TIDE_FX','WALLET_X',0.92],
    ['HELIX','XLK',0.42], ['SAFFRON','USDT',0.81],
    ['NG','BAKU_TR',0.81], ['WTI','BAKU_TR',0.74],
  ];
  interLinks.forEach(([from, to, anomaly]) => {
    TX.push({
      from, to,
      usd: 1_000_000 + Math.random() * 80_000_000,
      n: 3 + ((Math.random() * 24) | 0),
      anomaly, kind: 'inter',
    });
  });

  // KRX cluster
  placeMembers(CLUSTERS[8]!, [
    { id: 'KRX_SEMI', label: 'KRX Semiconductors', type: 'equity_sector', jurisdiction: 'KR', anomaly: 0.74, sanctioned: false, txVol: 3900 },
    { id: 'KRX_BATT', label: 'KRX Battery / EV',   type: 'equity_sector', jurisdiction: 'KR', anomaly: 0.62, sanctioned: false, txVol: 2100 },
    { id: 'KRX_AUTO', label: 'KRX Automotive',     type: 'equity_sector', jurisdiction: 'KR', anomaly: 0.34, sanctioned: false, txVol: 1700 },
    { id: 'KRX_FIN',  label: 'KRX Financials',     type: 'equity_sector', jurisdiction: 'KR', anomaly: 0.21, sanctioned: false, txVol: 1900 },
    { id: 'KRX_BIO',  label: 'KRX Biotech',        type: 'equity_sector', jurisdiction: 'KR', anomaly: 0.48, sanctioned: false, txVol:  920 },
    { id: 'KRX_SHIP', label: 'KRX Shipbuilding',   type: 'equity_sector', jurisdiction: 'KR', anomaly: 0.58, sanctioned: false, txVol:  640 },
    { id: 'BOK',      label: 'Bank of Korea',      type: 'central_bank',  jurisdiction: 'KR', anomaly: 0.18, sanctioned: false, txVol: 2400 },
    { id: 'KTB10',    label: 'KTB 10Y',            type: 'bond',          jurisdiction: 'KR', anomaly: 0.31, sanctioned: false, txVol: 1100 },
    { id: 'USDKRW',   label: 'USD / KRW',          type: 'fx',            jurisdiction: '—',  anomaly: 0.66, sanctioned: false, txVol: 2200 },
    { id: 'KOSPI',    label: 'KOSPI Index',        type: 'macro',         jurisdiction: 'KR', anomaly: 0.42, sanctioned: false, txVol: 3800 },
  ], 9);

  const krxLinks: [string, string, number][] = [
    ['BOK','USDKRW',0.61], ['BOK','KTB10',0.34], ['BOK','KOSPI',0.41], ['BOK','HUB_CB',0.38],
    ['USDKRW','DXY',0.58], ['USDKRW','USDJPY',0.62], ['USDKRW','USDCNH',0.54],
    ['KOSPI','SMH',0.81], ['KOSPI','XLK',0.62], ['KOSPI','VIX',0.51],
    ['KRX_SEMI','SMH',0.88], ['KRX_SEMI','XLK',0.71], ['KRX_SEMI','KOSPI',0.92],
    ['KRX_BATT','CU',0.66], ['KRX_BATT','XLY',0.41],
    ['KRX_AUTO','XLY',0.42], ['KRX_AUTO','USDKRW',0.51],
    ['KRX_SHIP','BRT',0.55], ['KRX_SHIP','WTI',0.48],
    ['KRX_FIN','UST10',0.34], ['KRX_FIN','XLF',0.41], ['KRX_FIN','KTB10',0.62],
    ['KRX_BIO','XLV',0.55],
    ['KTB10','UST10',0.51], ['KTB10','BUND',0.31],
    ['HELIX','KRX_SEMI',0.71], ['SAFFRON','KRX_BATT',0.62],
  ];
  krxLinks.forEach(([from, to, anomaly]) => {
    TX.push({
      from, to,
      usd: 1_000_000 + Math.random() * 60_000_000,
      n: 3 + ((Math.random() * 18) | 0),
      anomaly, kind: 'inter',
    });
  });

  // MOMENTUM cluster — Momentum app's US ticker universe as first-class nodes.
  // Mutated in real-time by MomentumStreamer instead of routing through sector
  // aggregations. Each ticker is connected to its primary US sector entity so
  // the cascading wave from a Momentum shock still reaches the broader graph.
  placeMembers(CLUSTERS[9]!, [
    { id: 'AAPL',  label: 'Apple Inc.',          type: 'us_equity', jurisdiction: 'US', anomaly: 0.18, sanctioned: false, txVol: 2800 },
    { id: 'MSFT',  label: 'Microsoft Corp.',     type: 'us_equity', jurisdiction: 'US', anomaly: 0.16, sanctioned: false, txVol: 2750 },
    { id: 'NVDA',  label: 'NVIDIA Corp.',        type: 'us_equity', jurisdiction: 'US', anomaly: 0.42, sanctioned: false, txVol: 1200 },
    { id: 'AVGO',  label: 'Broadcom Inc.',       type: 'us_equity', jurisdiction: 'US', anomaly: 0.24, sanctioned: false, txVol:  600 },
    { id: 'CRM',   label: 'Salesforce, Inc.',    type: 'us_equity', jurisdiction: 'US', anomaly: 0.21, sanctioned: false, txVol:  300 },
    { id: 'AMD',   label: 'Adv Micro Devices',   type: 'us_equity', jurisdiction: 'US', anomaly: 0.36, sanctioned: false, txVol:  280 },
    { id: 'INTC',  label: 'Intel Corporation',   type: 'us_equity', jurisdiction: 'US', anomaly: 0.28, sanctioned: false, txVol:  180 },
    { id: 'ORCL',  label: 'Oracle Corporation',  type: 'us_equity', jurisdiction: 'US', anomaly: 0.18, sanctioned: false, txVol:  340 },
    { id: 'GOOGL', label: 'Alphabet Inc. (A)',   type: 'us_equity', jurisdiction: 'US', anomaly: 0.22, sanctioned: false, txVol: 1700 },
    { id: 'META',  label: 'Meta Platforms',      type: 'us_equity', jurisdiction: 'US', anomaly: 0.31, sanctioned: false, txVol:  900 },
    { id: 'NFLX',  label: 'Netflix, Inc.',       type: 'us_equity', jurisdiction: 'US', anomaly: 0.34, sanctioned: false, txVol:  250 },
    { id: 'DIS',   label: 'Walt Disney Co.',     type: 'us_equity', jurisdiction: 'US', anomaly: 0.19, sanctioned: false, txVol:  160 },
    { id: 'AMZN',  label: 'Amazon.com',          type: 'us_equity', jurisdiction: 'US', anomaly: 0.26, sanctioned: false, txVol: 1500 },
    { id: 'TSLA',  label: 'Tesla, Inc.',         type: 'us_equity', jurisdiction: 'US', anomaly: 0.58, sanctioned: false, txVol:  800 },
    { id: 'HD',    label: 'The Home Depot',      type: 'us_equity', jurisdiction: 'US', anomaly: 0.14, sanctioned: false, txVol:  350 },
    { id: 'MCD',   label: "McDonald's Corp.",    type: 'us_equity', jurisdiction: 'US', anomaly: 0.11, sanctioned: false, txVol:  210 },
    { id: 'NKE',   label: 'NIKE, Inc.',          type: 'us_equity', jurisdiction: 'US', anomaly: 0.21, sanctioned: false, txVol:  160 },
    { id: 'LLY',   label: 'Eli Lilly and Co.',   type: 'us_equity', jurisdiction: 'US', anomaly: 0.41, sanctioned: false, txVol:  590 },
    { id: 'JNJ',   label: 'Johnson & Johnson',   type: 'us_equity', jurisdiction: 'US', anomaly: 0.13, sanctioned: false, txVol:  380 },
    { id: 'UNH',   label: 'UnitedHealth Group',  type: 'us_equity', jurisdiction: 'US', anomaly: 0.18, sanctioned: false, txVol:  480 },
    { id: 'MRK',   label: 'Merck & Co.',         type: 'us_equity', jurisdiction: 'US', anomaly: 0.15, sanctioned: false, txVol:  280 },
    { id: 'PFE',   label: 'Pfizer Inc.',         type: 'us_equity', jurisdiction: 'US', anomaly: 0.32, sanctioned: false, txVol:  150 },
    { id: 'JPM',   label: 'JPMorgan Chase',      type: 'us_equity', jurisdiction: 'US', anomaly: 0.16, sanctioned: false, txVol:  490 },
    { id: 'V',     label: 'Visa Inc.',           type: 'us_equity', jurisdiction: 'US', anomaly: 0.14, sanctioned: false, txVol:  520 },
    { id: 'MA',    label: 'Mastercard Inc.',     type: 'us_equity', jurisdiction: 'US', anomaly: 0.13, sanctioned: false, txVol:  400 },
    { id: 'BAC',   label: 'Bank of America',     type: 'us_equity', jurisdiction: 'US', anomaly: 0.19, sanctioned: false, txVol:  260 },
    { id: 'XOM',   label: 'Exxon Mobil Corp.',   type: 'us_equity', jurisdiction: 'US', anomaly: 0.42, sanctioned: false, txVol:  420 },
    { id: 'CVX',   label: 'Chevron Corp.',       type: 'us_equity', jurisdiction: 'US', anomaly: 0.39, sanctioned: false, txVol:  290 },
  ], 10);

  // Each Momentum stock → its primary US sector ETF.
  // Anomaly intensities are intrinsic risk priors; the live MomentumStreamer
  // will dynamically override entity-level anomaly via mutations.
  const momentumLinks: [string, string, number][] = [
    // Tech (XLK)
    ['AAPL','XLK',0.42], ['MSFT','XLK',0.45], ['ORCL','XLK',0.31], ['CRM','XLK',0.34],
    ['GOOGL','XLK',0.41], ['META','XLK',0.38], ['NFLX','XLK',0.28], ['AVGO','XLK',0.36],
    // Semiconductors (SMH)
    ['NVDA','SMH',0.74], ['AMD','SMH',0.62], ['INTC','SMH',0.31],
    // Cross-listing: NVDA also touches XLK
    ['NVDA','XLK',0.55],
    // Consumer Discretionary (XLY)
    ['AMZN','XLY',0.51], ['TSLA','XLY',0.68], ['HD','XLY',0.32], ['MCD','XLY',0.21],
    ['NKE','XLY',0.28], ['DIS','XLY',0.24],
    // Healthcare (XLV)
    ['LLY','XLV',0.55], ['JNJ','XLV',0.31], ['UNH','XLV',0.34], ['MRK','XLV',0.27], ['PFE','XLV',0.41],
    // Finance (XLF)
    ['JPM','XLF',0.42], ['V','XLF',0.36], ['MA','XLF',0.34], ['BAC','XLF',0.39],
    // Energy (XLE)
    ['XOM','XLE',0.58], ['CVX','XLE',0.54],
    // KRX cross-correlations — the ones already in the ontology
    ['NVDA','KRX_SEMI',0.71], ['AMD','KRX_SEMI',0.55],
  ];
  momentumLinks.forEach(([from, to, anomaly]) => {
    TX.push({
      from, to,
      usd: 800_000 + Math.random() * 40_000_000,
      n: 3 + ((Math.random() * 16) | 0),
      anomaly, kind: 'inter',
    });
  });

  // Degree — Record<string, number | undefined> after noUncheckedIndexedAccess.
  // Keys are seeded from ENTITIES, so for any well-formed t.from/t.to in TX
  // the lookup IS defined; we narrow into a local before mutating.
  const degree: Record<string, number> = Object.fromEntries(ENTITIES.map(e => [e.id, 0]));
  TX.forEach(t => {
    const dFrom = degree[t.from]; if (dFrom !== undefined) degree[t.from] = dFrom + 1;
    const dTo   = degree[t.to];   if (dTo   !== undefined) degree[t.to]   = dTo   + 1;
  });

  // Eigenvector centrality (power iter on weighted adj). Indices into the
  // square Float64Array matrix `A` are bounded by N; the `!` assertions below
  // capture the loop-invariant safety that strict typed-array indexing can't
  // see. Rewriting as named locals would dominate the hot path's allocation cost.
  const idx: Record<string, number> = Object.fromEntries(ENTITIES.map((e, i) => [e.id, i]));
  const N = ENTITIES.length;
  const A: Float64Array[] = Array.from({ length: N }, () => new Float64Array(N));
  TX.forEach(t => {
    const fi = idx[t.from]; const ti = idx[t.to];
    if (fi === undefined || ti === undefined) return;
    const w = Math.log10(t.usd);
    const rowF = A[fi]!; rowF[ti] = (rowF[ti] ?? 0) + w;
    const rowT = A[ti]!; rowT[fi] = (rowT[fi] ?? 0) + w;
  });
  let v = new Float64Array(N).fill(1 / Math.sqrt(N));
  for (let it = 0; it < 60; it++) {
    const nv = new Float64Array(N);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) nv[i]! += A[i]![j]! * v[j]!;
    let norm = 0; for (let i = 0; i < N; i++) norm += nv[i]! * nv[i]!;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < N; i++) nv[i]! /= norm;
    v = nv;
  }
  ENTITIES.forEach((e, i) => {
    e.degree = degree[e.id] ?? 0;
    e.eigen  = +v[i]!.toFixed(4);
  });

  return { ENTITIES, TX, CLUSTERS };
}

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

/** Nonce-bearing shock signal — a fresh object identity per shock so that
 *  consecutive shocks on the same target still trigger downstream effects. */
export interface ShockSignal {
  id: string;
  nonce: number;
}

export interface UseMarketDataResult {
  dataset: NexusDataset;
  telemetry: ApiTelemetry;
  sso: SsoSession;
  /** Most recent injected anomaly shock, or null. App should promote this to
   *  selectedId so the existing 4-hop BFS wave fires. */
  shockTarget: ShockSignal | null;
  /** Current transport connection state — drives the TopBar status pill.
   *  When `isReplaying` is true, this resolves to 'replay' regardless of
   *  the underlying streamer's own state. */
  connectionState: ConnectionState;
  /** True when a dropped snapshot has frozen the live feed (replay or diff). */
  isReplaying: boolean;
  /** True specifically when comparing live vs a dropped snapshot. Implies
   *  isReplaying — diff is a flavour of the same "frozen feed" gate. */
  isDiffing: boolean;
  /** Per-entity delta map present only during diff mode. Consumers (canvas,
   *  PropertyHUD) override their visuals when an entry exists for an id. */
  diffMap: ReadonlyMap<string, EntityDelta> | null;
  /** Per-edge diff classification — `${from}->${to}` → 'new' | 'broken'.
   *  RadarCanvas reads this in its edge loop to apply dashed strokes. */
  diffEdgeMap: ReadonlyMap<string, EdgeDiffKind> | null;
  /** Swap the active dataset to a dropped snapshot and pause the streamer. */
  replayDataset: (next: NexusDataset) => void;
  /** Compare the dropped snapshot against live without swapping the dataset.
   *  Encodes per-entity deltas into the live dataset's clusterColor so the
   *  canvas reads "up = amber / down = cyan" without any extra plumbing. */
  diffSnapshot: (next: NexusDataset) => void;
  /** Exit replay/diff: restore the live dataset and re-subscribe the streamer. */
  resumeLive: () => void;
}

export function useMarketData(streamer?: IMarketStreamer): UseMarketDataResult {
  // Built once per mount and pinned via ref so harness packet mutations
  // (which mutate ENTITIES in-place) do not change the dataset reference and
  // therefore do not retrigger RadarCanvas's `[entities]` sim-rebuild effect.
  const liveDatasetRef = useRef<NexusDataset | null>(null);
  if (liveDatasetRef.current === null) liveDatasetRef.current = buildDataset();
  const liveDataset = liveDatasetRef.current;

  // The dataset surfaced to the UI. Live mode = liveDatasetRef (stable id);
  // replay mode = the dropped dataset (new identity → RadarCanvas rebuilds
  // the sim, which is the desired "scene change" effect for replay).
  const [activeDataset, setActiveDataset] = useState<NexusDataset>(liveDataset);
  const [isReplaying, setIsReplaying] = useState(false);

  // Live API telemetry — driven either by the injected streamer's onTelemetry
  // tick (4Hz) or, when no streamer is wired, a legacy synthetic interval.
  const [telemetry, setTelemetry] = useState<ApiTelemetry>({
    pkts: [], latencyMs: 24, pktRate: 0,
    feed: 'market-pkg/v4', status: 'live',
  });

  const shockNonceRef = useRef(0);
  const [shockTarget, setShockTarget] = useState<ShockSignal | null>(null);
  const [streamerState, setStreamerState] = useState<ConnectionState>(
    streamer?.connectionState ?? 'connected',
  );
  // Replay overrides the streamer's own state machine — operators see
  // 'replay' on the pill until they resume live (via source toggle).
  const connectionState: ConnectionState = isReplaying ? 'replay' : streamerState;

  // Toggling the source rebuilds the streamer; when that happens we want to
  // automatically resume live (drop any active replay) and reattach to the
  // live dataset. This effect runs ONLY on streamer-identity change.
  useEffect(() => {
    setIsReplaying(false);
    setActiveDataset(liveDataset);
  }, [streamer, liveDataset]);

  useEffect(() => {
    if (streamer) {
      const offPacket = streamer.onPacket(p => {
        // Replay freezes the live feed — drop any in-flight packets so they
        // can't corrupt the dropped snapshot's entity refs.
        if (isReplaying) return;
        // Apply mutations in-place against the live dataset. Linear scan is
        // fine at <=120pkt/s with ~80 entities — the harness stress-test point.
        for (const m of p.mutations) {
          const ent = liveDataset.ENTITIES.find(e => e.id === m.entityId);
          if (!ent) continue;
          if (m.txVolDelta != null) {
            ent.txVol = Math.max(0, ent.txVol + m.txVolDelta);
          }
          if (m.anomaly != null) ent.anomaly = m.anomaly;
        }
      });

      const offTelemetry = streamer.onTelemetry(t => {
        setTelemetry(prev => {
          const next = [...prev.pkts, t.pktRate];
          const trimmed = next.length > 24 ? next.slice(-24) : next;
          return {
            ...prev,
            pkts: trimmed,
            pktRate: t.pktRate,
            latencyMs: t.latencyMs,
          };
        });
      });

      const offAnomaly = streamer.onAnomaly(({ targetId }) => {
        shockNonceRef.current += 1;
        // Fresh object identity per shock; ShockSignal nonce makes consecutive
        // shocks on the same target distinguishable to React deps.
        setShockTarget({ id: targetId, nonce: shockNonceRef.current });
      });

      // Sync the local mirror to the streamer's current state at subscribe time
      // (start() may have already fired before our effect ran), then track live.
      setStreamerState(streamer.connectionState);
      const offConn = streamer.onConnectionStateChange(setStreamerState);

      return () => {
        offPacket();
        offTelemetry();
        offAnomaly();
        offConn();
      };
    }
    // No streamer → legacy synthetic mode is always "connected" conceptually.
    setStreamerState('connected');

    // Legacy synthetic mode — preserved for environments that don't wire a streamer.
    const id = setInterval(() => {
      setTelemetry(prev => {
        const sample = 40 + Math.random() * 80 + (Math.random() < 0.1 ? 60 : 0);
        const next = [...prev.pkts, sample];
        const trimmed = next.length > 24 ? next.slice(-24) : next;
        return {
          ...prev,
          pkts: trimmed,
          pktRate: Math.round(sample),
          latencyMs: 18 + Math.random() * 14,
        };
      });
    }, 350);
    return () => clearInterval(id);
  }, [streamer, liveDataset, isReplaying]);

  // SSO — static for now; in production read from `/auth/session`
  const sso: SsoSession = useMemo(
    () => ({ protocol: 'SAML 2.0', verified: true, expiresIn: '04:12:38' }),
    [],
  );

  // Diff mode state — when active, we hold both per-entity deltas (driving
  // PropertyHUD + canvas node colors) AND per-edge classification (driving
  // canvas dashed lines). Originals stashed so resumeLive restores byte-for-
  // byte: entity anomaly/clusterColor PLUS the original TX array reference.
  const [diffMap,     setDiffMap]     = useState<Map<string, EntityDelta>      | null>(null);
  const [diffEdgeMap, setDiffEdgeMap] = useState<Map<string, EdgeDiffKind>     | null>(null);
  const diffOriginalsRef = useRef<{
    anomaly:      Map<string, number>;
    clusterColor: Map<string, ClusterColor>;
    txArray:      NexusEdge[];
  } | null>(null);

  const restoreDiffOriginals = useCallback(() => {
    const orig = diffOriginalsRef.current;
    if (!orig) return;
    for (const e of liveDataset.ENTITIES) {
      const a = orig.anomaly.get(e.id);
      const c = orig.clusterColor.get(e.id);
      if (a !== undefined) e.anomaly = a;
      if (c !== undefined) e.clusterColor = c;
    }
    // Restore the original TX array reference. The diff path REPLACED .TX
    // with a new array (live + injected broken edges); the truth is the ref
    // we stashed at entry. Simple reference swap, no data movement.
    liveDataset.TX = orig.txArray;
    diffOriginalsRef.current = null;
  }, [liveDataset]);

  const replayDataset = useCallback((next: NexusDataset) => {
    // Entering replay from diff: restore the live dataset first.
    restoreDiffOriginals();
    setDiffMap(null);
    setDiffEdgeMap(null);
    // Pause the live transport so its packets don't overwrite the replay.
    // The streamer's own state machine transitions to 'disconnected'; the
    // hook's connectionState ignores that and reports 'replay' instead.
    streamer?.stop();
    setActiveDataset(next);
    setIsReplaying(true);
  }, [streamer, restoreDiffOriginals]);

  const diffSnapshot = useCallback((next: NexusDataset) => {
    // If we're already diffing a previous snapshot, undo that first so the
    // mutation we apply below is computed against a clean live baseline.
    restoreDiffOriginals();

    streamer?.stop();
    const result = computeDiff(liveDataset, next);

    // Snapshot pre-diff state — entity attrs + the original TX reference.
    const origAnomaly = new Map<string, number>();
    const origColor   = new Map<string, ClusterColor>();
    for (const e of liveDataset.ENTITIES) {
      origAnomaly.set(e.id, e.anomaly);
      origColor.set(e.id, e.clusterColor);
    }
    diffOriginalsRef.current = {
      anomaly:      origAnomaly,
      clusterColor: origColor,
      txArray:      liveDataset.TX,
    };

    // Encode delta as clusterColor swap. Anomaly is zeroed so the canvas's
    // anomaly>0.7 lime-override doesn't drown the diff palette. Lime stays
    // strictly reserved for live anomaly semantics — the spec rule holds.
    for (const e of liveDataset.ENTITIES) {
      const d = result.entityDeltas.get(e.id);
      if (!d) continue;
      if (d.tone === 'up') {
        e.anomaly = 0;
        e.clusterColor = 'amber';
      } else if (d.tone === 'down') {
        e.anomaly = 0;
        e.clusterColor = 'cyan';
      }
      // 'flat' entities keep their original color — visually quiet.
    }

    // Inject broken edges (replay-only) into a NEW TX array reference. This
    // is critical: RadarCanvas's visibleTx useMemo recomputes only when the
    // transactions reference changes — in-place push would not refresh it.
    const brokenAsTx: NexusEdge[] = result.brokenEdges
      .filter(e => e.source != null)
      .map(e => ({ ...(e.source as NexusEdge) }));
    liveDataset.TX = [...liveDataset.TX, ...brokenAsTx];

    // Build the per-edge classification map for the canvas overlay.
    const eMap = new Map<string, EdgeDiffKind>();
    for (const e of result.newEdges)    eMap.set(e.key, 'new');
    for (const e of result.brokenEdges) eMap.set(e.key, 'broken');

    setDiffMap(result.entityDeltas);
    setDiffEdgeMap(eMap);
    setIsReplaying(true);
    // Keep activeDataset = liveDataset (mutated) so positions / sim continue.
    setActiveDataset(liveDataset);
  }, [streamer, liveDataset, restoreDiffOriginals]);

  const resumeLive = useCallback(() => {
    // Restore any diff-mode mutations before re-energizing the streamer so
    // the first packet doesn't land on top of an amber/cyan recoloring or
    // re-render with the broken-edge ghosts still in the TX array.
    restoreDiffOriginals();
    setDiffMap(null);
    setDiffEdgeMap(null);
    setIsReplaying(false);
    setActiveDataset(liveDataset);
    streamer?.restart();
  }, [streamer, liveDataset, restoreDiffOriginals]);

  return {
    dataset: activeDataset,
    telemetry, sso, shockTarget, connectionState,
    isReplaying,
    isDiffing: diffMap !== null,
    diffMap,
    diffEdgeMap,
    replayDataset,
    diffSnapshot,
    resumeLive,
  };
}
