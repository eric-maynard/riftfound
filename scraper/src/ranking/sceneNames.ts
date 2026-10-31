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

  // =====================================================================
  // EUROPE, MIDDLE EAST AND AFRICA
  // =====================================================================
  //
  // Read off the 2026-10-31 geo proposal (403-day replay, 139,692 matches,
  // 1,453 clusters), by pulling every cluster whose match-weighted centroid
  // falls in the EMEA box - 609 of them, holding 1,367 stores - and inspecting
  // each member store's city label and coordinates. Every key below is the
  // cluster's busiest store as that run reported it.
  //
  // Two defects dominate this region and neither is a judgement call:
  //
  // 1. **Multi-language country suffixes.** Reverse geocoding returns Belgium's
  //    country name in all three official languages and Switzerland's in all
  //    four, so a Belgian scene reads `Antwerpen, België / Belgique / Belgien`
  //    (38 characters of country) and a Swiss one `Dübendorf,
  //    Schweiz/Suisse/Svizzera/Svizra`. That is 20 of this region's scenes
  //    rendered unreadable by a suffix none of them needs. These rows are the
  //    cheapest in the table and the first that should disappear if the
  //    geocoder ever returns one language.
  // 2. **A village or a suburb standing in for its metro**, which is the
  //    `Milpitas` failure this table was built for and is more common here than
  //    in the Americas because European metros are polycentric. `Frederiksberg`
  //    is an enclave inside Copenhagen; `Dos Hermanas` is a Seville suburb;
  //    `L-Imġarr` is a village of 4,000 standing for every store on Malta.
  //
  // **Endonyms throughout.** A Greek scene is named in Greek, a German one in
  // German, a Turkish one in Turkish. `Αθήνα, Ελλάς`, `Barcelona, España` and
  // `München, Deutschland` are already right and are left alone; where a city
  // has an English exonym the stores' own labels decide, which is why this
  // block says `Antwerpen` and not `Antwerp`, `Genève` and not `Geneva`,
  // `İstanbul` and not `Istanbul`.
  //
  // What was looked for and **is not here**: the German `Landkreis` /
  // `Verbandsgemeinde` and French `Communauté d'agglomération` labels are
  // **zero** in this proposal, and so are street and business names. The only
  // surviving administrative prefix in the region is the Greek one below.

  // --- Collisions: two scenes the default rule gives the same name --------
  // `London, United Kingdom` is the region's only duplicated label, on two
  // scenes. The city itself keeps the default - it is already right, as
  // `New York, New York` does above - and the fringe cluster is named for its
  // own two towns. Measured from the clusters' own centroids rather than
  // guessed: the core sits at 51.506/-0.121 (ten stores, Charing Cross to
  // Bexleyheath) and this one 21km due south at 51.315/-0.133, where its
  // stores are South Croydon (51.372/-0.100) and Redhill in Surrey
  // (51.240/-0.178). Compass-only (`London — South`) was rejected because
  // Redhill is not in London and nobody in Surrey says it is.
  { shopExternalId: 4850, name: 'Croydon & Redhill', insteadOf: 'London, United Kingdom (shared with the London scene)' },

  // --- Administrative labels, correct and unreadable ----------------------
  // Heraklion's single store, whose label is the Greek for "Municipal Unit of
  // Heraklion". Named in Greek, as `Αθήνα, Ελλάς` already is.
  { shopExternalId: 18824, name: 'Ηράκλειο', insteadOf: 'Δημοτική Ενότητα Ηρακλείου, Ελλάς' },
  // Cyprus returns its country name in Greek and Turkish. Limassol's two
  // stores are 300m apart and label themselves `Λεμεσός` and `Limassol`; the
  // Greek form follows the busier one.
  { shopExternalId: 19104, name: 'Λεμεσός', insteadOf: 'Λεμεσός, Κύπρος - Kıbrıs' },
  // Nisou is a village 16km south of the capital; the other store in the
  // cluster is in Nicosia itself.
  { shopExternalId: 23982, name: 'Λευκωσία', insteadOf: 'Nisou, Κύπρος - Kıbrıs' },

  // --- Switzerland: the four-language country suffix ---------------------
  // Every Swiss scene carries `Schweiz/Suisse/Svizzera/Svizra`. Three of them
  // also have the suburb problem, so the city is corrected at the same time:
  // Dübendorf, Kloten and Rümlang are Zürich suburbs (with both Winterthur
  // stores inside the 30km cap); Herisau is 8km from St. Gallen; Oberwil BL is
  // a Basel suburb. No German store is in the Basel cluster, so it is `Basel`
  // and not a cross-border name.
  { shopExternalId: 5173, name: 'Zürich', insteadOf: 'Dübendorf, Schweiz/Suisse/Svizzera/Svizra' },
  { shopExternalId: 3036, name: 'Genève', insteadOf: 'Genève, Schweiz/Suisse/Svizzera/Svizra' },
  { shopExternalId: 2511, name: 'Bern', insteadOf: 'Bern, Schweiz/Suisse/Svizzera/Svizra' },
  { shopExternalId: 637, name: 'Luzern', insteadOf: 'Luzern, Schweiz/Suisse/Svizzera/Svizra' },
  { shopExternalId: 3363, name: 'St. Gallen', insteadOf: 'Herisau, Schweiz/Suisse/Svizzera/Svizra' },
  { shopExternalId: 1264, name: 'Basel', insteadOf: 'Oberwil BL, Schweiz/Suisse/Svizzera/Svizra' },
  { shopExternalId: 3027, name: 'Sion', insteadOf: 'Sion, Schweiz/Suisse/Svizzera/Svizra' },
  { shopExternalId: 4165, name: 'Biel/Bienne', insteadOf: 'Biel/Bienne, Schweiz/Suisse/Svizzera/Svizra' },
  // Buchs AG is a village of 8,000 whose store sits 2km from Aarau's centre.
  { shopExternalId: 53998, name: 'Aarau', insteadOf: 'Buchs, AG' },

  // --- Belgium: the three-language country suffix ------------------------
  // `België / Belgique / Belgien` on all twelve. `Brussels` above already
  // carries its own row. Dutch or French per the stores' own labels, so
  // `Antwerpen` rather than `Antwerp` and `Gent` rather than `Ghent`.
  { shopExternalId: 1840, name: 'Antwerpen', insteadOf: 'Antwerpen, België / Belgique / Belgien' },
  { shopExternalId: 3744, name: 'Gent', insteadOf: 'Gent, België / Belgique / Belgien' },
  { shopExternalId: 113, name: 'Kortrijk', insteadOf: 'Kortrijk, België / Belgique / Belgien' },
  { shopExternalId: 2377, name: 'Mons', insteadOf: 'Mons, België / Belgique / Belgien' },
  { shopExternalId: 3653, name: 'Hasselt', insteadOf: 'Hasselt, België / Belgique / Belgien' },
  { shopExternalId: 5323, name: 'Turnhout', insteadOf: 'Turnhout, België / Belgique / Belgien' },
  { shopExternalId: 2041, name: 'Dendermonde', insteadOf: 'Dendermonde, België / Belgique / Belgien' },
  { shopExternalId: 4335, name: 'Andenne', insteadOf: 'Andenne, België / Belgique / Belgien' },
  { shopExternalId: 2819, name: 'Tienen', insteadOf: 'Tienen, België / Belgique / Belgien' },
  { shopExternalId: 24422, name: 'Tournai', insteadOf: 'Tournai, België / Belgique / Belgien' },
  // Profondeville is a village 8km upstream; Namur, Jambes (a Namur district)
  // and Gembloux are the rest of the cluster.
  { shopExternalId: 18803, name: 'Namur', insteadOf: 'Namur, België / Belgique / Belgien' },

  // --- Cross-border, and named as such -----------------------------------
  // Liège, Ans and Visé on the Belgian side, Maastricht on the Dutch, 24.6km
  // across with the frontier through the middle - the shape
  // `Jurong & Johor Bahru` is named for above, and its 82.3% internal play
  // share says the two halves really do play each other. Naming it for either
  // country's side would be wrong.
  { shopExternalId: 2977, name: 'Liège & Maastricht', insteadOf: 'Liège, België / Belgique / Belgien' },

  // --- A suburb or village standing in for its metro ----------------------
  // The `Milpitas` case, once per metro. Each line names the metro its member
  // stores actually sit in; the count is that cluster's stores.
  //
  // Zoetermeer (141 matches) and Delft (112) outvote the two stores whose own
  // labels read 's-Gravenhage and Den Haag, so the Dutch seat of government
  // is published under the name of one of its satellite new towns. `Den Haag`
  // over `Haaglanden`, which stopped being an urban region and survives only
  // as a safety region.
  { shopExternalId: 4374, name: 'Den Haag', insteadOf: 'Zoetermeer, Nederland' },
  // Three Rotterdam stores (85 matches) plus Spijkenisse, a Rotterdam suburb
  // (67), against Dordrecht's single busiest store (92). There is no other
  // Rotterdam scene in the corpus, so leaving the default would hide the
  // Netherlands' second city inside a label that does not name it; joined
  // rather than resolved, because Dordrecht holds the anchor store.
  { shopExternalId: 2366, name: 'Rotterdam & Dordrecht', insteadOf: 'Dordrecht, Nederland' },
  // Frederiksberg is an enclave municipality entirely surrounded by
  // Copenhagen. Every store in the cluster is inside the Copenhagen
  // conurbation (København, Kongens Lyngby, Rødovre).
  { shopExternalId: 18497, name: 'København', insteadOf: 'Frederiksberg, Danmark' },
  // Four of the six stores are in Seville proper (155 of 249 matches); Dos
  // Hermanas is its southern suburb and happens to hold the busiest one.
  { shopExternalId: 2884, name: 'Sevilla', insteadOf: 'Dos Hermanas, España' },
  // Alcorcón, Móstoles, Getafe and Fuenlabrada - the belt 11km south-west of
  // the Madrid scene's centroid (40.339/-3.811 against 40.442/-3.684), and
  // `Madrid Sur` is what regional media and the towns themselves call it, so
  // it is a real name rather than a compass direction applied to a metro.
  { shopExternalId: 2708, name: 'Madrid Sur', insteadOf: 'Alcorcón, España' },
  // Orvault, Saint-Herblain, La Chapelle-sur-Erdre and Sautron are all Nantes
  // Métropole communes; three more stores are in Nantes itself.
  { shopExternalId: 3193, name: 'Nantes', insteadOf: 'Orvault, France' },
  // Four İstanbul districts either side of the Bosphorus - Kadıköy, Bakırköy,
  // Beykoz, Küçükçekmece - and the only İstanbul scene in the corpus.
  { shopExternalId: 24275, name: 'İstanbul', insteadOf: 'Kadıköy, Türkiye' },
  // All four stores label themselves Çankaya, which is Ankara's central
  // district, not a town.
  { shopExternalId: 18396, name: 'Ankara', insteadOf: 'Çankaya, Türkiye' },
  // `Praha 5` is a city district. The other two stores read Praha and Praha 3.
  { shopExternalId: 5417, name: 'Praha', insteadOf: 'Praha 5, Česko' },
  // L-Imġarr is a village in Malta's north-west. The cluster's 14.9km diameter
  // is most of the island: Mġarr, Il-Gudja in the south-east, Msida and
  // Birkirkara in the centre. This is the whole country's scene.
  { shopExternalId: 24287, name: 'Malta', insteadOf: 'L-Imġarr, Malta' },
  // Cabestany is a commune contiguous with Perpignan; the other store is in
  // Perpignan, 2.5km away.
  { shopExternalId: 50435, name: 'Perpignan', insteadOf: 'Cabestany, 66' },
  // Schiltigheim and Lampertheim are both Eurométropole de Strasbourg
  // communes; Schiltigheim adjoins Strasbourg's northern edge.
  { shopExternalId: 5062, name: 'Strasbourg', insteadOf: 'Schiltigheim, France' },
  // Saint-Chamond is 12km up the Gier valley from Saint-Étienne, inside
  // Saint-Étienne Métropole, and two of the three stores are in the city.
  { shopExternalId: 2995, name: 'Saint-Étienne', insteadOf: 'Saint-Chamond, France' },
  // Gellainville is a village 3km from Chartres cathedral.
  { shopExternalId: 2656933679, name: 'Chartres', insteadOf: 'Gellainville, 28' },
  // Rubano adjoins Padova to the west; Monselice is 22km south of it.
  { shopExternalId: 31252, name: 'Padova', insteadOf: 'Rubano, PD' },
  // Silea and Paese flank Treviso east and west and are part of its
  // continuous built-up area; Noale is 20km south-west.
  { shopExternalId: 3248, name: 'Treviso', insteadOf: 'Silea, Italia' },
  // Montesilvano and Spoltore are Pescara suburbs and, with the Pescara store
  // itself, hold 71 of the cluster's 93 matches; Chieti is 15km south.
  { shopExternalId: 19209, name: 'Pescara', insteadOf: 'Montesilvano, Italia' },
  // Bardowick is a village 5km north of Lüneburg; it is the only store.
  { shopExternalId: 1571, name: 'Lüneburg', insteadOf: 'Bardowick, Deutschland' },
  // Bellville and Milnerton are both City of Cape Town suburbs, 12km apart,
  // and the only Cape Town scene.
  { shopExternalId: 2684241773, name: 'Cape Town', insteadOf: 'Bellville, WC' },
  // Umhlanga is in eThekwini, Durban's municipality, and is the only store.
  { shopExternalId: 36368, name: 'Durban', insteadOf: 'Umhlanga, KZN' },
  // Nasr City is a Cairo district. One store, 11 matches - small, and included
  // because a national capital published under a district name is the clearest
  // version of this defect in the region.
  { shopExternalId: 17706, name: 'القاهرة', insteadOf: 'مدينة نصر, مصر' },
  // Valence is the préfecture and holds two of the three stores (64 of 117
  // matches); Romans-sur-Isère, 18km north-east, holds the busiest. Joined
  // rather than resolved, which is also what the two call themselves
  // together.
  { shopExternalId: 23968, name: 'Valence & Romans', insteadOf: 'Romans-sur-Isère, France' },
  // Cernay is a Thann-Cernay town 18km from Mulhouse, which holds the other
  // two stores and is the region's centre.
  { shopExternalId: 3662, name: 'Mulhouse', insteadOf: 'Cernay, France' },
  // The Setúbal peninsula: the busiest store's own label is Setúbal, the
  // default picked Palmela off a 24-24 tie, and Pinhal Novo is a Palmela
  // parish. Setúbal is the district capital. **The tie is worth knowing
  // about** - if the counts move, the anchor becomes shop 62802 and this row
  // stops applying.
  { shopExternalId: 34727, name: 'Setúbal', insteadOf: 'Palmela, 15' },

  // --- The default names one town of a region a local names whole ---------
  // Here the member stores are spread over a genuine, colloquially-named
  // region and no one of them is the scene. These are the rows where
  // `Ruhrgebiet` beats a district, per the naming rule.
  //
  // Gdańsk (137 matches), Gdynia, Rumia and Żukowo. `Trójmiasto` is what every
  // Pole calls this agglomeration, Rumia included - it is a Gdynia suburb
  // inside the Tri-City built-up area.
  { shopExternalId: 59337, name: 'Trójmiasto', insteadOf: 'Gdańsk, 22' },
  // Bolton, Wigan and Manchester are Greater Manchester districts (Warrington
  // is Cheshire). There is **no other Manchester scene**, so a Manchester
  // player's store is currently published as `Bolton`.
  { shopExternalId: 19279, name: 'Greater Manchester', insteadOf: 'Bolton, United Kingdom' },
  // Whitley Bay (North Tyneside), Newcastle upon Tyne and Sunderland. The
  // metropolitan county is called Tyne and Wear rather than Tyneside for
  // exactly this reason: Sunderland objected to being filed under the Tyne.
  { shopExternalId: 372, name: 'Tyne & Wear', insteadOf: 'Whitley Bay, United Kingdom' },
  // Two Edinburgh stores (48 of 88 matches) against Dunfermline's single
  // busiest one (40), across the Firth of Forth. The only Edinburgh scene, so
  // the default hides the Scottish capital; joined rather than resolved,
  // because the Forth is a real crossing and Dunfermline holds the anchor.
  { shopExternalId: 58, name: 'Edinburgh & Dunfermline', insteadOf: 'Dunfermline, United Kingdom' },
  // Newcastle-under-Lyme and two Stafford stores, 24km apart. `The Potteries`
  // does not reach Stafford and Newcastle-under-Lyme insists it is not
  // Stoke-on-Trent, so the county is the only name that covers all three -
  // and it also stops a second `Newcastle` colliding with Tyne & Wear above.
  { shopExternalId: 3273, name: 'Staffordshire', insteadOf: 'Newcastle-under-Lyme, United Kingdom' },
  // Woking in Surrey plus Kingston upon Thames and Isleworth, which are London
  // boroughs - 22km south-west of the London scene's centroid.
  { shopExternalId: 3118, name: 'Woking & Kingston', insteadOf: 'Woking, ENG' },
  // Hénin-Beaumont, Arras and Béthune, 28km across. Artois corresponds to the
  // arrondissements of Arras, Béthune, Saint-Omer and Lens, and Hénin-Beaumont
  // was literally Beaumont-en-Artois before its 1971 merger.
  { shopExternalId: 1488, name: 'Artois', insteadOf: 'Hénin-Beaumont, France' },
  // Martigues and Istres on the lagoon (63 of 97 matches) plus three Salon-de-
  // Provence stores on its northern edge; regional planning calls the whole
  // thing l'ouest étang de Berre.
  { shopExternalId: 17050, name: 'Étang de Berre', insteadOf: 'Martigues, France' },
  // Mandelieu-la-Napoule and Mouans-Sartoux sit against Cannes; Opio is in the
  // pays de Grasse. The Nice scene is separate, 28km east, so this one needs a
  // name of its own rather than a Côte d'Azur that would cover both.
  { shopExternalId: 3037, name: 'Cannes & Grasse', insteadOf: 'Mandelieu-la-Napoule, France' },
  // Three Paris-area scenes sit outside the city's own, and the compass
  // directions are computed from each cluster's centroid against the Paris
  // scene's 48.849/2.354 rather than guessed.
  //
  // 48.993/2.134 - 16km north, 16km west. Maisons-Laffitte, Saint-Ouen-
  // l'Aumône, Poissy, Cormeilles-en-Parisis, Sartrouville: the Seine loops of
  // Val-d'Oise and northern Yvelines.
  { shopExternalId: 19247, name: 'Paris — Nord-Ouest', insteadOf: "Saint-Ouen-l'Aumône, France" },
  // 48.765/2.175 - 9km south, 13km west. Montigny-le-Bretonneux
  // (Saint-Quentin-en-Yvelines), Antony, Longjumeau.
  { shopExternalId: 1161, name: 'Paris — Sud-Ouest', insteadOf: 'Montigny-le-Bretonneux, France' },
  // 48.851/2.735 - 28km due east, and this one has a proper name rather than a
  // bearing: Montévrain and Bussy-Saint-Georges are both Marne-la-Vallée new
  // town sectors, which is what anyone living there says.
  { shopExternalId: 19466, name: 'Marne-la-Vallée', insteadOf: 'Montévrain, 77' },
  // la Garriga and Granollers are both Vallès Oriental, the comarca whose
  // capital is Granollers and in which la Garriga is a second centre; Mataró
  // (4 matches) is Maresme. Catalan, as the stores' own labels are.
  { shopExternalId: 18258, name: 'Vallès Oriental', insteadOf: 'la Garriga, España' },
  // Idstein is a Taunus commuter town of 25,000 that happens to hold the
  // busiest store; Mainz and Wiesbaden, the two state capitals facing each
  // other across the Rhine, hold 81 of the cluster's 145 matches. Joined,
  // because naming either one erases the other.
  { shopExternalId: 5430, name: 'Mainz & Wiesbaden', insteadOf: 'Idstein, Deutschland' },
  // Bergheim, Frechen and Hürth are all Rhein-Erft-Kreis, west of Köln.
  // `Rhein-Erft` is the shortened form in local use, and the same shape as
  // `Rhine-Neckar` above. There are several Bergheims in German-speaking
  // Europe, which is the other half of the reason.
  { shopExternalId: 4509, name: 'Rhein-Erft', insteadOf: 'Bergheim, Deutschland' },
  // Köln (158 matches) with three Bonn stores (60) and Troisdorf (55)
  // between them. Köln/Bonn is how the region, its airport and its transport
  // authority are all named.
  { shopExternalId: 2451, name: 'Köln & Bonn', insteadOf: 'Köln, Deutschland' },
  // Two Bielefeld stores (49 matches, a city of 340,000) against Gütersloh's
  // single busiest one (67). The default names the smaller city.
  { shopExternalId: 5378, name: 'Bielefeld & Gütersloh', insteadOf: 'Gütersloh, Deutschland' },
  // Lage (Kreis Lippe) and Bünde (Kreis Herford) are tied on 84 matches each,
  // with Herford between them; the default label picked Bünde and the anchor
  // key is Lage, which is the tie-break on the lower shop id. Named for both
  // districts rather than `Ostwestfalen-Lippe`, which would also cover the
  // Bielefeld/Gütersloh cluster above. **The tie is worth knowing about**: if
  // the counts move, the anchor becomes shop 18310.
  { shopExternalId: 17317, name: 'Herford & Lippe', insteadOf: 'Bünde, Deutschland' },
  // Kaltenkirchen, Bad Segeberg and Bargteheide, all Hamburg commuter towns in
  // Schleswig-Holstein, 34km north of the Hamburg scene's centroid
  // (53.839/10.128 against 53.530/10.059) - measured, not assumed.
  { shopExternalId: 2843, name: 'Hamburg — Nord', insteadOf: 'Kaltenkirchen, Deutschland' },
  // Pirk (a Weiden suburb), Luhe, Grafenwöhr and Vilseck, 26km across.
  // `Nordoberpfalz` is the name the region's own newspaper and chamber of
  // commerce use, and unlike `Weiden` it covers the two training-area towns
  // as well.
  { shopExternalId: 681, name: 'Nordoberpfalz', insteadOf: 'Pirk, Deutschland' },
  // Gijón 89 matches, Oviedo 85, 25km apart - Asturias' two cities at almost
  // exactly equal weight. Naming it for either would be a coin flip, so both.
  { shopExternalId: 4579, name: 'Gijón & Oviedo', insteadOf: 'Gijón / Xixón, España' },

  // --- A label that names the wrong place entirely ------------------------
  // Saint-Louis and Saint-Pierre on Réunion, in the Indian Ocean. `Saint-
  // Louis, France` is true and actively misleading: there is also a Saint-
  // Louis in Alsace, 9,500km away, and a reader cannot tell which this is.
  { shopExternalId: 18095, name: 'La Réunion', insteadOf: 'Saint-Louis, France' },

  // --- Gulf states: a long country suffix, or a region code that reads as a
  // --- US state ----------------------------------------------------------
  // All four Dubai stores label themselves دبي; the suffix is the UAE's full
  // Arabic name. Kept in Arabic, as the stores are.
  { shopExternalId: 24102, name: 'دبي', insteadOf: 'دبي, الإمارات العربية المتحدة' },
  // `AZ` is Abu Dhabi's emirate code and reads as Arizona in a worldwide
  // picker. This store's own label is in English, so the name follows it.
  { shopExternalId: 44660, name: 'Abu Dhabi', insteadOf: 'Abu Dhabi, AZ' },
  // Al Janabiyah is a village in Bahrain's Northern Governorate - not Manama,
  // which is a different governorate - and its one store is the whole
  // country's scene, the same case as `Malta` above.
  { shopExternalId: 50161, name: 'البحرين', insteadOf: 'الجنبية, 17' },
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
