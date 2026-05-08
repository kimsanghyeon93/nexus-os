// DiffSummaryCard — quantitative readout for the active Diff session.
// Replaces the CaptureHistory in the right column whenever isDiffing===true,
// then yields back when the operator resumes live.
//
// Design intent: war-room glance value. Big mono numbers, strict color
// mapping (amber ↑ / cyan ↓ matches the canvas + PropertyHUD palette), no
// chrome that doesn't carry data.

import type { DiffFilter, DiffSummary } from '../../utils/diff';

export interface DiffSummaryCardProps {
  summary: DiffSummary;
  /** Currently active filter — drives the active-tile inset glow. */
  filter: DiffFilter;
  /** Set to a tile key to focus, or null to clear. Tile clicks toggle:
   *  clicking the active tile reverts to null. */
  onFilterChange: (next: DiffFilter) => void;
}

export function DiffSummaryCard({ summary, filter, onFilterChange }: DiffSummaryCardProps) {
  const totalEntities = summary.entitiesUp + summary.entitiesDown + summary.entitiesFlat;
  const totalEdges    = summary.edgesNew   + summary.edgesBroken;

  const handleTile = (key: NonNullable<DiffFilter>) => {
    onFilterChange(filter === key ? null : key);
  };

  return (
    <section className="nx-diffsum" aria-label="Diff Summary">
      <header className="nx-diffsum__head">
        <div className="nx-diffsum__title">
          <span className="nx-dot nx-dot--amber" />
          <span>DIFF SUMMARY</span>
        </div>
        <span className="nx-mono-dim nx-diffsum__count">
          {totalEntities} ENT · {totalEdges} EDGES Δ
        </span>
      </header>

      <div className="nx-diffsum__grid">
        <Tile
          label="ENTITIES ↑"
          value={summary.entitiesUp}
          tone="amber"
          testid="diffsum-entities-up"
          active={filter === 'entities-up'}
          onClick={() => handleTile('entities-up')}
        />
        <Tile
          label="ENTITIES ↓"
          value={summary.entitiesDown}
          tone="cyan"
          testid="diffsum-entities-down"
          active={filter === 'entities-down'}
          onClick={() => handleTile('entities-down')}
        />
        <Tile
          label="EDGES NEW"
          value={summary.edgesNew}
          tone="amber"
          testid="diffsum-edges-new"
          active={filter === 'edges-new'}
          onClick={() => handleTile('edges-new')}
        />
        <Tile
          label="EDGES BROKEN"
          value={summary.edgesBroken}
          tone="cyan"
          testid="diffsum-edges-broken"
          active={filter === 'edges-broken'}
          onClick={() => handleTile('edges-broken')}
        />
      </div>

      <button
        type="button"
        className="nx-diffsum__footer"
        data-testid="diffsum-unchanged-reset"
        onClick={() => onFilterChange(null)}
        title="Clear filter"
      >
        <span>UNCHANGED · CLICK TO CLEAR FILTER</span>
        <span className="nx-diffsum__footer-val">{summary.entitiesFlat}</span>
      </button>
    </section>
  );
}

interface TileProps {
  label: string;
  value: number;
  tone: 'amber' | 'cyan';
  testid: string;
  active: boolean;
  onClick: () => void;
}

function Tile({ label, value, tone, testid, active, onClick }: TileProps) {
  return (
    <button
      type="button"
      className={
        'nx-diffsum__tile nx-diffsum__tile--' + tone +
        (active ? ' nx-diffsum__tile--active' : '')
      }
      data-testid={testid}
      aria-pressed={active}
      onClick={onClick}
    >
      <div className="nx-diffsum__val">{value}</div>
      <div className="nx-diffsum__lbl">{label}</div>
    </button>
  );
}
