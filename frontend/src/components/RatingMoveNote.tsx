import { useCallback, useId, useState } from 'react';
import type { MatchDay, RatingMove } from '../lib/ranking';
import {
  formatRating,
  formatRatingDelta,
  formatRecord,
  formatShortDate,
  formatUncertainty,
  parseChartDate,
  ratingMoveDirection,
  ratingMoveSummary,
  recordSpoken,
  RATING_MOVE_GRAIN_NOTE,
  RATING_MOVE_HINT,
  RATING_MOVE_REFIT_NOTE,
} from '../lib/ranking';

/**
 * What one day of play did to a rating, and a breakdown of what that figure is
 * made of.
 *
 * **The figure is a day's movement, not a match's**, and that is the whole
 * design. The engine is Whole-History Rating: it fits one curve point per day
 * played and holds no opinion about how to split that point's movement across
 * the day's matches, so the only per-match number available would be one this
 * page invented. `RatingMove` in `lib/ranking.ts` carries the full argument
 * and the three factors that are deliberately not offered.
 *
 * Both numbers it prints are published, dated ratings - the same points the
 * chart above draws - so this cannot disagree with the chart, and the
 * difference between them is arithmetic on figures the reader can see.
 *
 * **The rating rides with its margin, here as everywhere.** The house rule is
 * that a number without its margin is exactly the bare figure the margin was
 * meant to qualify, and a *movement* answers to it too: the breakdown says
 * when the movement is smaller than the margin, because a +18 under a ±98 has
 * not separated anything.
 *
 * **Why a disclosure and not a `title`.** A `title` is hover-only: it does not
 * exist on a phone and it is not reliably reachable from the keyboard, and the
 * breakdown is the part that stops the figure being read as an Elo award. So
 * the affordance is a real button - tap on touch, Enter or Space on a
 * keyboard, and hover or focus for a pointer, with Escape to dismiss. The
 * panel opens *inline* rather than as a floating card: at 390px a positioned
 * popover is the thing that drags a page sideways, and this one has a column of
 * text to show.
 */

interface RatingMoveNoteProps {
  move: RatingMove;
  /** The day this movement is of - what was played, and whether we have it all. */
  day: MatchDay;
}

function RatingMoveNote({ move, day }: RatingMoveNoteProps) {
  const panelId = useId();
  /*
   * Two opens, not one.
   *
   * `pinned` is a click or a tap: it stays until it is dismissed, which is the
   * only behaviour a touch reader can get. `peek` is hover or focus, which has
   * to close itself again. Either one shows the panel, so a mouse reader who
   * hovers and then clicks does not see it blink.
   */
  const [pinned, setPinned] = useState(false);
  const [peek, setPeek] = useState(false);
  const open = pinned || peek;

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    setPinned(false);
    setPeek(false);
  }, []);

  const direction = ratingMoveDirection(move.delta);
  const arrow = direction === 'up' ? '▲' : direction === 'down' ? '▼' : '•';
  const summary = ratingMoveSummary(move);

  return (
    <div
      className="rating-move"
      onPointerLeave={() => setPeek(false)}
      onKeyDown={handleKeyDown}
    >
      <button
        type="button"
        className="rating-move-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        title={RATING_MOVE_HINT}
        onClick={() => setPinned((was) => !was)}
        // Mouse only: a tap fires a pointerenter too, and on touch the tap is
        // already the click that pins the panel.
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse') setPeek(true);
        }}
        onFocus={() => setPeek(true)}
        onBlur={() => setPeek(false)}
      >
        <span className="rating-move-rating" aria-hidden="true">
          {formatRating(move.rating)}
          <span className="rating-move-margin">{formatUncertainty(move.uncertainty)}</span>
        </span>
        <span className={`rating-move-delta is-${direction}`} aria-hidden="true">
          <span className="rating-move-arrow">{arrow}</span>
          {formatRatingDelta(move.delta)}
        </span>
        {/* The whole thing in words: the chip is a figure and an arrow, and an
            arrow announces as nothing. */}
        <span className="sr-only">{summary}</span>
      </button>

      {open && (
        <dl className="rating-move-panel" id={panelId}>
          <div>
            <dt>Played</dt>
            <dd>
              {day.complete ? (
                <>
                  <span aria-hidden="true">{formatRecord(day.record)}</span>
                  <span className="sr-only">{recordSpoken(day.record)}</span>{' '}
                  across {day.matches.length} {day.matches.length === 1 ? 'match' : 'matches'}
                  {day.games > 0 && `, ${day.games} ${day.games === 1 ? 'game' : 'games'}`}
                </>
              ) : (
                // The page boundary fell inside this day, so these are some of
                // its matches. The movement is still the day's; the record
                // would not be, so it is not shown as one.
                <>
                  {day.matches.length} of this day&apos;s matches loaded so far
                </>
              )}
            </dd>
          </div>
          <div>
            <dt>Rating</dt>
            <dd>
              {/* Both ends with their margins. The starting anchor has none -
                  it is where everyone begins, not a measurement. */}
              <span className="rating-move-from">
                {formatRating(move.previousRating)}
                {move.fromAnchor ? (
                  <span className="rating-move-margin">start</span>
                ) : (
                  <span className="rating-move-margin">
                    {formatUncertainty(move.previousUncertainty)}
                  </span>
                )}
              </span>
              <span className="rating-move-arrow-to" aria-hidden="true">
                &rarr;
              </span>
              <span className="sr-only">to</span>{' '}
              <span className="rating-move-to">
                {formatRating(move.rating)}
                <span className="rating-move-margin">{formatUncertainty(move.uncertainty)}</span>
              </span>
            </dd>
          </div>
          <div>
            {/* The short date here, not the long one: the term column is
                narrow and the year is already on the day header above. */}
            <dt>
              {move.fromAnchor
                ? 'First day'
                : `Since ${formatShortDate(parseChartDate(move.previousDate as string))}`}
            </dt>
            <dd>
              {formatRatingDelta(move.delta)}
              {move.withinMargin === true && (
                <span className="rating-move-qualifier">
                  {' '}
                  &mdash; smaller than the {formatUncertainty(move.uncertainty)} margin
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>Grain</dt>
            <dd>{RATING_MOVE_GRAIN_NOTE}</dd>
          </div>
          <div>
            <dt>Revised</dt>
            <dd>{RATING_MOVE_REFIT_NOTE}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

export default RatingMoveNote;
