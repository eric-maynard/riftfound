import { describe, it, expect } from 'vitest';
import {
  buildEras,
  DEFAULT_PRERELEASE_OPTIONS,
  eraForDate,
  eraForEvent,
  parsePrereleaseTypes,
  parseSetTable,
  PRE_RELEASE_ERA_ID,
  setComponentScope,
  setScope,
  SET_TABLE,
  utcDate,
} from '../ranking/sets.js';

/**
 * Set partitioning.
 *
 * The property being defended here is that an **unpublished boundary stays
 * unpublished**. Riot announced sets 2 (Spirit Forged) and 3 (Unleashed) and
 * never gave them English street dates, so there is nothing to split
 * 2025-10-31..2026-07-30 on. A table that invented one would produce a
 * "Spirit Forged ladder" made of whatever happened to fall in a made-up window,
 * which is worse than saying the era covers three sets.
 */

describe('the curated set table', () => {
  it('cites a source for every entry, dated or not', () => {
    for (const set of SET_TABLE) {
      expect(set.source.length).toBeGreaterThan(0);
    }
  });

  it('carries every published English street date', () => {
    // An earlier revision recorded sets 2 and 3 as never released in English.
    // Both shipped, and the dates are corroborated by two trackers each, so a
    // null here now means only the synthetic pre-release era.
    const byId = new Map(SET_TABLE.map(set => [set.id, set]));
    expect(byId.get('1')?.releaseDate).toBe('2025-10-31');
    expect(byId.get('2')?.releaseDate).toBe('2026-02-13');
    expect(byId.get('3')?.releaseDate).toBe('2026-05-08');
    expect(byId.get('4')?.releaseDate).toBe('2026-07-31');
    expect(byId.get('5')?.releaseDate).toBe('2026-10-23');
    expect(SET_TABLE.every(set => set.source.trim().length > 0)).toBe(true);
  });
});

describe('eras', () => {
  const eras = buildEras();

  it('gives every set in the real table its own unambiguous era', () => {
    // Every set now has a date, so nothing should be lumped together.
    expect(eras.some(era => era.ambiguous)).toBe(false);
    expect(eras.map(era => era.id)).toContain('s2');
    expect(eras.map(era => era.id)).toContain('s3');
  });

  it('still folds undated sets together rather than inventing a boundary', () => {
    // The capability that mattered when sets 2-3 had no dates. Driven from an
    // override table, since the real one no longer exercises it.
    const gapped = buildEras(
      SET_TABLE.map(set => (set.id === '2' || set.id === '3' ? { ...set, releaseDate: null } : set))
    );
    const early = gapped.find(era => era.id === 's1-s3');
    expect(early).toBeDefined();
    expect(early?.ambiguous).toBe(true);
    expect(early?.setIds).toEqual(['1', '2', '3']);
    expect(early?.from).toBe('2025-10-31');
    expect(early?.to).toBe('2026-07-31');
  });

  it('gives each dated set its own unambiguous era', () => {
    const radiance = eras.find(era => era.id === 's5');
    expect(radiance).toMatchObject({
      label: 'Radiance',
      setIds: ['5'],
      from: '2026-10-23',
      to: '2027-01-29',
      ambiguous: false,
    });
  });

  it('leaves the newest era open-ended', () => {
    expect(eras[eras.length - 1].to).toBeNull();
  });

  it('covers the whole timeline with no gaps or overlaps', () => {
    for (let i = 1; i < eras.length; i++) {
      expect(eras[i].from).toBe(eras[i - 1].to);
    }
  });

  it('puts events before the first release in a pre-release era, not in set 1', () => {
    expect(eraForDate(eras, new Date('2025-06-01T12:00:00Z'))?.id).toBe(PRE_RELEASE_ERA_ID);
  });

  it('assigns an event to the era its UTC start date falls in', () => {
    expect(eraForDate(eras, new Date('2026-10-22T23:00:00Z'))?.id).toBe('s4');
    expect(eraForDate(eras, new Date('2026-10-23T00:00:00Z'))?.id).toBe('s5');
    expect(eraForDate(eras, new Date('2026-10-25T18:00:00Z'))?.id).toBe('s5');
    expect(eraForDate(eras, new Date('2027-02-01T00:00:00Z'))?.id).toBe('s6');
  });

  it('files a prerelease under the set it previews, not the outgoing one', () => {
    // A prerelease is played *with* the new set - that is the point of one - so
    // Radiance Pre-Rift play on 2026-10-17 is Radiance play even though it is
    // six days before Radiance's street date.
    const preRiftWeekend = new Date('2026-10-17T18:00:00Z');
    expect(eraForDate(eras, preRiftWeekend)?.id).toBe('s4');
    expect(eraForEvent(eras, preRiftWeekend, 'Pre-Rift')?.id).toBe('s5');

    // A non-prerelease event on the same day stays where the date puts it.
    expect(eraForEvent(eras, preRiftWeekend, 'Nexus Night')?.id).toBe('s4');
    expect(eraForEvent(eras, preRiftWeekend, null)?.id).toBe('s4');

    // Legacy's Pre-Rift is 2027-01-22..28 against a 01-29 street date.
    expect(eraForEvent(eras, new Date('2027-01-24T18:00:00Z'), 'Pre-Rift')?.id).toBe('s6');
  });

  it('does not reach back beyond the lead window', () => {
    // A Pre-Rift event two months before a release is not that set's prerelease.
    expect(eraForEvent(eras, new Date('2026-08-20T18:00:00Z'), 'Pre-Rift')?.id).toBe('s4');
    // Exactly at the window edge (14 days before 2026-10-23) it does move.
    expect(eraForEvent(eras, new Date('2026-10-09T00:00:00Z'), 'Pre-Rift')?.id).toBe('s5');
    expect(eraForEvent(eras, new Date('2026-10-08T23:59:00Z'), 'Pre-Rift')?.id).toBe('s4');
  });

  it('leaves a prerelease in the current era alone when there is no next set', () => {
    // The newest era is open-ended, so there is nothing to be a prerelease for.
    const last = eras[eras.length - 1];
    const inLast = new Date(`${last.from}T12:00:00Z`);
    expect(eraForEvent(eras, inLast, 'Pre-Rift')?.id).toBe(last.id);
  });

  it('keeps a prerelease after the street date where the date puts it', () => {
    // 320 Pre-Rift events ran on 2026-10-23..25, after Radiance was legal.
    expect(eraForEvent(eras, new Date('2026-10-24T18:00:00Z'), 'Pre-Rift')?.id).toBe('s5');
  });

  it('takes the prerelease tier names and lead window from config', () => {
    // Riot's tournamentType enum changes - Summoner Skirmish only appeared in
    // the feed once events were scheduled for it - so the names are not baked in.
    expect(parsePrereleaseTypes(undefined)).toEqual(DEFAULT_PRERELEASE_OPTIONS.prereleaseTypes);
    expect(parsePrereleaseTypes('  ')).toEqual(DEFAULT_PRERELEASE_OPTIONS.prereleaseTypes);
    expect(parsePrereleaseTypes('Pre-Rift, Launch Party')).toEqual(['Pre-Rift', 'Launch Party']);

    const custom = { prereleaseTypes: ['Launch Party'], leadDays: 3 };
    const day = new Date('2026-10-21T18:00:00Z');
    expect(eraForEvent(eras, day, 'Launch Party', custom)?.id).toBe('s5');
    expect(eraForEvent(eras, day, 'Pre-Rift', custom)?.id).toBe('s4');
    // Case-insensitive, because the enum's casing is Riot's to change.
    expect(eraForEvent(eras, day, 'launch party', custom)?.id).toBe('s5');
    // Outside the 3-day window it stays put.
    expect(eraForEvent(eras, new Date('2026-10-17T18:00:00Z'), 'Launch Party', custom)?.id).toBe('s4');
  });

  it('splits an ambiguous era as soon as a real date is published', () => {
    // Start from a table where 2-3 are undated, then publish them.
    const corrected = buildEras(
      SET_TABLE.map(set =>
        set.id === '2' ? { ...set, releaseDate: '2026-01-30' } : set.id === '3' ? { ...set, releaseDate: '2026-04-24' } : set
      )
    );
    expect(corrected.map(era => era.id)).toContain('s1');
    expect(corrected.map(era => era.id)).toContain('s2');
    expect(corrected.map(era => era.id)).toContain('s3');
    expect(corrected.map(era => era.id)).not.toContain('s1-s3');
    expect(eraForDate(corrected, new Date('2026-02-14T00:00:00Z'))?.label).toBe('Spiritforged');
  });
});

describe('the RANKING_SET_TABLE override', () => {
  it('accepts a replacement table', () => {
    const { table, warning } = parseSetTable(
      JSON.stringify([{ id: '9', name: 'Test Set', releaseDate: '2027-09-01', source: 'test' }])
    );
    expect(warning).toBeUndefined();
    expect(table).toHaveLength(1);
    expect(buildEras(table).find(era => era.id === 's9')?.label).toBe('Test Set');
  });

  it('falls back to the curated table rather than failing the pass', () => {
    // A bad override must not take the rating pass down, and must not silently
    // become "no sets at all" either.
    for (const bad of ['{', '[]', '{"not":"an array"}', '[{"id":1}]', '[{"id":"9","name":"x","releaseDate":"nope"}]']) {
      const { table, warning } = parseSetTable(bad);
      expect(warning).toBeDefined();
      expect(table).toBe(SET_TABLE);
    }
  });

  it('passes an absent override straight through', () => {
    expect(parseSetTable(undefined).table).toBe(SET_TABLE);
    expect(parseSetTable('  ').table).toBe(SET_TABLE);
  });
});

describe('scope strings', () => {
  it('are the ones the output contract names', () => {
    expect(setScope('s5')).toBe('set:s5');
    expect(setComponentScope('s5', 'cabc123')).toBe('set:s5#component:cabc123');
  });

  it('use UTC days, matching the fact rows GSI1 partitions', () => {
    expect(utcDate(new Date('2026-10-25T23:59:59Z'))).toBe('2026-10-25');
    expect(utcDate(new Date('2026-10-26T00:00:01Z'))).toBe('2026-10-26');
  });
});
