import type { Record_ } from '../lib/ranking';
import { formatWinRate, winRate } from '../lib/ranking';

/**
 * A record as a filled bar with its W-L-D counts beside it.
 *
 * op.gg never prints a bare win-rate percentage: the number always sits next
 * to the record it came from, so "100%" cannot be read as a standing when it
 * means one win. That matters more here than there - at launch a typical
 * player has three matches - so the counts are the headline and the percentage
 * is the small figure, which is the reverse of the reference.
 *
 * Colour is never the only signal: each segment is labelled with its letter
 * and count, and the counts repeat as text beneath. Segments are separated by
 * a gap in the surface colour, because the win green and the loss red are only
 * 2.29:1 against each other and must not meet edge to edge.
 */

interface RecordBarProps {
  record: Record_;
  /** Says what the record covers - "loaded matches", not "all matches". */
  caption?: string;
}

function RecordBar({ record, caption }: RecordBarProps) {
  const total = record.wins + record.losses + record.draws;
  const rate = winRate(record);

  if (total === 0) {
    return (
      <div className="record-bar record-bar-empty">
        <span className="record-counts muted">No decided results yet</span>
        {caption && <span className="record-caption">{caption}</span>}
      </div>
    );
  }

  const percent = (value: number) => `${(value / total) * 100}%`;

  return (
    <div className="record-bar">
      <div className="record-headline">
        {/* Counts lead, percentage follows. The reference does the reverse,
            but the reference's players have four hundred games; here a
            headline "100%" would usually mean one win. */}
        <span className="record-counts">
          <span className="record-count record-count-win">{record.wins}W</span>
          <span className="record-count record-count-loss">{record.losses}L</span>
          {record.draws > 0 && (
            <span className="record-count record-count-draw">{record.draws}D</span>
          )}
        </span>
        <span className="record-rate">{formatWinRate(rate)}</span>
      </div>
      <div
        className="record-track"
        role="img"
        aria-label={`${record.wins} wins, ${record.losses} losses${
          record.draws > 0 ? `, ${record.draws} draws` : ''
        } - ${formatWinRate(rate)} win rate`}
      >
        {record.wins > 0 && (
          <span className="record-seg record-seg-win" style={{ width: percent(record.wins) }} />
        )}
        {record.draws > 0 && (
          <span className="record-seg record-seg-draw" style={{ width: percent(record.draws) }} />
        )}
        {record.losses > 0 && (
          <span className="record-seg record-seg-loss" style={{ width: percent(record.losses) }} />
        )}
      </div>
      {caption && <span className="record-caption">{caption}</span>}
    </div>
  );
}

export default RecordBar;
