import { describe, it, expect } from 'vitest';
import {
  CONFIDENCE,
  assessConfidence,
  resolveVerdict,
  isComparable,
  parseScope,
  isValidPlayerId,
  RankingQuerySchema,
  PlayerSearchQuerySchema,
} from '../models/ranking.js';
import { describeSet, sortSets } from '../models/sets.js';

describe('parseScope', () => {
  it('treats a missing or empty scope as all-sets', () => {
    for (const input of [undefined, '', '  ', 'all']) {
      expect(parseScope(input)).toEqual({ raw: 'all', setId: null, componentId: null });
    }
  });

  it('parses each shape the contract defines', () => {
    expect(parseScope('set:radiance')).toEqual({ raw: 'set:radiance', setId: 'radiance', componentId: null });
    expect(parseScope('component:c-bay')).toEqual({ raw: 'component:c-bay', setId: null, componentId: 'c-bay' });
    expect(parseScope('set:radiance#component:c-bay')).toEqual({
      raw: 'set:radiance#component:c-bay',
      setId: 'radiance',
      componentId: 'c-bay',
    });
  });

  it('canonicalises part order so one logical scope has one key', () => {
    expect(parseScope('component:c-bay#set:radiance')?.raw).toBe('set:radiance#component:c-bay');
  });

  it('rejects anything that could not be a key', () => {
    for (const input of ['set:', 'set', 'nonsense', 'set:a#set:b', 'component:a#component:b', 'set:../../etc']) {
      expect(parseScope(input)).toBeNull();
    }
  });
});

describe('assessConfidence', () => {
  it('withholds a rating a player has too few games for', () => {
    const verdict = assessConfidence({ rating: 1500, uncertainty: 80, gamesPlayed: 3 });
    expect(verdict.provisional).toBe(true);
    expect(verdict.provisionalReason).toBe('too-few-games');
    expect(verdict.gamesUntilRated).toBe(CONFIDENCE.minGames - 3);
  });

  it('withholds a rating whose uncertainty is still too wide', () => {
    const verdict = assessConfidence({
      rating: 1500,
      uncertainty: CONFIDENCE.maxUncertainty + 1,
      gamesPlayed: CONFIDENCE.minGames,
    });
    expect(verdict.provisional).toBe(true);
    expect(verdict.provisionalReason).toBe('uncertainty-too-wide');
  });

  it('reports a player the engine has not rated at all', () => {
    const verdict = assessConfidence({ rating: null, uncertainty: null, gamesPlayed: 0 });
    expect(verdict.provisionalReason).toBe('no-rating');
    expect(verdict.gamesUntilRated).toBe(CONFIDENCE.minGames);
  });

  it('publishes a rating that clears both gates', () => {
    const verdict = assessConfidence({ rating: 1500, uncertainty: 80, gamesPlayed: CONFIDENCE.minGames });
    expect(verdict).toEqual({ provisional: false, provisionalReason: null, gamesUntilRated: 0 });
  });

  it('treats a missing uncertainty as not disqualifying', () => {
    expect(assessConfidence({ rating: 1500, uncertainty: null, gamesPlayed: 20 }).provisional).toBe(false);
  });
});

describe('resolveVerdict', () => {
  const rated = { rating: 1500, uncertainty: 80, gamesPlayed: 20 };
  const thin = { rating: 1500, uncertainty: 240, gamesPlayed: 2 };

  it('falls back to the derived verdict for an item with no verdict on it', () => {
    expect(resolveVerdict(thin)).toEqual(assessConfidence(thin));
    expect(resolveVerdict(rated)).toEqual(assessConfidence(rated));
  });

  it('withholds when the engine says so, even where the numbers look fine', () => {
    const verdict = resolveVerdict({ ...rated, provisional: true, provisionalReason: 'too-uncertain' });
    expect(verdict.provisional).toBe(true);
    // The engine's vocabulary, translated into the one this API publishes.
    expect(verdict.provisionalReason).toBe('uncertainty-too-wide');
  });

  it('publishes when the engine says so, even where the numbers look thin', () => {
    expect(resolveVerdict({ ...thin, provisional: false, provisionalReason: null })).toEqual({
      provisional: false,
      provisionalReason: null,
      gamesUntilRated: 0,
    });
  });

  it('takes the engine\'s own games-to-go when it states one', () => {
    expect(
      resolveVerdict({ ...thin, provisional: true, provisionalReason: 'too-few-games', gamesUntilRated: 5 })
        .gamesUntilRated
    ).toBe(5);
    // ...and derives one when the engine leaves it null (it only sets it when
    // games are what is missing).
    expect(
      resolveVerdict({ ...thin, provisional: true, provisionalReason: 'too-few-games', gamesUntilRated: null })
        .gamesUntilRated
    ).toBe(CONFIDENCE.minGames - 2);
  });

  it('never calls a rating that does not exist publishable', () => {
    expect(
      resolveVerdict({ rating: null, uncertainty: 80, gamesPlayed: 20, provisional: false, provisionalReason: null })
    ).toMatchObject({ provisional: true, provisionalReason: 'no-rating' });
  });

  it('always gives a reason for a withheld rating, even for a reason it has never heard of', () => {
    const verdict = resolveVerdict({ ...rated, provisional: true, provisionalReason: 'component-too-small' });
    expect(verdict.provisional).toBe(true);
    // Not `too-few-games`: this player has plenty, and that reason would put a
    // full progress meter beside the word "Unranked".
    expect(verdict.provisionalReason).toBe('uncertainty-too-wide');
  });
});

describe('isComparable', () => {
  it('calls a component too small to order anyone not comparable', () => {
    expect(isComparable(CONFIDENCE.minComponentSize - 1)).toBe(false);
    expect(isComparable(null)).toBe(false);
    expect(isComparable(CONFIDENCE.minComponentSize)).toBe(true);
  });
});

describe('set catalogue', () => {
  it('resolves a set code to its name and published release date', () => {
    // Origins' English launch is published (2025-10-31); an earlier revision of
    // the catalogue wrongly recorded it, and sets 2-3, as having no date.
    expect(describeSet('ogn', true)).toMatchObject({
      setId: 'ogn',
      name: 'Origins',
      releaseDate: '2025-10-31',
    });
  });

  it('resolves the engine\'s era ids, not just set names and codes', () => {
    // The engine emits `s4`/`s5`; the catalogue used to key only on names, so
    // every set came back unnamed with no release date.
    expect(describeSet('s4', true)).toMatchObject({ name: 'Vendetta', releaseDate: '2026-07-31' });
    expect(describeSet('s5', true)).toMatchObject({ name: 'Radiance', releaseDate: '2026-10-23' });
    expect(describeSet('5', true)).toMatchObject({ name: 'Radiance' });
  });

  it('still reports null for the synthetic pre-release era', () => {
    expect(describeSet('pre', true)).toMatchObject({ releaseDate: null });
  });

  it('passes an unknown set id through without inventing a name or date', () => {
    expect(describeSet('set-99', true)).toEqual({
      setId: 'set-99',
      name: null,
      releaseDate: null,
      endDate: null,
      hasRatingData: true,
    });
  });

  it('sorts dated sets ahead of undated ones', () => {
    const sorted = sortSets([describeSet('ogn', true), describeSet('radiance', true), describeSet('zzz', true)]);
    expect(sorted.map((set) => set.setId)).toEqual(['radiance', 'ogn', 'zzz']);
  });
});

describe('query schemas', () => {
  it('defaults the ranking limit and rejects an oversized one', () => {
    expect(RankingQuerySchema.parse({}).limit).toBe(25);
    expect(RankingQuerySchema.safeParse({ limit: '500' }).success).toBe(false);
    expect(RankingQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  });

  it('rejects a malformed cursor', () => {
    expect(RankingQuerySchema.safeParse({ cursor: 'abc$%^' }).success).toBe(false);
    expect(RankingQuerySchema.safeParse({ cursor: 'aGVsbG8' }).success).toBe(true);
  });

  it('requires a search term long enough to be a search', () => {
    expect(PlayerSearchQuerySchema.safeParse({ q: 'k' }).success).toBe(false);
    expect(PlayerSearchQuerySchema.safeParse({ q: 'ki' }).success).toBe(true);
  });
});

describe('isValidPlayerId', () => {
  it('accepts uuids and fixture ids, rejects key-escaping input', () => {
    expect(isValidPlayerId('3f9a1b2c-1111-2222-3333-444455556666')).toBe(true);
    expect(isValidPlayerId('p-kira')).toBe(true);
    expect(isValidPlayerId('PLAYER#x')).toBe(false);
    expect(isValidPlayerId('../other')).toBe(false);
    expect(isValidPlayerId('')).toBe(false);
  });
});
