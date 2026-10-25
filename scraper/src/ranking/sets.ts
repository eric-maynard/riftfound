/**
 * Riftbound set boundaries, as a curated and source-cited table.
 *
 * Why a table and not a literal: Riot has published English street dates for
 * some sets and not others, and a rating scope that silently invents a boundary
 * is worse than one that says "I don't know". So each set carries either a
 * release date or an explicit `null`, and the *scopes* a rating is published
 * under are derived from the dates that actually exist.
 *
 * Sources (community trackers and store listings; Riot publishes street dates
 * per set rather than in one place):
 *
 * | set | name           | code | English release | source |
 * |-----|----------------|------|-----------------|--------|
 * | -   | Proving Grounds| OGS  | 2025-10-31      | shipped alongside Origins as a box set, same street date |
 * | 1   | Origins        | OGN  | 2025-10-31      | Riot's English launch announcement |
 * | 2   | Spiritforged   | SFD  | 2026-02-13      | two independent trackers agree (China 2025-12-12) |
 * | 3   | Unleashed      | UNL  | 2026-05-08      | two independent trackers agree (China 2026-04-10) |
 * | 4   | Vendetta       | VEN  | 2026-07-31      | two independent trackers agree |
 * | 5   | Radiance       | RAD  | 2026-10-23      | two independent trackers agree; Pre-Rift weekend 2026-10-16..19 |
 * | 6   | Legacy         |      | 2027-01-29      | community set tracker; Pre-Rift 2027-01-22..28 |
 * | 7   | The Reckoning  |      | 2027-04-30      | community set tracker |
 *
 * Earlier revisions of this table recorded sets 2 and 3 as having no published
 * English street date, which was wrong - both shipped in English (2026-02-13
 * and 2026-05-08) and the dates are corroborated by two independent trackers.
 * That error collapsed 2025-10-31..2026-07-30 into a single `ambiguous` era
 * covering sets 1-3; with the dates filled in it splits into three, which is
 * exactly the table-not-code change this design anticipated.
 *
 * Proving Grounds is a box set sharing Origins' street date, so it adds no
 * boundary and is not a separate era.
 *
 * The whole table is overridable with `RANKING_SET_TABLE` (a JSON array of
 * `{ id, name, releaseDate, source }`), so a correction does not need a deploy.
 */

export interface SetDefinition {
  /** Riot's set number, as a string so an override can use any label. */
  id: string;
  name: string;
  /** `YYYY-MM-DD` English release, or null when Riot never published one. */
  releaseDate: string | null;
  /** Where the date came from. Required: an uncited date is a guess. */
  source: string;
}

/**
 * A contiguous span of time a rating can be scoped to.
 *
 * One era per *known* boundary. An era that covers more than one set, because
 * the boundary between them was never published, says so (`ambiguous`) instead
 * of pretending to be a single set.
 */
export interface SetEra {
  /** Scope id, e.g. `s5` or `s1-s3`. Used in `set:<id>` scope strings. */
  id: string;
  label: string;
  /** Every set this era may contain. Length > 1 means the boundary is unknown. */
  setIds: string[];
  /** Inclusive `YYYY-MM-DD`. */
  from: string;
  /** Exclusive `YYYY-MM-DD`, or null for the current (open) era. */
  to: string | null;
  ambiguous: boolean;
}

/** The curated table. Order is by set number, not by date. */
export const SET_TABLE: readonly SetDefinition[] = [
  { id: '1', name: 'Origins', releaseDate: '2025-10-31', source: 'Riot English launch announcement' },
  { id: '2', name: 'Spiritforged', releaseDate: '2026-02-13', source: 'two independent set trackers (China 2025-12-12)' },
  { id: '3', name: 'Unleashed', releaseDate: '2026-05-08', source: 'two independent set trackers (China 2026-04-10)' },
  { id: '4', name: 'Vendetta', releaseDate: '2026-07-31', source: 'two independent set trackers' },
  { id: '5', name: 'Radiance', releaseDate: '2026-10-23', source: 'two independent set trackers' },
  { id: '6', name: 'Legacy', releaseDate: '2027-01-29', source: 'product listings / community set tracker' },
  { id: '7', name: 'The Reckoning', releaseDate: '2027-04-30', source: 'product listings / community set tracker' },
];

/** Scope id for everything before the first known release. */
export const PRE_RELEASE_ERA_ID = 'pre';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a `RANKING_SET_TABLE` override.
 *
 * Returns the curated table unchanged when the value is absent or unusable -
 * a malformed override must not take the rating pass down, and it must not
 * silently become "no sets at all" either.
 */
export function parseSetTable(raw: string | undefined): {
  table: readonly SetDefinition[];
  warning?: string;
} {
  if (!raw || raw.trim() === '') return { table: SET_TABLE };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { table: SET_TABLE, warning: `RANKING_SET_TABLE is not JSON (${(error as Error).message})` };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { table: SET_TABLE, warning: 'RANKING_SET_TABLE must be a non-empty array' };
  }

  const table: SetDefinition[] = [];
  for (const entry of parsed) {
    const row = entry as Partial<SetDefinition>;
    if (typeof row?.id !== 'string' || typeof row?.name !== 'string') {
      return { table: SET_TABLE, warning: 'RANKING_SET_TABLE entries need string id and name' };
    }
    const releaseDate = row.releaseDate ?? null;
    if (releaseDate !== null && (typeof releaseDate !== 'string' || !DATE_RE.test(releaseDate))) {
      return { table: SET_TABLE, warning: `RANKING_SET_TABLE: ${row.id} releaseDate must be YYYY-MM-DD or null` };
    }
    table.push({
      id: row.id,
      name: row.name,
      releaseDate,
      source: typeof row.source === 'string' ? row.source : 'RANKING_SET_TABLE override',
    });
  }
  return { table };
}

/**
 * Turn the set table into the eras a rating can be scoped to.
 *
 * One era starts at each distinct known release date. Sets with no date are
 * folded into the era they fall inside - which is decided by set *order*, the
 * only thing we know about them - and make that era ambiguous.
 */
export function buildEras(table: readonly SetDefinition[] = SET_TABLE): SetEra[] {
  // Group consecutive sets so that each group starts with a dated set and
  // absorbs the undated sets that follow it in set order.
  const groups: { date: string | null; sets: SetDefinition[] }[] = [];
  for (const set of table) {
    if (set.releaseDate !== null || groups.length === 0) {
      groups.push({ date: set.releaseDate, sets: [set] });
    } else {
      groups[groups.length - 1].sets.push(set);
    }
  }

  // A leading undated group has no boundary at all; it cannot form an era.
  const dated = groups.filter((group): group is { date: string; sets: SetDefinition[] } => group.date !== null);
  dated.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const eras: SetEra[] = [];
  if (dated.length > 0) {
    eras.push({
      id: PRE_RELEASE_ERA_ID,
      label: 'Pre-release',
      setIds: [],
      from: '0000-01-01',
      to: dated[0].date,
      ambiguous: false,
    });
  }

  dated.forEach((group, index) => {
    const setIds = group.sets.map(set => set.id);
    const ambiguous = setIds.length > 1;
    eras.push({
      id: ambiguous ? `s${setIds[0]}-s${setIds[setIds.length - 1]}` : `s${setIds[0]}`,
      label: ambiguous
        ? `${group.sets[0].name} - ${group.sets[group.sets.length - 1].name}`
        : group.sets[0].name,
      setIds,
      from: group.date,
      to: dated[index + 1]?.date ?? null,
      ambiguous,
    });
  });

  return eras;
}

/** `YYYY-MM-DD` in UTC - the same day key the fact rows are partitioned on. */
export function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Which era an event belongs to, by its UTC start date.
 *
 * Returns null only when the table has no dated set at all, which an override
 * could produce; callers fall back to the all-time scope.
 */
export function eraForDate(eras: readonly SetEra[], at: Date): SetEra | null {
  const day = utcDate(at);
  for (const era of eras) {
    if (day >= era.from && (era.to === null || day < era.to)) return era;
  }
  return null;
}

/**
 * Prerelease attribution.
 *
 * A prerelease is played **with** the new set - that is the entire point of
 * one - so Radiance Pre-Rift play is Radiance play even though it happens days
 * before Radiance's street date. Attributing it by date alone would file it
 * under the *outgoing* set, which is simply wrong about what was on the table.
 *
 * So a prerelease-tier event inside `leadDays` before a set's release is moved
 * forward into that set's era. Measured lead times are short - Radiance's
 * Pre-Rift weekend was 2026-10-16..19 against a 10-23 street date (4-7 days),
 * and Legacy's is 2027-01-22..28 against 01-29 (1-7 days) - so 14 days is
 * generous without reaching back far enough to swallow the previous set's own
 * prerelease.
 *
 * Both the tier names and the lead window are configurable
 * (`RANKING_PRERELEASE_TYPES`, `RANKING_PRERELEASE_LEAD_DAYS`), because the
 * names come from Riot's `tournamentType` enum and that enum changes: the
 * Radiance-era competitive tier `Summoner Skirmish` did not appear in the feed
 * until events were scheduled for it.
 */
export interface PrereleaseOptions {
  /** `tournamentType` values that mean "played with the next set". */
  prereleaseTypes: readonly string[];
  /** How far before a release date a prerelease may sit. */
  leadDays: number;
}

export const DEFAULT_PRERELEASE_OPTIONS: PrereleaseOptions = {
  prereleaseTypes: ['Pre-Rift'],
  leadDays: 14,
};

/** Parse a comma-separated `RANKING_PRERELEASE_TYPES` override. */
export function parsePrereleaseTypes(raw: string | undefined): readonly string[] {
  if (!raw || raw.trim() === '') return DEFAULT_PRERELEASE_OPTIONS.prereleaseTypes;
  const types = raw.split(',').map(entry => entry.trim()).filter(Boolean);
  return types.length > 0 ? types : DEFAULT_PRERELEASE_OPTIONS.prereleaseTypes;
}

/**
 * Which era an event belongs to, accounting for prerelease play.
 *
 * This is what the rating pass uses; `eraForDate` is the date-only primitive it
 * is built on.
 */
export function eraForEvent(
  eras: readonly SetEra[],
  at: Date,
  tournamentType: string | null | undefined,
  options: PrereleaseOptions = DEFAULT_PRERELEASE_OPTIONS
): SetEra | null {
  const byDate = eraForDate(eras, at);
  if (!byDate || !tournamentType) return byDate;
  // The open (current) era has no next set to be a prerelease for.
  if (byDate.to === null) return byDate;

  const isPrerelease = options.prereleaseTypes.some(
    type => type.toLowerCase() === tournamentType.toLowerCase()
  );
  if (!isPrerelease) return byDate;

  const windowStart = new Date(`${byDate.to}T00:00:00.000Z`);
  windowStart.setUTCDate(windowStart.getUTCDate() - options.leadDays);
  if (utcDate(at) < utcDate(windowStart)) return byDate;

  return eras.find(era => era.from === byDate.to) ?? byDate;
}

/** The scope string a per-set rating is published under. */
export function setScope(eraId: string): string {
  return `set:${eraId}`;
}

/** The all-time scope. The product default: see scraper/CLAUDE.md. */
export const ALL_SCOPE = 'all';

/** Scope string for one connected component of the co-play graph. */
export function componentScope(componentId: string): string {
  return `component:${componentId}`;
}

/** Scope string for a set x component slice. */
export function setComponentScope(eraId: string, componentId: string): string {
  return `${setScope(eraId)}#${componentScope(componentId)}`;
}
