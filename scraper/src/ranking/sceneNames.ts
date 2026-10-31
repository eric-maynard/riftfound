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
  // `Cuautitlán Izcalli` used to be here, keyed on the same store 2270792425.
  // It is now `Ciudad de México — Norte` in the Americas block below, with the
  // measurement that retired the old name.
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

  // =======================================================================
  // The Americas
  // =======================================================================
  //
  // Read off the 2026-10-31 geo proposal (403-day replay, 139,692 matches,
  // 1,453 proposed scenes, 709 of them in the Americas) and checked store by
  // store against the **shops table's own `locationText`** rather than against
  // the `displayCity` the default rule reads. That distinction is the whole
  // reason this block is as long as it is: a third of these labels are not
  // imprecise, they are *wrong about the city*, because reverse geocoding
  // returned the nearest point of interest instead of the municipality.
  // Measured examples, all verified against the store's own address:
  //
  //   displayCity (what the default names the scene) | the store's address
  //   ---------------------------------------------- | -------------------
  //   `Temple Terrace, Florida`                      | Tampa, FL
  //   `Holland, OH`                                  | Toledo, OH
  //   `Springfield, VA`                              | Arlington, VA
  //   `Dartmouth, Canada`                            | Halifax, NS
  //   `North Kenilworth Avenue, Ohio`                | Lima, OH
  //   `Wongs Wok, West Virginia`                     | Morgantown, WV
  //   `Anza Road, California`                        | **Mexicali, B.C., Mexico**
  //
  // The last one is worth its own sentence: a store 2.5km south of the
  // California-Baja line is labelled `California`, so the default rule put a
  // Mexicali scene in the United States. An override cannot fix the shops row,
  // but it can stop the scene being named from it.

  // --- Collisions, and near-collisions one string short of being caught ---
  // Five Americas labels are shared outright by two scenes each, and three
  // more differ only in how the state is spelled - `Houston, TX` against
  // `Houston, Texas`, `San Antonio, Texas` against `San Antonio, TX`. That is
  // the same defect as the Mississauga case above and a picker cannot show the
  // difference, so they are treated identically. Where one scene of a pair is
  // plainly the core, it keeps the default and only the other is named; where
  // neither is, both are, by compass bearing measured from the two centroids.
  //
  // New York: the 26-store core (Manhattan/Queens/Jersey City, centroid
  // 40.743/-73.943) keeps `New York, New York`, which is already right. The
  // other is 8 Brooklyn stores plus 2 on Staten Island (centroid
  // 40.608/-74.022) - the busiest is literally "874 4th Avenue, Brooklyn".
  { shopExternalId: 3587, name: 'Brooklyn & Staten Island', insteadOf: 'New York, New York (shared with the New York scene)' },
  // Toronto: the 21-store core keeps the default. This one is Esper Cards on
  // Old Kingston Road in Scarborough (72 of 122 matches) plus Ajax and
  // Pickering - Scarborough is Toronto's east end, Ajax and Pickering are
  // Durham Region, and naming it after either half alone would hide the other.
  { shopExternalId: 16874, name: 'Scarborough & Durham', insteadOf: 'Toronto, Canada (shared with the Toronto scene)' },
  // Las Vegas is two scenes and neither is the core, so both are named from
  // their centroids: 36.160/-115.199 (west of the Strip, reaching North Las
  // Vegas and Centennial Hills) against 36.047/-115.107 (south Las Vegas and
  // Henderson). Locals name the valley by quadrant and by Henderson, never
  // "Las Vegas 1".
  { shopExternalId: 3305, name: 'Las Vegas — West & North', insteadOf: 'Las Vegas, NV (shared with 1 other scene)' },
  { shopExternalId: 17083, name: 'Las Vegas — South & Henderson', insteadOf: 'Las Vegas, NV (shared with 1 other scene)' },
  // Austin: the 7-store city scene keeps the default. The collision is one
  // store on Hamilton Pool Road (78738), 30km west of it out past Bee Cave -
  // the Hill Country, which is exactly how an Austin player says it.
  { shopExternalId: 5401, name: 'Austin — Hill Country', insteadOf: 'Austin, TX (shared with the Austin scene)' },
  // Raleigh is two 3-store scenes of almost equal size, so compass again,
  // measured against downtown Raleigh (35.78/-78.64): 35.699/-78.735 (south
  // Raleigh, Fuquay-Varina, Cary) and 35.874/-78.572 (north Raleigh, Wake
  // Forest). "North Raleigh" is a region a local names unprompted.
  { shopExternalId: 1746, name: 'Raleigh — South', insteadOf: 'Raleigh, NC (shared with 1 other scene)' },
  { shopExternalId: 23443, name: 'Raleigh — North', insteadOf: 'Raleigh, NC (shared with 1 other scene)' },
  // Houston, the near-collision: 9 stores on the west side (Memorial Drive,
  // Spring Branch; centroid 29.771/-95.599) against 2 at Almeda Mall and in
  // Pasadena (29.637/-95.213). Both default to "Houston" and differ only in
  // `TX` vs `Texas`.
  { shopExternalId: 17991, name: 'Houston — West', insteadOf: 'Houston, TX (shared with the Houston, Texas scene)' },
  { shopExternalId: 1804, name: 'Houston — Southeast', insteadOf: 'Houston, Texas (shared with the Houston, TX scene)' },
  // San Antonio, the same: 9 stores on the west and northwest side
  // (29.512/-98.580) against 5 around Universal City and the northeast side
  // (29.563/-98.346).
  { shopExternalId: 4247, name: 'San Antonio — West', insteadOf: 'San Antonio, Texas (shared with the San Antonio, TX scene)' },
  { shopExternalId: 30526, name: 'San Antonio — Northeast', insteadOf: 'San Antonio, TX (shared with the San Antonio, Texas scene)' },

  // --- A business or a street standing in for a region --------------------
  // These are shops-table labels leaking through: the reverse geocode found a
  // shopping centre, a post office, a nail salon or a road, and the default
  // rule has no way to know that is not a place. Every one is replaced with
  // the municipality or region on the busiest store's own address.
  //
  // 9 stores across Maitland, Oviedo, Altamonte Springs, Winter Springs,
  // Casselberry, Winter Park and east Orlando - the metro's northern half,
  // split about evenly between Orange and Seminole counties, so neither county
  // name covers it. The other Orlando scene (4 stores, 28.419/-81.430) is the
  // south-west side and keeps `Orlando, FL`.
  { shopExternalId: 971, name: 'Orlando — North', insteadOf: 'Cool Stuff Games, Florida' },
  // Duluth, Norcross, Lilburn and Mountain Park: all five stores are in
  // Gwinnett County, which is what an Atlanta player says. The default is a
  // post office.
  { shopExternalId: 4957, name: 'Gwinnett County', insteadOf: 'Gwinnett Mall Corners Post Office, Georgia' },
  // The busiest store is "10910 North 56th Street, Tampa" and another member
  // is already labelled `Tampa, FL`; Temple Terrace is an enclave inside the
  // city. St Petersburg is a separate scene, so `Tampa` is unambiguous.
  { shopExternalId: 239, name: 'Tampa, FL', insteadOf: 'Temple Terrace, Florida' },
  // Carmichael, Citrus Heights, Rancho Cordova, Rocklin, Arden: Sacramento's
  // north-east suburbs. The default is Fair Oaks Boulevard, and two more
  // members are a pizza place and a taqueria. Elk Grove keeps its own name as
  // the metro's southern scene.
  { shopExternalId: 3951, name: 'Sacramento — Northeast', insteadOf: 'Fair Oaks Boulevard, California' },
  // "Next Level the Gamers Den" is in Graham, WA; the scene is Graham,
  // Puyallup and Enumclaw, east and south of Tacoma (which is its own scene).
  // Puyallup leads the name because it is the anchor a local names first.
  { shopExternalId: 3595, name: 'Puyallup & Graham', insteadOf: 'Next Level, Washington' },
  // Augusta plus Martinez and North Augusta across the Savannah River. The
  // state code is kept because Augusta, Maine is also in this corpus.
  { shopExternalId: 297, name: 'Augusta, GA', insteadOf: 'ABX - Comics & Games aka Augusta Book Exchange, Georgia' },
  // Churchmans Road is in New Castle, DE; the other store is Middletown,
  // 24km south. Both are New Castle County, which is how Delaware talks about
  // itself - and "New Castle" alone would read as the town.
  { shopExternalId: 1236, name: 'New Castle County, DE', insteadOf: 'New Churchmans Road, Delaware' },
  // East Main Street is in Rock Hill, SC; the other store is Lancaster, 28km
  // south-east. Both are south of Charlotte on the Carolina line.
  { shopExternalId: 729, name: 'Rock Hill & Lancaster', insteadOf: 'East Main Street, South Carolina' },
  // **The store is in Mexico.** "Flip a Coin", Av. Gral. Lucio Blanco, Benito
  // Juárez, 21250 Mexicali, B.C. - 32.6416N is roughly 2.5km *south* of the
  // California-Baja border line at that longitude, so `Anza Road, California`
  // is a geocoding error and not merely a street name. Spanish endonym, which
  // happens to be the same word.
  { shopExternalId: 15198, name: 'Mexicali', insteadOf: 'Anza Road, California' },
  { shopExternalId: 1114, name: 'Amarillo, TX', insteadOf: 'Hardin Drive, Texas' },
  { shopExternalId: 1128, name: 'Lima, OH', insteadOf: 'North Kenilworth Avenue, Ohio' },
  // "Golden Isles" is a real local name for the Brunswick coast, but the
  // label is a shopping plaza on US-17 and the store's address is Brunswick.
  { shopExternalId: 15037, name: 'Brunswick, GA', insteadOf: 'Golden Isles Plaza, Georgia' },
  // Lemay Ferry Road, 63125 - south St Louis County, which every local calls
  // "South County", plus Waterloo, Illinois across the river. St Charles
  // County and the Metro East are separate scenes, hence the metro prefix.
  { shopExternalId: 24380, name: 'St. Louis — South County', insteadOf: 'Lemay Ferry at Will, Missouri' },
  { shopExternalId: 1651, name: 'Morgantown, WV', insteadOf: 'Wongs Wok, West Virginia' },
  { shopExternalId: 24715, name: 'Oxford, PA', insteadOf: 'Outback Adventure Co., Pennsylvania' },
  { shopExternalId: 203, name: 'Caldwell, OH', insteadOf: 'Braden Med Services, Ohio' },
  { shopExternalId: 12, name: 'Hagerstown, MD', insteadOf: 'Halfway, Maryland' },
  // Caracas: the busiest store is on Av. Francisco de Miranda in Caracas and
  // the other member is already labelled `Caracas, Venezuela`. `Sucre, M` is
  // the municipality plus a truncated state code.
  { shopExternalId: 53245, name: 'Caracas', insteadOf: 'Sucre, M' },
  // Valencia, Carabobo. `Parroquia San José` is the civil parish, which is
  // the Venezuelan version of the township problem below. Disambiguated
  // because Valencia, España and Valencia, CA are both in this corpus.
  { shopExternalId: 19137, name: 'Valencia, Venezuela', insteadOf: 'Parroquia San José, Venezuela' },

  // --- Townships, parishes and other administrative labels ----------------
  // All correct, none said aloud. A player says "York", not "Hellam
  // Township"; "Jackson", not "Blackman Charter Township". Each is replaced
  // with the city on the busiest store's address, except where the cluster
  // spans two towns and the county is the smaller claim.
  { shopExternalId: 556, name: 'York, PA', insteadOf: 'Hellam Township, Pennsylvania' },
  // Chesterfield and Clinton townships, 8.5km apart and both in Macomb
  // County - which is exactly what metro Detroit calls that side of town.
  { shopExternalId: 1499, name: 'Macomb County', insteadOf: 'Chesterfield Charter Township, Michigan' },
  // Hamilton Township (Trenton's largest suburb) and Princeton Junction (West
  // Windsor), 14km apart. Both are Mercer County; `Central Jersey` is already
  // the Edison scene's name and would collide.
  { shopExternalId: 2544, name: 'Mercer County', insteadOf: 'Hamilton Township, New Jersey' },
  // Little Egg Harbor and Barnegat townships - the mainland behind Long Beach
  // Island, which is a named region (Southern Ocean County) rather than a
  // township pair.
  { shopExternalId: 15472, name: 'Southern Ocean County', insteadOf: 'Little Egg Harbor Township, New Jersey' },
  // The Upkeep Games Howell, plus one store at Whitmore Lake 21km south.
  // Howell carries 21 of the 25 matches, and "Livingston County" would claim
  // a county the second store is not in.
  { shopExternalId: 16597, name: 'Howell, MI', insteadOf: 'Genoa Charter Township, Michigan' },
  { shopExternalId: 4591, name: 'Traverse City, MI', insteadOf: 'Blair Township, Michigan' },
  { shopExternalId: 1616, name: 'Pickerington, OH', insteadOf: 'Violet Township, Ohio' },
  { shopExternalId: 4630, name: 'Jackson, MI', insteadOf: 'Blackman Charter Township, Michigan' },
  { shopExternalId: 2773, name: 'Uniontown, PA', insteadOf: 'South Union Township, Pennsylvania' },
  { shopExternalId: 4211, name: 'Indiana, PA', insteadOf: 'White Township, Pennsylvania' },
  { shopExternalId: 15911, name: 'Stroudsburg, PA', insteadOf: 'Stroud Township, Pennsylvania' },
  { shopExternalId: 5295, name: 'Sackville, NB', insteadOf: 'Sackville Parish, Canada' },

  // --- A suburb standing in for its metro, or for its region --------------
  // The original defect this table was built for, now in its North and South
  // American form. The test applied to each: does the busiest store's town
  // contain the scene, or merely the busiest store? Where the cluster reaches
  // across a metro the metro's name wins; where the metro already holds more
  // than one scene the `Bay Area — …` prefix pattern is kept.
  //
  // 10 stores, and 203 of its 366 matches are at Chicago addresses - Lincoln
  // Park, Logan Square, Irving Park, River North - plus Niles, Evanston and
  // Wilmette. Niles is one suburb of the ten. Chicagoland holds five more
  // scenes (Berwyn, Palatine, Bolingbrook, Frankfort, Batavia), all named
  // after real municipalities where their play actually is, so only this one
  // takes the metro prefix.
  { shopExternalId: 2232, name: 'Chicago — North Side', insteadOf: 'Niles, IL' },
  // Richmond 202 matches, Vancouver 170, North Vancouver 18. Neither half
  // carries the other, and `Metro Vancouver` would overclaim with Surrey and
  // the Tri-Cities sitting in a separate scene.
  { shopExternalId: 48313, name: 'Vancouver & Richmond', insteadOf: 'Richmond, BC' },
  // Cerritos, Artesia, Lakewood, Downey, Bell, Commerce, Pico Rivera plus
  // Cypress over the Orange County line: the Gateway Cities, which is both
  // the regional body's name and what Los Angeles traffic reports say for
  // south-east LA County.
  { shopExternalId: 4998, name: 'Los Angeles — Gateway Cities', insteadOf: 'Cerritos, California' },
  // 20 stores: Richmond Hill 229 matches, Markham 277 (Unionville included),
  // Newmarket 38, Vaughan 9 - 595 of 657 in York Region, the municipality
  // every GTA player names ("I'm in York Region"). Markham is one of its nine
  // towns.
  { shopExternalId: 1146, name: 'York Region', insteadOf: 'Markham, Canada' },
  // Chandler, Tempe, Mesa, Gilbert: the East Valley, a term in use in Phoenix
  // since the early 1980s. Tempe is one of its four big municipalities.
  { shopExternalId: 3475, name: 'Phoenix — East Valley', insteadOf: 'Tempe, AZ' },
  // Glendale, Peoria, Surprise, Youngtown: the West Valley, the same term's
  // other half, and the reason this one is included even though the brief did
  // not flag it - leaving it as `Glendale, AZ` beside `Phoenix — East Valley`
  // would read as two unrelated things.
  { shopExternalId: 2643, name: 'Phoenix — West Valley', insteadOf: 'Glendale, AZ' },
  // Simi Valley 266 matches, the west San Fernando Valley (West Hills,
  // Chatsworth, Canoga Park) 183, Agoura Hills 41 - two valleys meeting at
  // the Santa Susana Pass, so both are named. "West Valley" is the San
  // Fernando Valley's own informal term for its western end.
  { shopExternalId: 102, name: 'Simi Valley & West Valley', insteadOf: 'Simi Valley, CA' },
  // Northern Virginia is two scenes and there is no inner/outer nickname, so
  // each is named for its anchor. This one is Fairfax (279 of 457 matches)
  // reaching Chantilly, Herndon, Manassas and Woodbridge.
  { shopExternalId: 3787, name: 'Northern Virginia — Fairfax', insteadOf: 'Fairfax, VA' },
  // And this one is Arlington (119) with Springfield (112) and Falls Church
  // (41), inside and at the Beltway. The default says `Springfield, VA` only
  // because Arlington's two stores are spelled `Arlington, VA` and
  // `Arlington, Virginia` and split the modal vote - the store that leads the
  // scene is at 1100 S Hayes St, Arlington.
  { shopExternalId: 14990, name: 'Northern Virginia — Arlington', insteadOf: 'Springfield, VA' },
  // Mexico City, in Spanish, as the endonym rule requires. The main scene is
  // 9 stores in and around the centre (Insurgentes Sur, Naucalpan).
  { shopExternalId: 1991, name: 'Ciudad de México', insteadOf: 'Mexico City, CMX' },
  // **This replaces the existing `Cuautitlán Izcalli` override**, which named
  // a two-store scene after its *smaller* store. The busiest (44 of 68
  // matches) is Drollbox in Residencial Zacatenco, Gustavo A. Madero - inside
  // Mexico City, not in Cuautitlán Izcalli - and the second is 18km north in
  // Izcalli proper. So the scene is the valley's northern edge, and it now
  // reads as the second CDMX scene it is.
  { shopExternalId: 2270792425, name: 'Ciudad de México — Norte', insteadOf: 'Mexico City, CMX (shared with the Ciudad de México scene)' },
  // Golden 75 matches, Northglenn 61, Denver 74, Broomfield 43, Englewood 13,
  // Lakewood 8: the whole metro, 29.9km across, named after one foothills
  // town. No other Denver scene exists, so no prefix.
  { shopExternalId: 2205, name: 'Denver, CO', insteadOf: 'Golden, CO' },
  // Coraopolis 149, Pittsburgh 81, Green Tree 30 - the airport corridor plus
  // the city. One scene, so the metro name rather than a sub-region.
  { shopExternalId: 4536, name: 'Pittsburgh, PA', insteadOf: 'Coraopolis, PA' },
  // West Valley City, Riverton, Murray, Midvale, Herriman, West Jordan,
  // Taylorsville: eight suburbs, no Salt Lake City store, and the valley is
  // the thing they are all in. Davis and Utah counties are separate scenes.
  { shopExternalId: 17963, name: 'Salt Lake Valley', insteadOf: 'Riverton, Utah' },
  // Fruit Cove (Bartram Park), Orange Park x3 and south-west Jacksonville:
  // the southern half of one metro with no second scene in it.
  { shopExternalId: 1912, name: 'Jacksonville, FL', insteadOf: 'Fruit Cove, FL' },
  // Belle Chasse, Uptown New Orleans and Chalmette - three parishes, one city.
  { shopExternalId: 5097, name: 'New Orleans, LA', insteadOf: 'Belle Chasse, Louisiana' },
  { shopExternalId: 3922, name: 'Baton Rouge, LA', insteadOf: 'Denham Springs, LA' },
  // Republic, Nixa and Springfield MO. The state code is load-bearing:
  // Springfield, OR and Springfield, OH are both scenes in this corpus.
  { shopExternalId: 3567, name: 'Springfield, MO', insteadOf: 'Republic, Missouri' },
  // Two of the three stores are at Toledo addresses, and the "Holland" store
  // is itself at 2052 W Sylvania Ave, Toledo.
  { shopExternalId: 1317, name: 'Toledo, OH', insteadOf: 'Holland, OH' },
  // Halifax 76 matches, Dartmouth 87, 5km apart across the harbour. One
  // municipality, two names its residents are particular about, so both.
  { shopExternalId: 2789239894, name: 'Halifax & Dartmouth', insteadOf: 'Dartmouth, Canada' },
  // Balzac (91 matches, the CrossIron Mills side of Rocky View County) and
  // Airdrie (43). Rocky View County is a rural municipal district wrapped
  // round Calgary - the administrative-label problem in Alberta form.
  { shopExternalId: 24646, name: 'Airdrie & Balzac', insteadOf: 'Rocky View County, AB' },
  // Guará and Plano Piloto are administrative regions of Brasília; the
  // busiest store's address is "Guará II QE 26 - Guará, Brasília - DF".
  // Nobody outside the Distrito Federal has heard of either.
  { shopExternalId: 17944, name: 'Brasília', insteadOf: 'Guará, Brasil' },
  // Caguas, Carolina, Guaynabo, Bayamón and San Juan: the San Juan metro,
  // named after the one of the five that is furthest from it.
  { shopExternalId: 5009, name: 'San Juan, PR', insteadOf: 'Caguas, Puerto Rico' },
  // Coconut Creek, Coral Springs, Margate, Plantation, Lauderhill, Davie -
  // all Broward County, and "Broward" is what South Florida says. Fort
  // Lauderdale itself has no store in the scene, so the county, not the city.
  { shopExternalId: 2339, name: 'Broward County', insteadOf: 'Coconut Creek, Florida' },
  // Greenacres, Wellington and Lake Park, the same reasoning one county north.
  { shopExternalId: 59943, name: 'Palm Beach County', insteadOf: 'Greenacres, FL' },
  // Cross-border, and named as such on the same rule as `Jurong & Johor
  // Bahru`: Tijuana 96 matches, Chula Vista 68, Imperial Beach 27, San Diego
  // 4. The busiest single store is Kraken Dice in Chula Vista, so naming the
  // whole thing `Tijuana` was already half wrong. San Diego proper is a
  // separate scene. "South Bay" is what San Diego calls the US half and is
  // deliberately avoided - `Bay Area — South Bay` already exists.
  { shopExternalId: 2831, name: 'Tijuana & Chula Vista', insteadOf: 'Tijuana, BCN' },
  // Highland Heights and Erlanger KY plus one Cincinnati store: 44 of 53
  // matches are in Kentucky, and "Northern Kentucky" is how that scene names
  // itself. The Mason/West Chester scene keeps its own name on the Ohio side.
  { shopExternalId: 18642, name: 'Northern Kentucky', insteadOf: 'Highland Heights, Kentucky' },
  // Lutherville, Pikesville and Nottingham ring Baltimore city to the north,
  // north-west and north-east. There is no collective nickname for them -
  // searched for, not assumed - and all three are in Baltimore County.
  { shopExternalId: 3494, name: 'Baltimore County', insteadOf: 'Lutherville, MD' },
  // Metropolitan Lima: Cercado, Surco, Miraflores. `LMA` is a truncated
  // region code, and Lima, OH is also a scene in this corpus, so the country
  // is spelled out - in Spanish.
  { shopExternalId: 24713, name: 'Lima, Perú', insteadOf: 'Lima, LMA' },
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
