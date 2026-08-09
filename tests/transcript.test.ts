import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseNdjson, readTranscript } from '../src/wispr/transcript';

const fixture = (n: string) => readFileSync(resolve('tests/fixtures', n), 'utf8');

describe('parseNdjson', () => {
  it('parses well-formed transcripts', () => {
    const { segments, skipped } = parseNdjson(fixture('refined.ndjson'));
    expect(segments).toHaveLength(3);
    expect(skipped).toBe(0);
    expect(segments[0]).toEqual({ timestamp: '00:00', text: 'First line.', speakerId: 1 });
  });

  it('trims surrounding whitespace in text', () => {
    expect(parseNdjson(fixture('refined.ndjson')).segments[1].text).toBe('Second line with padding.');
  });

  it('skips the meta header, blank, broken and truncated lines but keeps good ones', () => {
    const { segments, skipped } = parseNdjson(fixture('malformed.ndjson'));
    expect(segments.map((s) => s.text)).toEqual(['Good line.', 'Last good line.']);
    // broken json, missing text, truncated line
    expect(skipped).toBe(3);
  });

  it('returns empty for empty input', () => {
    expect(parseNdjson('')).toEqual({ segments: [], skipped: 0 });
    expect(parseNdjson('\n\n')).toEqual({ segments: [], skipped: 0 });
  });

  it('treats a missing speaker id as unattributed rather than skipping', () => {
    const line = '{"timestamp":"00:01","text":"No speaker key"}';
    const { segments, skipped } = parseNdjson(line);
    expect(segments).toEqual([{ timestamp: '00:01', text: 'No speaker key', speakerId: null }]);
    expect(skipped).toBe(0);
  });

  it('skips a marker line without incrementing skipped', () => {
    const line = '{"id":"marker-1785848634795-paused","timestamp":"6:03 PM","marker":"paused","epochMs":1785848634795,"segment":0}';
    const { segments, skipped } = parseNdjson(line);
    expect(segments).toHaveLength(0);
    expect(skipped).toBe(0);
  });

  it('counts a line with neither text nor marker as skipped', () => {
    const line = '{"id":"b3","timestamp":"0:07","speaker":{"id":1}}';
    const { segments, skipped } = parseNdjson(line);
    expect(segments).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it('skips marker lines in mixed transcript without miscounting', () => {
    const { segments, skipped } = parseNdjson(fixture('malformed.ndjson'));
    expect(segments.map((s) => s.text)).toEqual(['Good line.', 'Last good line.']);
    // broken json, missing text, truncated line (marker line is skipped silently)
    expect(skipped).toBe(3);
  });

  it('keeps a line that has BOTH a marker key and valid text', () => {
    const line = '{"timestamp":"0:05","text":"Real speech here.","marker":"paused","speaker":{"id":1}}';
    const { segments, skipped } = parseNdjson(line);
    expect(segments).toEqual([{ timestamp: '0:05', text: 'Real speech here.', speakerId: 1 }]);
    expect(skipped).toBe(0);
  });

  it('still skips a marker line that has no text, without counting it', () => {
    const line = '{"id":"marker-1","timestamp":"6:03 PM","marker":"paused","epochMs":1,"segment":0}';
    expect(parseNdjson(line)).toEqual({ segments: [], skipped: 0 });
  });
});

describe('readTranscript', () => {
  it('returns empty when the meeting directory does not exist', async () => {
    const r = await readTranscript(resolve('tests/fixtures'), 'no-such-meeting', 'refined');
    expect(r).toEqual({ segments: [], skipped: 0 });
  });
});
