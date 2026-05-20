// GraphModeToggle — `ONTOLOGY ↔ SECURITIES` chooser for the TopBar.
//
// Renders as a 2-segment switch. The active segment carries the cyan
// glow + 1px hi border; idle reads --fg-dim with --border. Composes
// with TopBar's existing chip pattern (similar to the source toggle).
//
// The parent owns the active state — this is a controlled, stateless
// presentational component.

import type { CSSProperties } from 'react';

export type GraphMode = 'ontology' | 'securities';

export interface GraphModeToggleProps {
  value: GraphMode;
  onChange: (next: GraphMode) => void;
}

const OPTIONS: ReadonlyArray<{ id: GraphMode; label: string }> = [
  { id: 'ontology',   label: '▾ ONTOLOGY'   },
  { id: 'securities', label: '◇ SECURITIES' },
];

export function GraphModeToggle({ value, onChange }: GraphModeToggleProps) {
  return (
    <div
      role="tablist"
      aria-label="Graph mode"
      style={ROOT}
      data-testid="graph-mode-toggle"
    >
      {OPTIONS.map(opt => {
        const active = opt.id === value;
        return (
          <button
            key={opt.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.id)}
            data-testid={`graph-mode-${opt.id}`}
            style={segmentStyle(active)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

const ROOT: CSSProperties = {
  display:        'inline-flex',
  gap:            '2px',
  background:     'var(--bg-panel-hi)',
  border:         '1px solid var(--border)',
  borderRadius:   'var(--r-1)',
  padding:        '2px',
};

function segmentStyle(active: boolean): CSSProperties {
  return {
    font:           'var(--type-label)',
    letterSpacing:  'var(--track-label)',
    textTransform:  'uppercase',
    color:          active ? 'var(--cyan)' : 'var(--fg-dim)',
    background:     active ? 'var(--bg-glass-hi)' : 'transparent',
    border:         active ? '1px solid var(--border-hi)' : '1px solid transparent',
    borderRadius:   'var(--r-1)',
    padding:        '4px 10px',
    cursor:         'pointer',
    boxShadow:      active ? 'var(--glow-soft)' : 'none',
    transition:     'all var(--dur-1) var(--ease-out)',
  };
}
