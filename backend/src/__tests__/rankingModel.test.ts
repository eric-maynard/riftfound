import { describe, it, expect } from 'vitest';
import {
  CONFIDENCE,
  assessConfidence,
  resolveVerdict,
  earnsPosition,
  isComparable,
  parseScope,
  isValidPlayerId,
  normaliseOutcome,
  publishesRating,
  DEFAULT_MIN_GAMES_TO_PUBLISH,
  RankingQuerySchema,
  PlayerSearchQuerySchema,
} from '../models/ranking.js';
import { describeSet, sortSets } from '../models/sets.js';
import { isSyntheticByeId } from '../models/tournament.js';

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

describe('earnsPosition', () => {
  const settled = { provisional: false, rating: 1480, componentSize: 23 };

  it('places a settled rating earned in a big enough scene', () => {
    expect(earnsPosition(settled)).toBe(true);
  });

  it('withholds a position from a provisional rating or from no rating at all', () => {
    expect(earnsPosition({ ...settled, provisional: true })).toBe(false);
    expect(earnsPosition({ ...settled, rating: null })).toBe(false);
  });

  it('withholds a position from a scene too small to order anyone', () => {
    // The rule the Global scope has to honour: a player who would get no
    // position in their own scene does not get one by being put on a bigger
    // page. 29 of the live board's 6,117 rated players are in this state.
    expect(earnsPosition({ ...settled, componentSize: CONFIDENCE.minComponentSize - 1 })).toBe(false);
    expect(earnsPosition({ ...settled, componentSize: null })).toBe(false);
    expect(earnsPosition({ ...settled, componentSize: CONFIDENCE.minComponentSize })).toBe(true);
  });

  it('is about this row alone, so mixing scenes cannot change an answer', () => {
    // There is no "and the row above it" term, by design: nothing identifies a
    // comparison between two scenes (0 of 56,257 recorded games cross one), so
    // a gate that tried to express that would have to suppress everything.
    const bay = { provisional: false, rating: 1480, componentSize: 23 };
    const singapore = { provisional: false, rating: 1534, componentSize: 4654 };
    expect([bay, singapore].map(earnsPosition)).toEqual([true, true]);
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

describe('normaliseOutcome', () => {
  it('maps Riot\'s TIE onto a draw, and DRAW too', () => {
    // The vocabulary measured over 30 live captures is WIN / LOSS / TIE; DRAW
    // never appeared once. Both are mapped anyway, because the feed that
    // produced TIE can produce DRAW on Riot's next deploy and no renderer
    // should have to care which one arrived.
    expect(normaliseOutcome('TIE')).toBe('draw');
    expect(normaliseOutcome('DRAW')).toBe('draw');
    expect(normaliseOutcome('tie')).toBe('draw');
    expect(normaliseOutcome(' Drawn ')).toBe('draw');
  });

  it('maps the win and loss spellings', () => {
    for (const win of ['WIN', 'win', 'WON', 'victory', 'W', 1, true]) {
      expect(normaliseOutcome(win)).toBe('win');
    }
    for (const loss of ['LOSS', 'lost', 'LOSE', 'defeat', 'L', 0, false]) {
      expect(normaliseOutcome(loss)).toBe('loss');
    }
  });

  it('calls anything it does not recognise unknown rather than guessing', () => {
    // A forfeit is administratively a loss, but recording it as one would be
    // this API inventing a result it was not given - the same mistake as
    // mapping only DRAW. `unknown` plus the verbatim word is the honest answer,
    // and it can never be mistaken for a played draw.
    for (const value of ['FORFEIT', 'DISQUALIFIED', 'NO_SHOW', 'PENDING', 'UNDECIDED', '', 'WINNER_TBD']) {
      expect(normaliseOutcome(value)).toBe('unknown');
    }
    expect(normaliseOutcome(null)).toBe('unknown');
    expect(normaliseOutcome(undefined)).toBe('unknown');
    expect(normaliseOutcome({ outcome: 'WIN' })).toBe('unknown');
  });
});

describe('isSyntheticByeId', () => {
  it('recognises Riot\'s bye placeholders, and nothing else', () => {
    expect(isSyntheticByeId('bye-117384287147695375-r2')).toBe(true);
    expect(isSyntheticByeId('bye-opponent-117384287147695375')).toBe(true);
    expect(isSyntheticByeId('117384287147695375')).toBe(false);
    expect(isSyntheticByeId('bye')).toBe(false);
    expect(isSyntheticByeId(null)).toBe(false);
    expect(isSyntheticByeId(undefined)).toBe(false);
  });
});

/**
 * `no-rating` must mean *no evidence*, and nothing else.
 *
 * The live bug: a refit wrote 27,318 profiles, and a known player with 6
 * recorded games and a fitted sigma of ~100 came back
 * `provisionalReason: 'no-rating'` - two games off the bar, reported as if the
 * engine had never seen them. The frontend branches on this: `too-few-games`
 * draws the "6 / 8 games" progress meter and `no-rating` draws nothing, so
 * those players got no progress indicator at all.
 */
describe('the provisional reason names the real obstacle', () => {
  const never = { rating: null, uncertainty: null, gamesPlayed: null };

  it('says no-rating only when there is no evidence at all', () => {
    expect(assessConfidence(never).provisionalReason).toBe('no-rating');
    expect(assessConfidence({ ...never, gamesPlayed: 0 }).provisionalReason).toBe('no-rating');
    expect(resolveVerdict(never).provisionalReason).toBe('no-rating');
  });

  it('says too-few-games for a known player short of the bar', () => {
    const short = { rating: 1240, uncertainty: 104, gamesPlayed: 3 };
    expect(assessConfidence(short)).toEqual({
      provisional: true,
      provisionalReason: 'too-few-games',
      gamesUntilRated: CONFIDENCE.minGames - 3,
    });
  });

  it('says too-few-games even when the rating itself is missing', () => {
    // This is the live shape: games recorded, a sigma fitted, no rating on the
    // item. The absence of a number is not the absence of evidence.
    const verdict = resolveVerdict({ rating: null, uncertainty: 100, gamesPlayed: 6 });
    expect(verdict.provisionalReason).toBe('too-few-games');
    expect(verdict.gamesUntilRated).toBe(CONFIDENCE.minGames - 6);
  });

  it('discards an engine reason of no-rating when a rating exists', () => {
    // The other half of the fall-through. The engine is the authority on *that*
    // it withheld, but it cannot be right that there is no rating for a player
    // whose rating we are holding.
    const verdict = resolveVerdict({
      rating: 1240,
      uncertainty: 104,
      gamesPlayed: 3,
      provisional: true,
      provisionalReason: 'no-rating',
    });
    expect(verdict.provisionalReason).toBe('too-few-games');
  });

  it('says uncertainty-too-wide for a known player with games but a wide sigma', () => {
    const wide = { rating: 1480, uncertainty: 210, gamesPlayed: 20 };
    expect(assessConfidence(wide).provisionalReason).toBe('uncertainty-too-wide');
    // And via the engine's own vocabulary.
    expect(
      resolveVerdict({ ...wide, provisional: true, provisionalReason: 'too-uncertain' }).provisionalReason
    ).toBe('uncertainty-too-wide');
  });

  it('still clears a player who is past both gates', () => {
    expect(assessConfidence({ rating: 1500, uncertainty: 50, gamesPlayed: 20 })).toEqual({
      provisional: false,
      provisionalReason: null,
      gamesUntilRated: 0,
    });
  });
});

describe('publishesRating - the display floor', () => {
  it('withholds at two games and publishes at three', () => {
    expect(DEFAULT_MIN_GAMES_TO_PUBLISH).toBe(3);
    expect(publishesRating(2, DEFAULT_MIN_GAMES_TO_PUBLISH)).toBe(false);
    expect(publishesRating(3, DEFAULT_MIN_GAMES_TO_PUBLISH)).toBe(true);
  });

  it('treats no games as below the floor, and honours a configured floor', () => {
    expect(publishesRating(null, DEFAULT_MIN_GAMES_TO_PUBLISH)).toBe(false);
    expect(publishesRating(undefined, DEFAULT_MIN_GAMES_TO_PUBLISH)).toBe(false);
    expect(publishesRating(0, 0)).toBe(true);
    expect(publishesRating(7, 8)).toBe(false);
  });

  it('is a different threshold from the rank gate', () => {
    // A player at 3-7 games is past the floor and short of the gate: a number
    // with a margin, and no position.
    expect(publishesRating(5, DEFAULT_MIN_GAMES_TO_PUBLISH)).toBe(true);
    expect(assessConfidence({ rating: 1300, uncertainty: 107, gamesPlayed: 5 }).provisional).toBe(true);
    expect(DEFAULT_MIN_GAMES_TO_PUBLISH).toBeLessThan(CONFIDENCE.minGames);
  });
});
