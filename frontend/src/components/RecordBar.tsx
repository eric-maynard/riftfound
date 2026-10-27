import type { Record_ } from '../lib/ranking';
import { formatRecord, formatWinRate, recordSpoken, winRate } from '../lib/ranking';

/**
 * A record as a filled bar with the figure beside it.
 *
 * op.gg never prints a bare win-rate percentage: the number always sits next
 * to the record it came from, so "100%" cannot be read as a standing when it
 * means one win. That matters more here than there - at launch a typical
 * player has three matches - so the record leads and the percentage is the
 * small figure, which is the reverse of the reference.
 *
 * **The record is written `2-1-1`, not `2W 1L 1D`.** That is the notation a
 * card player already reads, and it is one figure rather than three coloured
 * chunks shouting at 1.35rem. It still satisfies "colour is never the only
 * signal" by itself, because numerals are not colour - but a screen reader
 * would announce it as "two dash one dash one", so the figure is `aria-hidden`
 * and `recordSpoken` carries the accessible name.
 *
 * The bar is then decorative: everything it draws - the three counts and the
 * proportion between them - is printed as text immediately beside it, so
 * announcing it again would only repeat the row. Its segments still carry a
 * 2px gap in the track colour, because the win green and the loss red are only
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
          <span className="record-value" aria-hidden="true">{formatRecord(record)}</span>
          <span className="sr-only">{recordSpoken(record)}</span>
        </span>
        <span className="record-rate">{formatWinRate(rate)}</span>
      </div>
      {/* Decorative: the figure and the rate beside it already say all of
          this in text, so announcing the bar too would just repeat the row. */}
      <div className="record-track" aria-hidden="true">
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
