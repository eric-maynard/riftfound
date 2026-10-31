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
  // Bangkok is four scenes at 30km and all four default to `Bangkok, 10`.
  // The core keeps the bare name and the others are named by their position
  // relative to it, measured from the clusters' own centroids rather than
  // guessed.
  //
  // **Re-read against the 2026-10-31 proposal, and two of these three moved.**
  // The clusters changed shape, and because an override follows its *store*,
  // `Bangkok` and `East Bangkok` had swapped places: shop 18715 is now in the
  // west-bank cluster and shop 2862394495 in the central one. Measured
  // centroids and membership under that proposal:
  //
  //   se57d9a0e66  35 stores  1,290 matches  13.748/100.593  the central core
  //   sb38c72f854  21 stores    670 matches  13.793/100.456  west bank + Nonthaburi
  //   se4b72835bf  17 stores    552 matches  13.869/100.583  north, into Pathum Thani
  //   sb5bd9bfddc   1 store      53 matches  13.723/100.799  Lat Krabang, far east
  //
  // So the names are re-keyed: the 35-store cluster that holds the inner city
  // (Siam/Sukhumvit/Silom, 100.50-100.69) is `Bangkok`, and the one at
  // 100.456 - Bangkok's west bank plus Bang Yai, Bang Kruai, Mueang
  // Nonthaburi and Pak Kret across the provincial line - is named for both
  // halves on this table's own cross-border rule. Thais call the west bank
  // "ฝั่งธน" / the Thonburi side, and Nonthaburi is a separate province, so
  // `Thonburi & Nonthaburi` is what a player there would say.
  { shopExternalId: 2862394495, name: 'Bangkok', insteadOf: 'Bangkok, 10 (shared with 3 other scenes)' },
  { shopExternalId: 18715, name: 'Thonburi & Nonthaburi', insteadOf: 'Bangkok, 10 (shared with 3 other scenes)' },
  { shopExternalId: 53438, name: 'North Bangkok', insteadOf: 'Bangkok, 10 (shared with 3 other scenes)' },
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
  // Camden plus Campbelltown, which is the Macarthur region. Re-keyed from
  // shop 2679668660 to 2243 against the 2026-10-31 proposal: 2243 (Camden, 45
  // matches) is now the cluster's busiest store and 2679668660 (25) is not, so
  // the old key was relying on being the only *overridden* store in the
  // cluster rather than on the table's own "key it on the busiest" rule. The
  // default label moved with it, from `Sydney, NSW` to `Camden Council`.
  { shopExternalId: 2243, name: 'Macarthur', insteadOf: 'Camden Council, Australia' },

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
  // ASIA-PACIFIC (East/Southeast/South Asia and Oceania)
  // =======================================================================
  //
  // Read off the 2026-10-31 geo proposal (403-day replay, 139,692 matches,
  // 3,811 placed venues in 1,453 scenes): 135 of those scenes have their
  // centroid in this region. Every row below names a cluster whose *store
  // membership and centroid were checked*, and the key is the cluster's
  // busiest store in that proposal. The Bangkok, Jakarta, Sydney and
  // Melbourne entries above are the rest of this region; they are not
  // repeated here.
  //
  // Three things this region does not need, worth recording so the next
  // reader does not go looking:
  //
  // - **No CJK scene exists yet.** Not one cluster in Japan, Korea, Taiwan,
  //   Hong Kong, mainland China or India. The script question ("endonym or
  //   Latin?") therefore has no instance to decide: every label in the region
  //   today is Latin, including the Thai, Malay and Indonesian ones, so these
  //   names stay Latin to match the corpus rather than introducing a second
  //   convention for one row.
  // - **`X, New Zealand / Aotearoa` is left alone** where the city name is
  //   right (Wellington, Hamilton, Dunedin, Nelson, Palmerston North). It is
  //   long, but it is the geocoder's *country* field doing what it does for
  //   `Berlin, Deutschland` and `Madrid, España`, and overriding it per-city
  //   would both desync New Zealand from every other country's default and
  //   put bare `Hamilton` and `Nelson` into a worldwide picker that already
  //   holds `Hamilton, Canada`. Only the rows where the *place* is wrong are
  //   overridden below.
  // - **`Singapore`, `Metro Manila`, `Klang Valley`, `Jurong & Johor Bahru`,
  //   `Cavite & South Metro Manila` and `Klang & Shah Alam` are unchanged**,
  //   and each was re-checked: every one of those keys is still inside the
  //   cluster it names.

  // --- Thailand ----------------------------------------------------------
  // The far-east Bangkok singleton, which defaults to `Bangkok, 10` and so
  // collides with the `Bangkok` row above one string short of being caught.
  // Its one store sits at 13.723/100.799, which is Lat Krabang - the district
  // a Bangkok player names, not "east Bangkok", which is 20km west of it.
  { shopExternalId: 55115, name: 'Lat Krabang', insteadOf: 'Bangkok, 10' },
  //
  // `Mueang X` is the geocoder's answer, not a Thai player's: เมือง is the
  // *city district* of a province, so `Mueang Khon Kaen` is "Khon Kaen's
  // central district" and the trailing number is the province code. Nobody
  // says either half out loud, and in each of these clusters every store is
  // in that one province, so the province's own city name is both shorter and
  // what a local would use.
  { shopExternalId: 53445, name: 'Khon Kaen', insteadOf: 'Mueang Khon Kaen, 40' },
  // 4 stores at 13.31/100.96: the central district plus Si Racha, i.e. the
  // Chonburi coastal strip. Spelled as Thai signage and shops spell it,
  // rather than the royal transcription `Chon Buri` the geocoder returns.
  { shopExternalId: 2504163878, name: 'Chonburi', insteadOf: 'Mueang Chon Buri, 20' },
  // San Sai is a district of Chiang Mai province and the cluster's third
  // store is in Mueang Chiang Mai itself: the scene is Chiang Mai.
  { shopExternalId: 54154, name: 'Chiang Mai', insteadOf: 'San Sai, 50' },
  { shopExternalId: 53997, name: 'Nakhon Pathom', insteadOf: 'Mueang Nakhon Pathom, 73' },
  { shopExternalId: 20730, name: 'Chiang Rai', insteadOf: 'Mueang Chiang Rai, 57' },
  { shopExternalId: 53436, name: 'Rayong', insteadOf: 'Mueang Rayong, 21' },
  { shopExternalId: 53474, name: 'Roi Et', insteadOf: 'Mueang Roi Et, 45' },
  { shopExternalId: 54763, name: 'Phetchabun', insteadOf: 'Mueang Phetchabun, 67' },
  { shopExternalId: 54519, name: 'Phitsanulok', insteadOf: 'Mueang Phitsanulok, 65' },
  { shopExternalId: 59665, name: 'Nakhon Si Thammarat', insteadOf: 'Mueang Nakhon Si Thammarat, 80' },

  // --- Malaysia ----------------------------------------------------------
  // 13 stores at 3.067/101.715 - Cheras, Balakong, Kajang, Beranang,
  // Seri Kembangan, Puchong and Putrajaya, i.e. the south-east corridor out
  // of Kuala Lumpur. Its default label is `Kuala Lumpur, 14`, which is the
  // same string the `Klang Valley` scene would have taken: two scenes, one
  // city name, and this is the one that is not the Klang Valley core. Named
  // for the two hubs its players actually name. Its intra-scene play share is
  // 57.4%, the lowest in the region after Jurong/Johor Bahru, so this is a
  // corridor of half-scenes and naming it after either end alone would be
  // wrong.
  { shopExternalId: 59041, name: 'Cheras & Kajang', insteadOf: 'Kuala Lumpur, 14' },
  // 8 stores: George Town and Gelugor on the island plus Butterworth on the
  // mainland. `Pulau Pinang` is the state's name in Malay; Malaysians writing
  // in English - and every shop listing in the corpus - say Penang.
  { shopExternalId: 20956, name: 'Penang', insteadOf: 'Pulau Pinang, 07' },
  // Ayer Keroh is a suburb of Melaka and the other two stores are labelled
  // Melaka outright.
  { shopExternalId: 15743, name: 'Melaka', insteadOf: 'Ayer Keroh, 04' },
  // Lutong is a township inside Miri; the city is what a Sarawakian says.
  { shopExternalId: 2661621158, name: 'Miri', insteadOf: 'Lutong, 13' },

  // --- Indonesia ---------------------------------------------------------
  // One store at -7.726/110.396, in Sleman regency immediately north of
  // Yogyakarta city and inside its built-up area. The regency is the
  // administrative answer; Yogyakarta (Jogja) is the scene.
  { shopExternalId: 2265042443, name: 'Yogyakarta', insteadOf: 'Sleman, YO' },

  // --- Philippines -------------------------------------------------------
  // 5 stores, 9.2km across, 97.9% internal play: Cebu City plus Mandaue.
  // Metro Cebu is the name the conurbation has and the one a Cebuano uses.
  { shopExternalId: 53915, name: 'Metro Cebu', insteadOf: 'Cebu City, Cebu City' },
  // 5 stores at 14.746/121.029: Novaliches/Lagro in northern Quezon City
  // plus Meycauayan, Marilao and Santa Maria across the Bulacan line - the
  // northern edge of the Manila conurbation, the mirror image of
  // `Cavite & South Metro Manila` and named on the same rule. The default
  // names it after Quezon City, which is 3 of its 5 stores' *province* and
  // not where the scene is.
  { shopExternalId: 53236, name: 'North Metro Manila & Bulacan', insteadOf: 'Quezon City, Quezon City' },
  // 4 stores across Angeles, Mabalacat and Mexico in Pampanga, 203 of 227
  // matches in the contiguous Angeles-Mabalacat urban area. `Metro Clark` is
  // the planning name for it; `Angeles City` is what players say, and it also
  // disambiguates from Los Angeles in a worldwide picker.
  { shopExternalId: 53263, name: 'Angeles City', insteadOf: 'Angeles, Angeles' },
  // 4 stores in central Bulacan - Plaridel, Baliwag, Malolos and San
  // Ildefonso, 26km apart. Named for the two towns a Bulakenyo orients by
  // rather than after Plaridel, which only holds the busiest store, and
  // deliberately not "Bulacan", which would read as the same scene as the row
  // above.
  { shopExternalId: 59058, name: 'Malolos & Baliwag', insteadOf: 'Plaridel, BUL' },
  // Cabuyao plus San Pedro: the northern Laguna stretch of the South Luzon
  // corridor. Locals say Laguna.
  { shopExternalId: 35015, name: 'Laguna', insteadOf: 'Cabuyao City, LAG' },
  // Lipa (2 stores) plus Batangas City. Named for both because the bare
  // province name `Batangas` and the city `Batangas City` are the same word
  // to a reader and different places to a player.
  { shopExternalId: 53302, name: 'Lipa & Batangas City', insteadOf: 'Lipa City, BTG' },
  //
  // The Philippine independent cities are their own province, so reverse
  // geocoding renders them twice - `Davao City, Davao City` - which reads as
  // a bug rather than as a name. Same place, said once. These are the rows
  // most likely to retire themselves: fix the duplication in the label and
  // the default rule agrees with every one of them.
  { shopExternalId: 14618, name: 'Baguio', insteadOf: 'Baguio, Baguio' },
  { shopExternalId: 54583, name: 'Iloilo City', insteadOf: 'Iloilo City, Iloilo City' },
  { shopExternalId: 2757205521, name: 'Davao City', insteadOf: 'Davao City, Davao City' },
  { shopExternalId: 53296, name: 'Bacolod', insteadOf: 'Bacolod, Bacolod' },
  { shopExternalId: 53299, name: 'General Santos', insteadOf: 'General Santos, General Santos' },
  { shopExternalId: 64158, name: 'Olongapo', insteadOf: 'Olongapo, Olongapo' },
  { shopExternalId: 53240, name: 'Cagayan de Oro', insteadOf: 'Cagayan de Oro, Cagayan de Oro' },
  { shopExternalId: 53234, name: 'Zamboanga City', insteadOf: 'Zamboanga City, Zamboanga City' },

  // --- Australia: the council names nobody says aloud --------------------
  // Australian local-government areas are correct, printed on the bins, and
  // not what anyone calls the place they play. Each of these is read off the
  // member stores' positions, not off the council name.
  //
  // 6 stores spread across metro Perth - Bayswater/Morley, Leederville,
  // Stirling, Dianella, East Perth and one down at Jandakot, 22km across.
  // The council holding the busiest store is not the scene; Perth is.
  { shopExternalId: 2242, name: 'Perth', insteadOf: 'City of Bayswater, Australia' },
  // Wangara/Landsdale plus Joondalup, 8km apart and 20km north of the Perth
  // cluster above. Joondalup is the urban centre of Perth's outer north, and
  // the metro prefix is what keeps the two rows apart in a picker.
  { shopExternalId: 3630, name: 'Perth — Northern Suburbs', insteadOf: 'City of Wanneroo, Australia' },
  // Rockingham plus Mandurah, 27km apart down the coast. The default names
  // only the half with the busiest store.
  { shopExternalId: 2245, name: 'Rockingham & Mandurah', insteadOf: 'Rockingham, Australia' },
  //
  // 5 stores at -37.762/144.821: Keilor Park, Airport West, Moonee Ponds,
  // Caroline Springs (Melton) and Werribee (Wyndham). "Western suburbs" is
  // the established Melbourne term for that arc, and `Western Melbourne`
  // reads beside the `Western Sydney` already in this table.
  { shopExternalId: 4778, name: 'Western Melbourne', insteadOf: 'City of Moonee Valley, Australia' },
  // 5 stores at -37.822/145.182: Box Hill (two), Vermont South, Wantirna
  // (Knox) and Mooroolbark (Yarra Ranges) - Melbourne's eastern suburbs, and
  // a different place from the `South East Melbourne` row above, whose
  // centroid is 19km south at -37.995/145.164.
  { shopExternalId: 2227, name: 'Eastern Melbourne', insteadOf: 'City of Whitehorse, Australia' },
  // Melton plus Sunbury, 17km apart on Melbourne's outer north-west edge.
  { shopExternalId: 24168, name: 'Melton & Sunbury', insteadOf: 'City of Melton, Australia' },
  // One store at -38.059/145.463, which is Pakenham. The shire is the
  // administrative container.
  { shopExternalId: 17675, name: 'Pakenham', insteadOf: 'Shire of Cardinia, Australia' },
  //
  // 6 stores at -27.659/153.151 - Loganholme, Springwood, Shailer Park and
  // Yarrabilba, 20km across, south of Brisbane. South-east Queenslanders say
  // "Logan"; "Logan City" is the council's own name for itself.
  { shopExternalId: 16338, name: 'Logan', insteadOf: 'Logan City, Australia' },
  // One store at -27.085/152.950, which is Caboolture, 38km north of the
  // Brisbane cluster. `Greater Brisbane, Australia` is a region label on a
  // single store and collides with the `Brisbane, Australia` scene.
  { shopExternalId: 17966, name: 'Caboolture', insteadOf: 'Greater Brisbane, Australia' },
  //
  // Gosford, Wyong and Tuggerah: the Central Coast, which is what it is
  // called with or without the word "Council".
  { shopExternalId: 3611, name: 'Central Coast', insteadOf: 'Central Coast Council, Australia' },
  // Newcastle plus Maitland, 26km apart up the Hunter. Named for both rather
  // than bare `Newcastle`, which in a worldwide picker sits next to
  // `Newcastle-under-Lyme, United Kingdom`.
  { shopExternalId: 2244, name: 'Newcastle & Maitland', insteadOf: 'City of Newcastle, Australia' },
  // 7 stores across Gungahlin, Belconnen, Tuggeranong, Woden and North
  // Canberra, 23km across and 100% internal play. Those are Canberra's
  // districts; the city is the scene, and naming it after one district is the
  // clearest case in this table of the default rule's one failure mode.
  { shopExternalId: 2686, name: 'Canberra', insteadOf: 'Gungahlin, Australia' },
  //
  // **A business name, not a place.** The default label for this cluster is
  // `Foodland` - a supermarket chain - and its second store's label is
  // `Aldinga Central Shopping Centre`. Both stores are in Adelaide's southern
  // suburbs (-35.14/138.53 and -35.28/138.46), 25-40km south of the Adelaide
  // cluster, so the scene is the south. Note its 50.0% intra-scene share: it
  // sits exactly on the publishing gate and may not appear at all next run.
  { shopExternalId: 4664, name: 'Southern Adelaide', insteadOf: 'Foodland, Australia' },

  // --- New Zealand: where the local board is not the place ---------------
  // 8 stores at -36.773/174.713, 29.9km across: Albany and Upper Harbour
  // (155 matches), Devonport-Takapuna (81) and Silverdale (20) on the North
  // Shore, plus Henderson-Massey and Te Atatu (72) across the harbour in west
  // Auckland. The weight is the North Shore and the metro prefix is doing two
  // jobs: it separates this from the `Auckland, AUK` scene (central and south
  // Auckland, -36.918/174.829), and it keeps `North Shore` unambiguous
  // against Sydney's North Shore row above.
  { shopExternalId: 16311, name: 'Auckland — North Shore', insteadOf: 'Upper Harbour, New Zealand / Aotearoa' },
  // Franklin is the local board; two of the three stores are in Pukekohe and
  // that is what south Aucklanders call it.
  { shopExternalId: 16901, name: 'Pukekohe', insteadOf: 'Franklin, New Zealand / Aotearoa' },
  // Rangiora (70 matches) plus a store in Halswell-Hornby-Riccarton (42),
  // which is Christchurch, 23km apart. Named for both: the busiest store is
  // in North Canterbury and the city is what a Cantabrian orients by, so
  // naming it after either alone misses half the scene.
  { shopExternalId: 2617, name: 'Christchurch & Rangiora', insteadOf: 'Rangiora, New Zealand / Aotearoa' },
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
