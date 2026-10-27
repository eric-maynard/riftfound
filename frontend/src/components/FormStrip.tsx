import { Link, useLocation } from 'react-router-dom';
import type { PlayerMatch } from '../types/ranking';
import { formatDate, gameScore, outcomeLetter, outcomeWord, recentForm } from '../lib/ranking';
import { carryPreview } from '../lib/preview';

/**
 * Recent form: the last few matches as lettered pips, newest first.
 *
 * Both references lead their profile with this - op.gg as a win-rate ring over
 * the last 20 games, lolchess as a row of placement squares. The square-with-a
 * -number version is the better one to copy, because the number inside is a
 * second channel: the strip survives being read in greyscale, which a ring of
 * blue and red does not. Here the second channel is the result letter.
 *
 * Sparse is the normal case. With three matches this renders three pips and
 * says "last 3", not ten pips with seven empty sockets - an empty socket
 * implies a slot that should have been filled, and nothing here is missing.
 */

interface FormStripProps {
  matches: PlayerMatch[];
  count?: number;
  /** Total matches the player has, when it is more than we have loaded. */
  totalMatches?: number | null;
}

function FormStrip({ matches, count = 10, totalMatches = null }: FormStripProps) {
  // The pips are links into an unlisted section, so they carry the preview
  // flag like every other one (lib/preview.ts).
  const { search } = useLocation();
  const form = recentForm(matches, count);
  if (form.length === 0) return null;

  const more = totalMatches !== null && totalMatches > form.length;

  return (
    <div className="form-strip">
      <span className="form-label">
        Recent form
        <span className="form-sub">
          last {form.length}
          {more ? ` of ${totalMatches}` : ''}, newest first
        </span>
      </span>
      <ol className="form-pips">
        {form.map((match) => {
          const title = `${outcomeWord(match.outcome)} ${gameScore(match)} vs ${
            match.opponentDisplayName ?? 'unknown player'
          } - ${match.eventName ?? 'unnamed event'}, ${formatDate(match.eventDate ?? match.playedAt)}`;
          const pip = (
            <span className={`form-pip form-pip-${match.outcome}`} title={title}>
              <span aria-hidden="true">{outcomeLetter(match.outcome)}</span>
              <span className="sr-only">{title}</span>
            </span>
          );
          return (
            <li key={match.matchId}>
              {/* The pip is the shortest route to the opponent, the way a
                  champion portrait is on op.gg. Without one it is still a pip. */}
              {match.opponentId ? (
                <Link
                  to={carryPreview(`/rankings/players/${encodeURIComponent(match.opponentId)}`, search)}
                  className="form-pip-link"
                >
                  {pip}
                </Link>
              ) : (
                pip
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export default FormStrip;
