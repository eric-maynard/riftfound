import { Link } from 'react-router-dom';

import { carryPreview } from '../lib/preview';

/**
 * Ladder or map: the two ways of reading the same scenes.
 *
 * The map shipped as a 14px text link at the bottom of the filter row, below
 * the set pills, the scene picker and the player search - and it was reported
 * as missing rather than as hard to find, which is the more damning of the two.
 * Position is a claim about kind: four things stacked in a filter block all
 * read as filters, so the one that was actually a second *view* of the data
 * was filed as a fourth way to narrow the first.
 *
 * So it moves out of the filters and above them, beside the heading, as a pair.
 * The ladder and the map answer different questions about one dataset - "who is
 * best" and "where is it played" - and neither is a scope on the other, which
 * is exactly the relationship a segmented pair states and a link in a filter
 * row denies.
 *
 * These are **links, not buttons**, for the same reason the mode switch is:
 * each is a route someone can bookmark and share, and `aria-current` carries
 * the selected state. They borrow `.pill` from `SetScope` deliberately - the
 * page already spells "pick one of these" that way, and inventing a second
 * vocabulary for the same gesture is how a UI stops being learnable.
 *
 * `carryPreview` on both, because Rankings is unlisted: a link without the flag
 * unmounts the mode switch under the reader and strands them with no visible
 * way back.
 */

interface RankingViewSwitchProps {
  /** Which view is showing; drives `aria-current` and the active pill. */
  active: 'ladder' | 'map';
  /** The current query string, so the flag and the scope survive the hop. */
  search: string;
}

function RankingViewSwitch({ active, search }: RankingViewSwitchProps) {
  return (
    <nav className="ranking-views" aria-label="Ranking views">
      <Link
        to={carryPreview('/rankings', search)}
        className={`pill${active === 'ladder' ? ' is-active' : ''}`}
        aria-current={active === 'ladder' ? 'page' : undefined}
      >
        Ladder
      </Link>
      <Link
        to={carryPreview('/rankings/map', search)}
        className={`pill${active === 'map' ? ' is-active' : ''}`}
        aria-current={active === 'map' ? 'page' : undefined}
      >
        Scene map
      </Link>
    </nav>
  );
}

export default RankingViewSwitch;
