import { RATING_ANCHOR } from '../lib/ranking';

/**
 * The explanation, at the bottom of the page.
 *
 * The ranking page used to open with a paragraph about what a rating is and a
 * sentence next to every unranked player saying why. Both read as the site
 * lecturing before it reported anything. The numbers now come first and the
 * exposition lives here, below them - still on the page, still linkable
 * (`#how-ranking-works`), just not in the way.
 *
 * Short hints at the point of use - the scene picker, the rating column, the
 * word "Unranked" - carry the same facts without the prose.
 */

const CODE_URL = 'https://github.com/eric-maynard/riftfound/tree/main/scraper/src/ranking';
const REPO_URL = 'https://github.com/eric-maynard/riftfound';

interface HowRankingWorksProps {
  /** Gate thresholds from the API, so the copy cannot drift from the engine. */
  minGamesForRating?: number | null;
  maxUncertaintyForRating?: number | null;
  minComponentSize?: number | null;
}

function HowRankingWorks({
  minGamesForRating,
  maxUncertaintyForRating,
  minComponentSize,
}: HowRankingWorksProps) {
  const minGames = minGamesForRating ?? 8;
  const maxMargin = maxUncertaintyForRating ?? null;
  const minScene = minComponentSize ?? 8;

  return (
    <section className="how-it-works" id="how-ranking-works" aria-labelledby="how-it-works-heading">
      <h2 id="how-it-works-heading">How ranking works</h2>
      <dl className="how-it-works-list">
        <dt>Ratings come from recorded games</dt>
        <dd>
          Every rating is worked out from games played at events, so it only compares players who
          have actually played each other. A player with no games sits at{' '}
          {RATING_ANCHOR.toLocaleString()}; wins against stronger opponents move the number further.
        </dd>

        <dt>A scene is a group of players who have played each other</dt>
        <dd>
          Positions only mean something inside one such group, so the page picks a scene rather than
          showing a global ladder. Across scenes there is nothing to compare, and the page says so
          instead of inventing an order. A scene needs at least {minScene} players before it carries
          places.
        </dd>

        <dt>Unranked means not enough evidence yet</dt>
        <dd>
          A rating is published after {minGames} recorded games
          {maxMargin !== null ? `, and once its margin is under ${maxMargin} points` : ''}. Until
          then the player reads <strong>Unranked</strong> and no number is shown - a provisional
          rating would look like a standing it has not earned. Hover the word to see what is still
          missing.
        </dd>

        <dt>The margin is part of the rating</dt>
        <dd>
          The ± beside a rating is its uncertainty, and the shaded band on a player's chart is the
          same thing over time. Early on it is wide, and that is the honest picture.
        </dd>

        <dt>Read the code</dt>
        <dd>
          The rating engine is open: <a href={CODE_URL}>scraper/src/ranking/</a> in the{' '}
          <a href={REPO_URL}>riftfound repository</a>.
        </dd>
      </dl>
    </section>
  );
}

export default HowRankingWorks;
