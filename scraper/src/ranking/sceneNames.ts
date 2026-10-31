/**
 * Curated scene names.
 *
 * ## Why a table at all
 *
 * The default rule - the match-weighted modal city label of a scene's venues -
 * is right often enough to be the default and wrong often enough to need this.
 * It fails in one predictable direction: it names a *region* after whichever
 * single municipality happens to hold the busiest store. "Milpitas CA" is a
 * true statement about where the most matches were played and a useless answer
 * to "which scene is this", because the eight stores around it are in San Jose,
 * Santa Clara and Sunnyvale and nobody calls that Milpitas. The same for
 * "Valley Stream NY" where a local would say Nassau County, and "Woluwe-Saint-
 * Lambert" where they would say Brussels.
 *
 * So geography supplies the default and judgement supplies the exceptions. That
 * is the shape `scraper/CLAUDE.md` recommends - "Geography as the label,
 * inference as the definition" - and the exceptions have to live somewhere a
 * human can read and edit, which is here rather than in a database row.
 *
 * ## Why the key is a shop id
 *
 * An override needs to survive the thing it is attached to being re-clustered.
 * Three candidate keys, and only one of them does:
 *
 * - **A scene id** is carried forward by venue-set Jaccard overlap, so it is
 *   stable *most* of the time and silently is not when a scene splits or
 *   merges. An override keyed on it would stop applying exactly when the map
 *   changed, which is the moment it is most needed.
 * - **A city label** is the thing being corrected. Keying the correction on it
 *   is circular, and it moves when reverse geocoding improves.
 * - **A `shopExternalId`** is a durable identity that outlives seasons, and it
 *   is already the only thing a scene is allowed to be keyed on anywhere in
 *   this pass (see `scenes.ts` on `venueKey`'s `geo:` fallback). A store does
 *   not move.
 *
 * So an override names a **store**, and the scene containing that store takes
 * the name. The store chosen is the scene's busiest, because that is the one
 * least likely to drop out of the scene it anchors.
 *
 * ## The rules this table follows
 *
 * - **An override applies to at most one scene per run.** Two overrides landing
 *   in one scene would be ambiguous, so the match is decided by the scene's
 *   busiest overridden store and the rest are ignored - deterministically, on
 *   matches then on shop id.
 * - **A name is a place a player would recognise**, at the scale the clustering
 *   actually produces. With a 30km diameter cap that is often a district or a
 *   county rather than a metro: "Peninsula" and "South Bay" rather than "SF Bay
 *   Area", which at this bound is four or five separate scenes and naming any
 *   one of them after the whole region would be the same error in the other
 *   direction.
 * - **An unrecognised store is not an error.** A store that ages out of the
 *   replay window takes its override out of use and nothing breaks; the scene
 *   falls back to its modal city label.
 */

import type { GeoVenue } from './geoScenes.js';

/** One curated name, keyed on the store that anchors the scene. */
export interface SceneNameOverride {
  /** The scene's busiest store. A durable id; see the module note. */
  shopExternalId: number;
  /** What the scene is called. */
  name: string;
  /** What the default rule produced, and why it is wrong. For the next reader. */
  insteadOf: string;
}

/**
 * The curated names.
 *
 * Each was read off the 30km clustering of production venue coordinates, by
 * looking at the scene's member stores and their city labels rather than at its
 * modal label alone. The `insteadOf` column is the default rule's answer, kept
 * so a later reader can tell whether the override is still earning its place -
 * if reverse geocoding improves and the default starts agreeing, the row can go.
 */
export const SCENE_NAME_OVERRIDES: SceneNameOverride[] = [
  // --- The default rule names a region after one of its towns -------------
  // These are the cases the brief was about: a scene spanning a dozen
  // municipalities labelled with whichever one holds the busiest store.
  { shopExternalId: 64160, name: 'Singapore', insteadOf: 'Central Singapore Community Development Council, 01' },
  { shopExternalId: 14818, name: 'Metro Manila', insteadOf: 'Quezon City, Quezon City' },
  { shopExternalId: 14608, name: 'Klang Valley', insteadOf: 'Petaling Jaya, 10' },
  { shopExternalId: 3188, name: 'Brussels', insteadOf: 'Woluwe-Saint-Lambert - Sint-Lambrechts-Woluwe, België / Belgique / Belgien' },
  { shopExternalId: 17613, name: 'Rhine-Neckar', insteadOf: 'Mühlhausen, Deutschland' },
  { shopExternalId: 39502, name: 'Thessaloniki', insteadOf: 'Menemeni, B' },

  // --- The Bay Area, metro-prefixed --------------------------------------
  //
  // These are the scenes this whole investigation was about - a shop in Redwood
  // City read "Scene: New York, New York" - and they are now prefixed with the
  // metro, as the owner asked ("whats the bay area scene, since i dont see
  // one?"). The prefix earns its length in a worldwide picker: `Peninsula` and
  // `South Bay` are unambiguous to a local and mean nothing to a reader
  // scrolling 1,432 rows, where `Bay Area — Peninsula` sorts and reads with its
  // neighbours.
  //
  // Read against the 2026-10-31 geo proposal (403-day replay, 130,012 matches),
  // because three of these clusters changed shape under it and two of the names
  // now carry a caveat the next reader needs:
  //
  //   s2a4726a0cd  10 stores  21.8km  86.0% internal  Milpitas/San Jose/Santa Clara/Sunnyvale
  //   s94af82a16f   6 stores  26.1km  63.1% internal  Redwood City/San Carlos/San Mateo + Union City/Castro Valley
  //   sc563896885   7 stores  19.0km  71.2% internal  San Francisco/Berkeley/Alameda/El Cerrito
  //   sefab00f271   4 stores  17.9km  58.2% internal  Livermore/Dublin
  //   s65bc71aa6e   4 stores  16.6km  55.0% internal  Martinez/Benicia/Vallejo
  { shopExternalId: 3249, name: 'Bay Area — South Bay', insteadOf: 'Milpitas, CA' },
  // **The caveat on this one is real and is not a naming problem.** Under the
  // 2026-10-31 proposal this cluster reaches across the Bay: Union City and
  // Castro Valley join Redwood City, San Carlos and San Mateo, because the
  // Dumbarton and San Mateo bridges put them inside 30km in a straight line.
  // Its internal play share fell to 63.1% against a corpus median of 89.9% -
  // the same signature `Jurong & Johor Bahru` carries at 52%, which the scenes
  // doc reads as "two half-scenes meeting at a crossing". `Peninsula` is still
  // the right name for the half that holds the anchor store and the play; if the
  // owner would rather the cluster not span the Bay at all, the knob is
  // `--max-diameter`, not this table.
  { shopExternalId: 1826, name: 'Bay Area — Peninsula', insteadOf: 'Redwood City, CA' },
  // New under the 2026-10-31 proposal: San Francisco's three stores cluster
  // with Berkeley, Alameda and El Cerrito across the Bay Bridge. Named for both
  // halves rather than after the city, on the same rule the cross-border names
  // below follow. This is a proposal rather than something the owner named.
  { shopExternalId: 23916, name: 'Bay Area — San Francisco & East Bay', insteadOf: 'San Francisco, CA' },
  // Livermore plus two Dublin stores: the Tri-Valley, which is what a local
  // calls it and which the default rule cannot know.
  { shopExternalId: 2000, name: 'Bay Area — Tri-Valley', insteadOf: 'Livermore, California' },
  // **Named as asked, and the name no longer quite fits.** The owner asked for
  // `Diablo Valley` for Martinez/Concord/Vallejo, which is what the *live*
  // assignment held. Under the 2026-10-31 proposal both Concord stores and
  // Pleasant Hill fall below the intra-scene play gate and keep no scene, so
  // what is left is Martinez, Benicia and Vallejo - the Carquinez Strait rather
  // than the Diablo Valley, and at 55.0% internal play it is another
  // two-halves-of-a-crossing cluster. Kept as the owner wrote it because naming
  // is their call and an override is one word to change; `Bay Area — Martinez &
  // Vallejo` is the alternative that matches the table's own cross-border rule.
  { shopExternalId: 51914, name: 'Bay Area — Diablo Valley', insteadOf: 'Martinez, CA' },
  //
  // **`Bay Area — East Bay` is deliberately absent.** The owner asked for it
  // for Union City/Dublin/Castro Valley, and under the 2026-10-31 proposal that
  // cluster does not exist: Union City and Castro Valley joined the Peninsula
  // scene and both Dublin stores joined Livermore. Keying the name on any store
  // in it would put a second override inside an existing scene, where the match
  // is decided by the busiest *overridden* store - so it would rename either
  // Peninsula or Tri-Valley, and which one would move with the match counts.
  // Nothing is added until a cluster exists for it to name.

  // New York at a 30km diameter is five scenes, and four of them are counties
  // or sub-regions rather than the town their busiest store sits in. The city
  // itself keeps the default, which is already right.
  { shopExternalId: 3326, name: 'Nassau County', insteadOf: 'Valley stream, NY' },
  { shopExternalId: 16458, name: 'Westchester', insteadOf: 'Irvington, NY' },
  { shopExternalId: 17522, name: 'North Jersey', insteadOf: 'Bloomfield, NJ' },
  { shopExternalId: 17905, name: 'Central Jersey', insteadOf: 'Edison, New Jersey' },

  // Southern California, likewise: the busiest store's town is not the scene.
  { shopExternalId: 59343, name: 'San Gabriel Valley', insteadOf: 'San Gabriel, California' },
  { shopExternalId: 64127, name: 'Orange County', insteadOf: 'Garden Grove, CA' },

  // --- Collisions: two scenes the default rule gives the same name --------
  // Worse than a vague name, because a picker would list the same entry twice
  // and a reader could not tell which was which. Measured across the whole
  // 30km proposal: 7 labels are shared by 16 scenes, and these are them. Each
  // override is read off the member councils and the scene's centroid, so the
  // compass directions are measured rather than guessed.
  // Bangkok is three scenes at 30km and all three default to `Bangkok, 10`.
  // The core keeps the bare name and the other two are named by their
  // position relative to it, measured from the clusters' own centroids rather
  // than guessed: the core sits at 13.766/100.535, east at 13.729/100.651 and
  // north at 13.860/100.584.
  { shopExternalId: 18715, name: 'Bangkok', insteadOf: 'Bangkok, 10 (shared with 2 other scenes)' },
  { shopExternalId: 2862394495, name: 'East Bangkok', insteadOf: 'Bangkok, 10 (shared with 2 other scenes)' },
  { shopExternalId: 53438, name: 'North Bangkok', insteadOf: 'Bangkok, 10 (shared with 2 other scenes)' },
  { shopExternalId: 53311, name: 'West Jakarta & Tangerang', insteadOf: 'Jakarta, JK (shared with 1 other scene)' },
  { shopExternalId: 2694491100, name: 'East Jakarta & Bekasi', insteadOf: 'Jakarta, JK (shared with 1 other scene)' },
  { shopExternalId: 1449, name: 'Mississauga', insteadOf: 'Toronto, Canada (shared with the Toronto scene)' },
  // Overriding the one above leaves two Toronto-area scenes both named after
  // Mississauga - "Mississauga" and the default "Mississauga, Canada" - which
  // is the collision problem one string short of being caught. This one is
  // the northern of the two: its distinguishing members, Brampton and
  // Georgetown (Halton Hills), both lie north of the city its busiest store
  // is in, which is readable off the member labels rather than guessed.
  { shopExternalId: 2743, name: 'North Mississauga & Brampton', insteadOf: 'Mississauga, Canada' },
  { shopExternalId: 5373, name: 'Kanata', insteadOf: 'Ottawa, Canada (shared with the Ottawa scene)' },
  { shopExternalId: 2270792425, name: 'Cuautitlán Izcalli', insteadOf: 'Mexico City, CMX (shared with the Mexico City scene)' },
  { shopExternalId: 30398, name: 'North Shore', insteadOf: 'Sydney, NSW (shared with 2 other scenes)' },
  { shopExternalId: 27095, name: 'Penrith & Blue Mountains', insteadOf: 'Sydney, NSW (shared with 2 other scenes)' },
  { shopExternalId: 2679668660, name: 'Macarthur', insteadOf: 'Sydney, NSW (shared with 2 other scenes)' },

  // Administrative council names, which are correct and unreadable.
  { shopExternalId: 17686, name: 'Western Sydney', insteadOf: 'City of Parramatta Council, Australia' },
  { shopExternalId: 18301, name: 'South East Melbourne', insteadOf: 'City of Greater Dandenong, Australia' },

  // --- Cross-border, and named as such -----------------------------------
  // Singapore's west plus Johor Bahru across the strait. 25.4km apart, so a
  // legitimate cluster by the geometry, and its intra-scene play share is 56%
  // against a corpus median of 94% - i.e. the number says what the map cannot,
  // that this is two half-scenes meeting at a border crossing. It clears the
  // gate, so it is published; naming it after either half would be wrong.
  { shopExternalId: 56036, name: 'Jurong & Johor Bahru', insteadOf: 'South West Community Development Council, 05' },
  // Cavite plus the southern edge of Metro Manila, the same shape.
  { shopExternalId: 53922, name: 'Cavite & South Metro Manila', insteadOf: 'Imus City, CAV' },
  { shopExternalId: 61249, name: 'Klang & Shah Alam', insteadOf: 'Subang Jaya, 10' },
];

/**
 * The curated name for a scene, or null to fall back to the default rule.
 *
 * Matched on the scene's **busiest overridden store**, so a scene that happens
 * to contain two overridden stores still gets one deterministic name.
 */
export function sceneNameOverride(members: GeoVenue[]): string | null {
  if (SCENE_NAME_OVERRIDES.length === 0) return null;
  const byShop = new Map(SCENE_NAME_OVERRIDES.map(row => [row.shopExternalId, row]));

  let best: GeoVenue | null = null;
  for (const venue of members) {
    if (!byShop.has(venue.shopExternalId)) continue;
    if (
      best === null ||
      venue.matches > best.matches ||
      (venue.matches === best.matches && venue.shopExternalId < best.shopExternalId)
    ) {
      best = venue;
    }
  }
  return best === null ? null : byShop.get(best.shopExternalId)!.name;
}
