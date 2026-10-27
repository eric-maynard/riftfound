import { describe, expect, it } from 'vitest';
import { carryPreview, isRankingsPreview } from '../preview';

const ON = '?preview=rankings';
const LEGACY = '?preview=ranking';

describe('isRankingsPreview', () => {
  it('accepts the plural flag and the singular link handed out before the rename', () => {
    expect(isRankingsPreview(ON)).toBe(true);
    expect(isRankingsPreview(LEGACY)).toBe(true);
    expect(isRankingsPreview('?set=OGN&preview=rankings')).toBe(true);
  });

  it('is false for no flag, another value, and the off switch', () => {
    expect(isRankingsPreview('')).toBe(false);
    expect(isRankingsPreview('?set=OGN')).toBe(false);
    expect(isRankingsPreview('?preview=off')).toBe(false);
    expect(isRankingsPreview('?preview=')).toBe(false);
  });
});

describe('carryPreview', () => {
  it('returns the target untouched when there is nothing to carry', () => {
    // Character for character, so every link in the app can be wrapped
    // unconditionally without changing a single URL outside the preview.
    expect(carryPreview('/rankings', '')).toBe('/rankings');
    expect(carryPreview('/rankings?set=OGN', '?lat=37.77')).toBe('/rankings?set=OGN');
    expect(carryPreview('', '?preview=off')).toBe('');
  });

  it('adds the flag to a bare path', () => {
    expect(carryPreview('/rankings', ON)).toBe('/rankings?preview=rankings');
    expect(carryPreview('/', ON)).toBe('/?preview=rankings');
  });

  it('merges into a query string the target already has', () => {
    expect(carryPreview('/rankings?set=OGN', ON)).toBe('/rankings?set=OGN&preview=rankings');
    expect(carryPreview('/rankings?set=OGN&region=c12', ON)).toBe(
      '/rankings?set=OGN&region=c12&preview=rankings',
    );
  });

  it('is idempotent', () => {
    // The mode switch stores a search string that has already been through
    // here, so a second pass must not stack a second `preview`.
    const once = carryPreview('/rankings?set=OGN', ON);
    expect(carryPreview(once, ON)).toBe(once);
    expect(carryPreview(carryPreview('/rankings', ON), ON)).toBe('/rankings?preview=rankings');
  });

  it('keeps the legacy singular value rather than upgrading it', () => {
    // Someone following an old link stays on the value they followed: if that
    // ever stops being honoured the link breaks at its source, not three hops
    // in, where the failure would be unexplainable.
    expect(carryPreview('/rankings', LEGACY)).toBe('/rankings?preview=ranking');
    expect(carryPreview('/rankings?set=OGN', LEGACY)).toBe('/rankings?set=OGN&preview=ranking');
  });

  it('does not clobber a preview the target names itself', () => {
    expect(carryPreview('/rankings?preview=ranking', ON)).toBe('/rankings?preview=ranking');
    expect(carryPreview('/rankings?preview=off', ON)).toBe('/rankings?preview=off');
  });

  it('treats an empty target as the current path, and never emits a bare ?', () => {
    // Layout hands over each section's remembered `location.search`, which
    // starts out empty - the reported bug - and may be a query string alone.
    expect(carryPreview('', ON)).toBe('?preview=rankings');
    expect(carryPreview('?set=OGN', ON)).toBe('?set=OGN&preview=rankings');
    expect(carryPreview('?', ON)).toBe('?preview=rankings');
    expect(carryPreview('/rankings?', ON)).toBe('/rankings?preview=rankings');
  });

  it('leaves the hash at the end', () => {
    expect(carryPreview('/rankings#scenes', ON)).toBe('/rankings?preview=rankings#scenes');
    expect(carryPreview('/rankings?set=OGN#scenes', ON)).toBe(
      '/rankings?set=OGN&preview=rankings#scenes',
    );
  });

  it('encodes what URLSearchParams encodes, and nothing is lost', () => {
    const carried = carryPreview('/rankings/players/NA1%23tag?set=OGN', ON);
    expect(new URLSearchParams(carried.slice(carried.indexOf('?'))).get('set')).toBe('OGN');
    expect(isRankingsPreview(carried.slice(carried.indexOf('?')))).toBe(true);
  });
});
