import type { SetInfo } from './ranking.js';

/**
 * Set catalogue.
 *
 * The data contract has no SET# item: set ids only appear inside player
 * profiles (the per-set ratings map), match items (`setId`) and ranking scope
 * keys (`set:<id>`). So the list the API serves is *discovered from the data*
 * and then decorated with whatever boundaries are actually published.
 *
 * Every set through 7 has a published English street date, each corroborated by
 * two independent trackers, so a null `releaseDate` now means only the
 * synthetic `pre` era (play recorded before the first street date). Consumers
 * must still cope with null, but it should be rare rather than the norm.
 */
interface KnownSet {
  name: string;
  releaseDate: string | null;
  endDate: string | null;
}

/**
 * Keyed by the engine's **era id** (`s4`), its set number (`4`), the set name
 * and the set code - because the engine emits era ids and an earlier version of
 * this table only knew names, so it matched nothing and the API served every
 * set as an unnamed `s4` with no release date.
 *
 * The engine's own `SET#<id>` items win over this (see `listSets` in
 * rankingService); this is the fallback for a store that cannot enumerate them.
 */
const KNOWN_SETS: Record<string, KnownSet> = {
  s1: { name: 'Origins', releaseDate: '2025-10-31', endDate: '2026-02-13' },
  s2: { name: 'Spiritforged', releaseDate: '2026-02-13', endDate: '2026-05-08' },
  s3: { name: 'Unleashed', releaseDate: '2026-05-08', endDate: '2026-07-31' },
  s4: { name: 'Vendetta', releaseDate: '2026-07-31', endDate: '2026-10-23' },
  s5: { name: 'Radiance', releaseDate: '2026-10-23', endDate: '2027-01-29' },
  s6: { name: 'Legacy', releaseDate: '2027-01-29', endDate: '2027-04-30' },
  s7: { name: 'The Reckoning', releaseDate: '2027-04-30', endDate: null },
  /** Play recorded before the first known street date. */
  pre: { name: 'Pre-release', releaseDate: null, endDate: '2025-10-31' },
};

/** Aliases onto the era ids above: set number, name and set code. */
const SET_ALIASES: Record<string, string> = {
  '1': 's1', origins: 's1', ogn: 's1', 'proving grounds': 's1', ogs: 's1',
  '2': 's2', spiritforged: 's2', 'spirit forged': 's2', sfd: 's2',
  '3': 's3', unleashed: 's3', unl: 's3',
  '4': 's4', vendetta: 's4', ven: 's4',
  '5': 's5', radiance: 's5', rad: 's5',
  '6': 's6', legacy: 's6',
  '7': 's7', 'the reckoning': 's7', reckoning: 's7',
};

function lookupSet(setId: string): KnownSet | undefined {
  const key = setId.trim().toLowerCase();
  return KNOWN_SETS[key] ?? KNOWN_SETS[SET_ALIASES[key] ?? ''];
}

/** Order sets newest-first where we know, then alphabetically. */
export function sortSets(sets: SetInfo[]): SetInfo[] {
  return [...sets].sort((a, b) => {
    if (a.releaseDate && b.releaseDate) return b.releaseDate.localeCompare(a.releaseDate);
    if (a.releaseDate) return -1; // dated sets first - they are the live ones
    if (b.releaseDate) return 1;
    return (a.name ?? a.setId).localeCompare(b.name ?? b.setId);
  });
}

/** Decorate a discovered set id with published boundaries, if any exist. */
export function describeSet(setId: string, hasRatingData: boolean): SetInfo {
  const known = lookupSet(setId);
  return {
    setId,
    name: known?.name ?? null,
    releaseDate: known?.releaseDate ?? null,
    endDate: known?.endDate ?? null,
    hasRatingData,
  };
}

export function describeSets(setIds: Iterable<string>): SetInfo[] {
  const seen = new Set<string>();
  const out: SetInfo[] = [];
  for (const id of setIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(describeSet(id, true));
  }
  return sortSets(out);
}

/** A display name for a set id, used where only the id is to hand. */
export function setDisplayName(setId: string): string | null {
  return lookupSet(setId)?.name ?? null;
}

export function setReleaseDate(setId: string): string | null {
  return lookupSet(setId)?.releaseDate ?? null;
}
