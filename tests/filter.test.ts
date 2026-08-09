import { describe, it, expect } from 'vitest';
import { createdAfterFloor, matchesTitleFilter } from '../src/sync/filter';
import type { MeetingRow } from '../src/types';

const M: MeetingRow = {
  id: 'm', title: 'Weekly Sync with Finance', notes: null, summary: null, speakerMap: null,
  createdAt: '2026-08-06 14:05:09.000 +00:00', modifiedAt: '2026-08-06 14:30:00.000 +00:00',
  endedAt: null, isDeleted: 0, finalized: 1,
};
const NOW = Date.parse('2026-08-08T00:00:00.000Z');

describe('createdAfterFloor', () => {
  it('returns null for 0, meaning no limit', () => {
    expect(createdAfterFloor(0, NOW)).toBeNull();
  });
  it('returns a Wispr-format timestamp N days back', () => {
    expect(createdAfterFloor(7, NOW)).toBe('2026-08-01 00:00:00.000 +00:00');
  });
  it('treats negative and non-finite values as no limit', () => {
    expect(createdAfterFloor(-5, NOW)).toBeNull();
    expect(createdAfterFloor(Number.NaN, NOW)).toBeNull();
    expect(createdAfterFloor(Number.POSITIVE_INFINITY, NOW)).toBeNull();
  });
  it('handles a fractional day count by flooring to whole days', () => {
    expect(createdAfterFloor(1.9, NOW)).toBe('2026-08-07 00:00:00.000 +00:00');
  });
  it('returns null for absurdly large daysBack to avoid lexicographic sort failure', () => {
    // year 1000 is the boundary; 375000 days back from 2026 is year ~650
    expect(createdAfterFloor(375000, NOW)).toBeNull();
  });
  it('returns well-formed string just before year-1000 boundary and null beyond it', () => {
    // 374000 days back stays well above year 1000 (reaches ~1020)
    const wellAbove = createdAfterFloor(374000, NOW);
    expect(wellAbove).not.toBeNull();
    expect(wellAbove).toMatch(/^\d{4}-\d{2}-\d{2} 00:00:00\.000 \+00:00$/);
    // 386000 days back crosses into year 999 (= year < 1000), which returns null
    const belowBoundary = createdAfterFloor(386000, NOW);
    expect(belowBoundary).toBeNull();
  });
  it('produces timestamps matching fixed-width format for a range of inputs', () => {
    const format = /^\d{4}-\d{2}-\d{2} 00:00:00\.000 \+00:00$/;
    for (const days of [1, 7, 365, 3650, 36500]) {
      const result = createdAfterFloor(days, NOW);
      expect(result).not.toBeNull();
      expect(result).toMatch(format);
    }
  });
  it('handles edge-case nowMs values without producing a malformed string', () => {
    // nowMs = 0 is 1970-01-01; going back 1 day reaches 1969-12-31 (year 1969, valid)
    const zeroNow = createdAfterFloor(1, 0);
    expect(zeroNow).toMatch(/^\d{4}-\d{2}-\d{2} 00:00:00\.000 \+00:00$/);
    // Negative nowMs is before 1970; any small daysBack still stays well above year 1000
    const negNow = createdAfterFloor(1, -86_400_000);
    // This produces year 1969, which is valid (>= 1000)
    expect(negNow).toMatch(/^\d{4}-\d{2}-\d{2} 00:00:00\.000 \+00:00$/);
  });
  it('asserts the INVARIANT: for any daysBack, returns null or well-formed string', () => {
    // Table-driven test over a spread of daysBack values including extremes and edge cases
    const format = /^\d{4}-\d{2}-\d{2} 00:00:00\.000 \+00:00$/;
    const testCases = [
      1,
      7,
      365,
      36500,
      100000,
      375000,
      1e9,
      Number.MAX_SAFE_INTEGER,
      0.5,
      1.9,
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];
    for (const daysBack of testCases) {
      const result = createdAfterFloor(daysBack, NOW);
      // Invariant: result is null or matches the fixed-width format — nothing else
      expect(result === null || result.match(format)).toBeTruthy();
    }
  });
  it('asserts the INVARIANT: for any nowMs, returns null or well-formed string', () => {
    // Table-driven test over a spread of nowMs values including extremes
    const format = /^\d{4}-\d{2}-\d{2} 00:00:00\.000 \+00:00$/;
    const testCases = [
      0,
      -1,
      -1e12,
      Date.now(),
      8.64e15,
      -8.64e15,
      Number.NaN,
    ];
    for (const nowMs of testCases) {
      // Use a moderate daysBack value (7) to isolate nowMs behavior
      const result = createdAfterFloor(7, nowMs);
      // Invariant: result is null or matches the fixed-width format — nothing else
      expect(result === null || result.match(format)).toBeTruthy();
    }
  });
});

describe('matchesTitleFilter', () => {
  it('passes everything when disabled', () => {
    expect(matchesTitleFilter(M, 'disabled', 'anything')).toBe(true);
    expect(matchesTitleFilter({ ...M, title: null }, 'disabled', '')).toBe(true);
  });
  it('include keeps only titles containing the keyword, case-insensitively', () => {
    expect(matchesTitleFilter(M, 'include', 'finance')).toBe(true);
    expect(matchesTitleFilter(M, 'include', 'FINANCE')).toBe(true);
    expect(matchesTitleFilter(M, 'include', 'legal')).toBe(false);
  });
  it('exclude drops titles containing the keyword', () => {
    expect(matchesTitleFilter(M, 'exclude', 'finance')).toBe(false);
    expect(matchesTitleFilter(M, 'exclude', 'legal')).toBe(true);
  });
  it('treats an empty or whitespace keyword as disabled, so nothing is lost by accident', () => {
    expect(matchesTitleFilter(M, 'include', '')).toBe(true);
    expect(matchesTitleFilter(M, 'include', '   ')).toBe(true);
    expect(matchesTitleFilter(M, 'exclude', '')).toBe(true);
  });
  it('treats a null or empty title as not containing the keyword', () => {
    expect(matchesTitleFilter({ ...M, title: null }, 'include', 'sync')).toBe(false);
    expect(matchesTitleFilter({ ...M, title: null }, 'exclude', 'sync')).toBe(true);
  });
});
