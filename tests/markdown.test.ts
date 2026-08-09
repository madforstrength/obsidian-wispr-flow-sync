import { describe, it, expect } from 'vitest';
import { parseWisprDate, wisprDateToEpoch, formatDuration, renderNote, renderTranscript, renderTranscriptBody } from '../src/render/markdown';
import { sanitizeFilename } from '../src/render/paths';
import { resolveSpeakers } from '../src/wispr/speakers';
import type { MeetingRow, TranscriptSegment } from '../src/types';

const SPEAKERS = resolveSpeakers(JSON.stringify({
  people: { p1: { name: 'Muhammad Bilal' }, p2: { name: 'Umair Qaiser' } },
  assignments: { '1': { user: 'p1' }, '2': { user: 'p2' } },
}));

const MEETING: MeetingRow = {
  id: 'dba862c8-cb7a-4a97-9e8b-fca581b43d99',
  title: 'Mediware Deployment',
  notes: ':::toggle\n## Flow Summary\n\nDebugged the count gap. <@speaker:2> asked <@speaker:1> to dig in.\n:::\n\n### Count Discrepancy\n- Eligible = 4, pre-auth = 3\n',
  summary: 'Debugged the count gap.',
  speakerMap: null,
  createdAt: '2026-08-06 06:51:41.341 +00:00',
  modifiedAt: '2026-08-06 07:24:11.817 +00:00',
  endedAt: 1785999451817,
  isDeleted: 0,
  finalized: 1,
};

const OPTS = { resolveSpeakerNames: true, summaryMode: 'callout' as const };

describe('parseWisprDate', () => {
  it('parses Wispr\'s space-separated offset format', () => {
    expect(parseWisprDate('2026-08-06 06:51:41.341 +00:00')?.toISOString())
      .toBe('2026-08-06T06:51:41.341Z');
  });
  it('returns null for null or unparseable input', () => {
    expect(parseWisprDate(null)).toBeNull();
    expect(parseWisprDate('not a date')).toBeNull();
    expect(parseWisprDate('')).toBeNull();
  });
});

describe('wisprDateToEpoch', () => {
  it('converts a Wispr timestamp to epoch milliseconds', () => {
    expect(wisprDateToEpoch('2026-08-06 06:51:41.341 +00:00')).toBe(
      Date.parse('2026-08-06T06:51:41.341Z')
    );
  });
  it('compares correctly ACROSS differing UTC offsets', () => {
    // 08:00 -05:00 is 13:00Z, which is LATER than 12:00Z — lexicographic
    // string comparison gets this backwards.
    const earlier = wisprDateToEpoch('2026-08-06 12:00:00.000 +00:00')!;
    const later = wisprDateToEpoch('2026-08-06 08:00:00.000 -05:00')!;
    expect(later).toBeGreaterThan(earlier);
    expect('2026-08-06 08:00:00.000 -05:00' > '2026-08-06 12:00:00.000 +00:00').toBe(false);
  });
  it('returns null for null or unparseable input', () => {
    expect(wisprDateToEpoch(null)).toBeNull();
    expect(wisprDateToEpoch('')).toBeNull();
    expect(wisprDateToEpoch('not a date')).toBeNull();
  });
});

describe('formatDuration', () => {
  it('formats minutes and hours', () => {
    expect(formatDuration(0, 350_000)).toBe('5m');
    expect(formatDuration(0, 3_960_000)).toBe('1h 6m');
    expect(formatDuration(0, 30_000)).toBe('1m');
  });
});

describe('renderNote', () => {
  it('writes wispr_id and core frontmatter', () => {
    const md = renderNote(MEETING, SPEAKERS, OPTS);
    expect(md).toContain('wispr_id: dba862c8-cb7a-4a97-9e8b-fca581b43d99');
    expect(md).toContain('title: Mediware Deployment');
    expect(md).toContain('type: note');
    expect(md).toContain('source: wispr-flow');
    expect(md).toContain('created: 2026-08-06T06:51:41.341Z');
  });

  it('converts :::toggle into a collapsible callout', () => {
    const md = renderNote(MEETING, SPEAKERS, OPTS);
    expect(md).toContain('> [!summary]- Flow Summary');
    expect(md).not.toContain(':::');
  });

  it('resolves speaker placeholders to names', () => {
    const md = renderNote(MEETING, SPEAKERS, OPTS);
    expect(md).toContain('Umair Qaiser asked Muhammad Bilal');
    expect(md).not.toContain('<@speaker:');
  });

  it('keeps placeholders when name resolution is disabled', () => {
    const md = renderNote(MEETING, SPEAKERS, { ...OPTS, resolveSpeakerNames: false });
    expect(md).toContain('<@speaker:2>');
  });

  it('lists resolved speakers in frontmatter', () => {
    const md = renderNote(MEETING, SPEAKERS, OPTS);
    expect(md).toContain('speakers:\n  - Muhammad Bilal\n  - Umair Qaiser');
  });

  it('quotes titles containing YAML-significant characters', () => {
    const md = renderNote({ ...MEETING, title: 'Q3: budget, "final"' }, SPEAKERS, OPTS);
    expect(md).toContain('title: "Q3: budget, \\"final\\""');
  });

  it('collapses a newline in the title to a space instead of emitting it raw (fix 1)', () => {
    const md = renderNote({ ...MEETING, title: 'Line one\nLine two' }, SPEAKERS, OPTS);
    const lines = md.split('\n');
    const titleLine = lines.find((l) => l.startsWith('title:'));
    expect(titleLine).toBe('title: Line one Line two');
    // The frontmatter block must still have exactly its opening and closing
    // delimiters, with the title fully contained on its own line between them.
    const openIdx = lines.indexOf('---');
    const closeIdx = lines.indexOf('---', openIdx + 1);
    expect(openIdx).toBe(0);
    expect(closeIdx).toBeGreaterThan(openIdx);
    expect(lines.slice(openIdx, closeIdx + 1)).toContain('title: Line one Line two');
  });

  it('collapses \\r\\n and tab characters in the title to single spaces (fix 1)', () => {
    const crlf = renderNote({ ...MEETING, title: 'Crlf one\r\nCrlf two' }, SPEAKERS, OPTS);
    expect(crlf).toContain('title: Crlf one Crlf two');
    expect(crlf).not.toMatch(/title:.*\r/);

    const tabbed = renderNote({ ...MEETING, title: 'Tab\tSeparated' }, SPEAKERS, OPTS);
    expect(tabbed).toContain('title: Tab Separated');
  });

  it('collapses vertical tab and form feed characters in the title to single spaces, and the frontmatter still round-trips', () => {
    const md = renderNote({ ...MEETING, title: 'Vtab\x0BForm\x0CFeed' }, SPEAKERS, OPTS);
    const lines = md.split('\n');
    const titleLine = lines.find((l) => l.startsWith('title:'));
    expect(titleLine).toBe('title: Vtab Form Feed');
    expect(md).not.toMatch(/title:.*[\x0B\x0C]/);

    const openIdx = lines.indexOf('---');
    const closeIdx = lines.indexOf('---', openIdx + 1);
    const frontmatterBlock = lines.slice(openIdx, closeIdx + 1).join('\n');
    const match = frontmatterBlock.match(/^wispr_id: (.+)$/m);
    expect(match?.[1]).toBe('dba862c8-cb7a-4a97-9e8b-fca581b43d99');
  });

  it('seam guard: filename and frontmatter title agree on vertical tab / form feed handling (fix round 1)', () => {
    // yamlScalar (this module) and sanitizeFilename (paths.ts) must treat
    // \x0B and \x0C identically — both collapse to a space — or the same
    // title renders as two different strings depending which module touched
    // it. This test exercises BOTH modules in one assertion so a future
    // divergence between them fails loudly here.
    const rawTitle = 'A\x0BB\x0CC';
    const filename = sanitizeFilename(rawTitle);

    const md = renderNote({ ...MEETING, title: rawTitle }, SPEAKERS, OPTS);
    const lines = md.split('\n');
    const titleLine = lines.find((l) => l.startsWith('title:'))!;
    const frontmatterTitle = titleLine.slice('title: '.length);

    expect(filename).toBe('A B C');
    expect(frontmatterTitle).toBe('A B C');
    expect(filename).toBe(frontmatterTitle);

    // Round-trip guard: the frontmatter must still be parseable.
    const openIdx = lines.indexOf('---');
    const closeIdx = lines.indexOf('---', openIdx + 1);
    const frontmatterBlock = lines.slice(openIdx, closeIdx + 1).join('\n');
    const match = frontmatterBlock.match(/^wispr_id: (.+)$/m);
    expect(match?.[1]).toBe('dba862c8-cb7a-4a97-9e8b-fca581b43d99');
  });

  it('control-character contract: filename and frontmatter agree exactly, for every control code (fix round 2)', () => {
    // This is the complete contract, checked in one table-driven test instead
    // of one test per character, precisely because splitting it by character
    // is what let it drift twice already (fix rounds 1 and this one):
    //   1. Whitespace-like controls (TAB, LF, VT, FF, CR) collapse to a
    //      single space, in both sanitizeFilename (paths.ts) and yamlScalar
    //      (this module).
    //   2. Every other C0/C1 control (NUL, and friends) is deleted entirely,
    //      in both places — a raw control byte surviving into YAML
    //      frontmatter is unparseable, which makes wispr_id unreadable and
    //      turns every future sync into a silent, permanent duplicate-note
    //      generator (src/main.ts builds its vault index by regex-matching
    //      `^wispr_id: (.+)$` against frontmatter read back from disk).
    /* eslint-disable-next-line no-control-regex -- deliberately checking for stripped controls */
    const ANY_CONTROL = /[\x00-\x08\x0E-\x1F\x7F-\x9F]/;
    const ID = 'dba862c8-cb7a-4a97-9e8b-fca581b43d99';

    function frontmatterBlockAndTitle(rawTitle: string) {
      const md = renderNote({ ...MEETING, title: rawTitle }, SPEAKERS, OPTS);
      const lines = md.split('\n');
      const openIdx = lines.indexOf('---');
      const closeIdx = lines.indexOf('---', openIdx + 1);
      const frontmatterBlock = lines.slice(openIdx, closeIdx + 1).join('\n');
      const titleLine = lines.find((l) => l.startsWith('title:'))!;
      return { frontmatterBlock, frontmatterTitle: titleLine.slice('title: '.length) };
    }

    const whitespaceLike: Array<[string, string]> = [
      ['TAB', '\x09'], ['LF', '\x0A'], ['VT', '\x0B'], ['FF', '\x0C'], ['CR', '\x0D'],
    ];
    for (const [name, ch] of whitespaceLike) {
      const rawTitle = `A${ch}B`;
      const filename = sanitizeFilename(rawTitle);
      const { frontmatterBlock, frontmatterTitle } = frontmatterBlockAndTitle(rawTitle);

      expect(filename, `${name}: filename`).toBe('A B');
      expect(frontmatterTitle, `${name}: frontmatter title`).toBe('A B');
      expect(filename, `${name}: filename === frontmatter title`).toBe(frontmatterTitle);
      expect(frontmatterBlock.match(/^wispr_id: (.+)$/m)?.[1], `${name}: wispr_id round-trip`).toBe(ID);
    }

    const unprintable: Array<[string, string]> = [
      ['NUL', '\x00'], ['SOH', '\x01'], ['BEL', '\x07'], ['US', '\x1F'], ['DEL', '\x7F'],
    ];
    for (const [name, ch] of unprintable) {
      const rawTitle = `A${ch}B`;
      const filename = sanitizeFilename(rawTitle);
      const { frontmatterBlock, frontmatterTitle } = frontmatterBlockAndTitle(rawTitle);

      expect(filename, `${name}: filename`).toBe('AB');
      expect(frontmatterTitle, `${name}: frontmatter title`).toBe('AB');
      expect(filename, `${name}: filename === frontmatter title`).toBe(frontmatterTitle);
      // Not just the title line — no control byte anywhere in the block.
      expect(ANY_CONTROL.test(frontmatterBlock), `${name}: no stray control byte anywhere in frontmatter`).toBe(false);
      expect(frontmatterBlock.match(/^wispr_id: (.+)$/m)?.[1], `${name}: wispr_id round-trip`).toBe(ID);
    }

    // Speaker names flow into the `speakers:` YAML list through the same
    // yamlScalar, so they must be sanitised identically there. (A meeting's
    // note BODY also substitutes speaker names via a separate, unsanitised
    // path — that's plain markdown prose, not YAML, so it is out of scope
    // for this contract; only the frontmatter block is checked here.)
    const speakersWithControl = new Map([[1, 'A\x07B'], [2, 'Umair Qaiser']]);
    const md = renderNote({ ...MEETING, notes: 'No speaker tokens here.' }, speakersWithControl, OPTS);
    expect(md).toContain('speakers:\n  - AB\n  - Umair Qaiser');
    const lines = md.split('\n');
    const openIdx = lines.indexOf('---');
    const closeIdx = lines.indexOf('---', openIdx + 1);
    const frontmatterBlock = lines.slice(openIdx, closeIdx + 1).join('\n');
    expect(ANY_CONTROL.test(frontmatterBlock)).toBe(false);
  });

  it('collapses a newline in a speaker name without breaking the speakers list (fix 1)', () => {
    const brokenSpeakers = new Map([[1, 'Evil\nName'], [2, 'Umair Qaiser']]);
    const md = renderNote(MEETING, brokenSpeakers, OPTS);
    expect(md).toContain('speakers:\n  - Evil Name\n  - Umair Qaiser');
    // No raw newline should appear inside the speakers block entries.
    const speakersIdx = md.indexOf('speakers:');
    const nextSectionIdx = md.indexOf('source: wispr-flow', speakersIdx);
    const speakersBlock = md.slice(speakersIdx, nextSectionIdx).trim();
    expect(speakersBlock.split('\n').every((l) => l === 'speakers:' || l.startsWith('  - '))).toBe(true);
  });

  it('round-trip guard: wispr_id is still findable by the vault index regex when title has a newline (fix 1)', () => {
    // This is the real point of the fix: src/main.ts builds its vault index
    // by regex-matching `^wispr_id: (.+)$` against frontmatter it reads back
    // out of written files. If yamlScalar ever again lets a raw newline
    // through, this is the assertion that would catch it.
    const md = renderNote({ ...MEETING, title: 'Broken\nTitle' }, SPEAKERS, OPTS);
    const lines = md.split('\n');
    const openIdx = lines.indexOf('---');
    const closeIdx = lines.indexOf('---', openIdx + 1);
    const frontmatterBlock = lines.slice(openIdx, closeIdx + 1).join('\n');

    const match = frontmatterBlock.match(/^wispr_id: (.+)$/m);
    expect(match?.[1]).toBe('dba862c8-cb7a-4a97-9e8b-fca581b43d99');
    // Exactly two delimiter lines in the whole document: this fails if the
    // stray newline split the frontmatter block or leaked extra `---` lines.
    expect(md.split('\n').filter((l) => l === '---').length).toBe(2);
  });

  it('falls back to Untitled meeting when the title is empty', () => {
    expect(renderNote({ ...MEETING, title: '' }, SPEAKERS, OPTS)).toContain('title: Untitled meeting');
    expect(renderNote({ ...MEETING, title: null }, SPEAKERS, OPTS)).toContain('title: Untitled meeting');
  });

  it('never emits the summary twice', () => {
    const md = renderNote(MEETING, SPEAKERS, OPTS);
    expect(md.match(/Debugged the count gap/g)?.length).toBe(1);
  });

  it('omits the summary block when summaryMode is omit', () => {
    const md = renderNote(MEETING, SPEAKERS, { ...OPTS, summaryMode: 'omit' });
    expect(md).not.toContain('Flow Summary');
    expect(md).toContain('### Count Discrepancy');
  });

  it('uses a plain heading when summaryMode is heading', () => {
    const md = renderNote(MEETING, SPEAKERS, { ...OPTS, summaryMode: 'heading' });
    expect(md).toContain('## Flow Summary');
    expect(md).not.toContain('> [!summary]');
  });

  it('appends a transcript link when given', () => {
    const md = renderNote(MEETING, SPEAKERS, { ...OPTS, transcriptLink: 'Transcripts/x-transcript' });
    expect(md).toContain('[[Transcripts/x-transcript]]');
  });

  it('handles a meeting with no notes without throwing', () => {
    const md = renderNote({ ...MEETING, notes: null }, SPEAKERS, OPTS);
    expect(md).toContain('wispr_id:');
  });
});

describe('renderNote with real-shape notes', () => {
  const REAL_SHAPE_NOTES = [
    '---',
    '',
    ':::toggle',
    '## Flow Summary',
    '',
    'Short summary paragraph about <@speaker:2> and <@speaker:1>.',
    '',
    '### First Section',
    '- bullet one',
    '- bullet two',
    '',
    '### Second Section',
    '- bullet three',
    '',
    ':::',
  ].join('\n');

  const REAL_MEETING: MeetingRow = {
    ...MEETING,
    notes: REAL_SHAPE_NOTES,
  };

  it('callout mode: quotesSummary and promotes sections to top level', () => {
    const md = renderNote(REAL_MEETING, SPEAKERS, OPTS);
    expect(md).toContain('> [!summary]- Flow Summary');
    expect(md).toContain('> Short summary paragraph about Umair Qaiser and Muhammad Bilal.');
    expect(md).toContain('### First Section');
    expect(md).not.toContain('> ### First Section');
  });

  it('callout mode: second section also survives at top level', () => {
    const md = renderNote(REAL_MEETING, SPEAKERS, OPTS);
    expect(md).toContain('### Second Section');
  });

  it('omit mode: drops summary but preserves sections (data-loss regression guard)', () => {
    const md = renderNote(REAL_MEETING, SPEAKERS, { ...OPTS, summaryMode: 'omit' });
    expect(md).not.toContain('Short summary paragraph');
    expect(md).not.toContain('Flow Summary');
    expect(md).toContain('### First Section');
    expect(md).toContain('- bullet three');
  });

  it('heading mode: plain heading with sections at top level', () => {
    const md = renderNote(REAL_MEETING, SPEAKERS, { ...OPTS, summaryMode: 'heading' });
    expect(md).toContain('## Flow Summary');
    expect(md).toContain('### First Section');
    expect(md).not.toContain('> ');
  });

  it('strips leading thematic break (amendment Step A)', () => {
    const md = renderNote(REAL_MEETING, SPEAKERS, OPTS);
    const lines = md.split('\n');
    // Frontmatter: line 0 is opening ---, find the first --- after that (the closing delimiter).
    const closingIdx = lines.indexOf('---', 1);
    expect(closingIdx).toBeGreaterThan(0);
    const afterFrontmatter = lines.slice(closingIdx + 1).join('\n');
    expect(afterFrontmatter).not.toMatch(/^\-\-\-\s*$/m);
  });

  it('preserves thematic breaks in the middle of the body', () => {
    const mdWithBreak = REAL_SHAPE_NOTES.replace(
      '### First Section',
      '---\n\n### First Section'
    );
    const testMeeting: MeetingRow = { ...REAL_MEETING, notes: mdWithBreak };
    const md = renderNote(testMeeting, SPEAKERS, OPTS);
    expect(md).toContain('\n---\n');
  });

  it('strips leading thematic break with 4+ dashes (finding 4)', () => {
    const notesWithFourDashes = '----\n\n:::toggle\n## Summary\n\nTest\n:::\n';
    const testMeeting: MeetingRow = { ...REAL_MEETING, notes: notesWithFourDashes };
    const md = renderNote(testMeeting, SPEAKERS, OPTS);
    const lines = md.split('\n');
    const closingIdx = lines.indexOf('---', 1);
    const afterFrontmatter = lines.slice(closingIdx + 1).join('\n');
    expect(afterFrontmatter).not.toMatch(/^-{3,}\s*$/m);
  });

  it('strips leading thematic break with 5+ stars (finding 4)', () => {
    const notesWithFiveStars = '*****\n\n:::toggle\n## Summary\n\nTest\n:::\n';
    const testMeeting: MeetingRow = { ...REAL_MEETING, notes: notesWithFiveStars };
    const md = renderNote(testMeeting, SPEAKERS, OPTS);
    const lines = md.split('\n');
    const closingIdx = lines.indexOf('---', 1);
    const afterFrontmatter = lines.slice(closingIdx + 1).join('\n');
    expect(afterFrontmatter).not.toMatch(/^\*{3,}\s*$/m);
  });

  it('preserves sections when toggle starts with h3 in callout mode (finding 5)', () => {
    const notesWithH3Only = ':::toggle\n### Sec\n- a\n:::';
    const testMeeting: MeetingRow = { ...REAL_MEETING, notes: notesWithH3Only };
    const md = renderNote(testMeeting, SPEAKERS, { ...OPTS, summaryMode: 'callout' });
    expect(md).toContain('### Sec');
    expect(md).toContain('- a');
  });

  it('preserves sections when toggle starts with h3 in heading mode (finding 5)', () => {
    const notesWithH3Only = ':::toggle\n### Sec\n- a\n:::';
    const testMeeting: MeetingRow = { ...REAL_MEETING, notes: notesWithH3Only };
    const md = renderNote(testMeeting, SPEAKERS, { ...OPTS, summaryMode: 'heading' });
    expect(md).toContain('### Sec');
    expect(md).toContain('- a');
  });

  it('preserves sections when toggle starts with h3 in omit mode (finding 5)', () => {
    const notesWithH3Only = ':::toggle\n### Sec\n- a\n:::';
    const testMeeting: MeetingRow = { ...REAL_MEETING, notes: notesWithH3Only };
    const md = renderNote(testMeeting, SPEAKERS, { ...OPTS, summaryMode: 'omit' });
    expect(md).toContain('### Sec');
    expect(md).toContain('- a');
  });

  it('renders summary fallback in callout mode when notes is null (finding 9)', () => {
    const testMeeting: MeetingRow = { ...REAL_MEETING, notes: null, summary: 'Debugged why eligible count exceeds pre-auth count. <@speaker:2> asked <@speaker:1> to dig into backend.' };
    const md = renderNote(testMeeting, SPEAKERS, OPTS);
    expect(md).toContain('> [!summary]- Flow Summary');
    expect(md).toContain('> Debugged why eligible count exceeds pre-auth count. Umair Qaiser asked Muhammad Bilal to dig into backend.');
  });

  it('renders summary fallback in callout mode when notes is empty string (finding 9)', () => {
    const testMeeting: MeetingRow = { ...REAL_MEETING, notes: '', summary: 'Empty notes fallback test.' };
    const md = renderNote(testMeeting, SPEAKERS, OPTS);
    expect(md).toContain('> [!summary]- Flow Summary');
    expect(md).toContain('> Empty notes fallback test.');
  });

  it('renders summary fallback in callout mode when notes is whitespace-only (finding 9)', () => {
    const testMeeting: MeetingRow = { ...REAL_MEETING, notes: '   \n  ', summary: 'Whitespace fallback test.' };
    const md = renderNote(testMeeting, SPEAKERS, OPTS);
    expect(md).toContain('> [!summary]- Flow Summary');
    expect(md).toContain('> Whitespace fallback test.');
  });

  it('renders summary fallback in heading mode (finding 9)', () => {
    const testMeeting: MeetingRow = { ...REAL_MEETING, notes: null, summary: 'Heading mode summary.' };
    const md = renderNote(testMeeting, SPEAKERS, { ...OPTS, summaryMode: 'heading' });
    expect(md).toContain('## Flow Summary');
    expect(md).toContain('Heading mode summary.');
    expect(md).not.toContain('> ');
  });

  it('omit mode suppresses summary fallback (finding 9)', () => {
    const testMeeting: MeetingRow = { ...REAL_MEETING, notes: null, summary: 'This should be omitted.' };
    const md = renderNote(testMeeting, SPEAKERS, { ...OPTS, summaryMode: 'omit' });
    expect(md).not.toContain('This should be omitted.');
    expect(md).toContain('wispr_id:');
  });

  it('summary fallback respects speaker resolution setting (finding 9)', () => {
    const testMeeting: MeetingRow = { ...REAL_MEETING, notes: '', summary: 'Asked by <@speaker:2> to resolve this.' };
    const withResolution = renderNote(testMeeting, SPEAKERS, { ...OPTS, resolveSpeakerNames: true });
    expect(withResolution).toContain('Asked by Umair Qaiser to resolve this.');
    const withoutResolution = renderNote(testMeeting, SPEAKERS, { ...OPTS, resolveSpeakerNames: false });
    expect(withoutResolution).toContain('Asked by <@speaker:2> to resolve this.');
  });

  it('non-empty notes never use summary fallback (data loss guard)', () => {
    const testMeeting: MeetingRow = { ...REAL_MEETING, notes: ':::toggle\n## Flow Summary\n\nFrom notes field.\n:::\n', summary: 'From summary field.' };
    const md = renderNote(testMeeting, SPEAKERS, OPTS);
    expect(md).toContain('From notes field.');
    expect(md).not.toContain('From summary field.');
    expect(md.match(/Flow Summary/g)?.length).toBe(1);
  });

  it('empty notes and empty summary renders frontmatter only (finding 9)', () => {
    const testMeeting: MeetingRow = { ...REAL_MEETING, notes: null, summary: null };
    const md = renderNote(testMeeting, SPEAKERS, OPTS);
    expect(md).toContain('wispr_id:');
    expect(md).toContain('source: wispr-flow');
    const lines = md.split('\n');
    const closingIdx = lines.indexOf('---', 1);
    const bodyPart = lines.slice(closingIdx + 1).join('\n').trim();
    expect(bodyPart).toBe('');
  });

  it('fallback summary in callout mode: lead paragraph quoted, sections top-level (finding 10)', () => {
    const fallbackSummary = 'Screen-share debugging to get power mic working.\n\n### Debugging Session\n- Initial error was "unexpected character after 9"\n- Investigated signal flow\n\n### Resolution\n- Fixed the input configuration';
    const testMeeting: MeetingRow = { ...REAL_MEETING, notes: null, summary: fallbackSummary };
    const md = renderNote(testMeeting, SPEAKERS, OPTS);
    expect(md).toContain('> [!summary]- Flow Summary');
    expect(md).toContain('> Screen-share debugging to get power mic working.');
    expect(md).toContain('### Debugging Session');
    expect(md).not.toContain('> ### Debugging Session');
    expect(md).toContain('### Resolution');
  });

  it('fallback summary in heading mode: plain heading, sections top-level (finding 10)', () => {
    const fallbackSummary = 'Lead paragraph text.\n\n### Section One\n- item one';
    const testMeeting: MeetingRow = { ...REAL_MEETING, notes: null, summary: fallbackSummary };
    const md = renderNote(testMeeting, SPEAKERS, { ...OPTS, summaryMode: 'heading' });
    expect(md).toContain('## Flow Summary');
    expect(md).toContain('Lead paragraph text.');
    expect(md).toContain('### Section One');
    expect(md).not.toContain('> ');
  });

  it('fallback summary in omit mode: lead dropped, sections preserved (finding 10 data-loss guard)', () => {
    const fallbackSummary = 'This lead should be omitted.\n\n### Important Section\n- Must preserve this bullet';
    const testMeeting: MeetingRow = { ...REAL_MEETING, notes: null, summary: fallbackSummary };
    const md = renderNote(testMeeting, SPEAKERS, { ...OPTS, summaryMode: 'omit' });
    expect(md).not.toContain('This lead should be omitted.');
    expect(md).toContain('### Important Section');
    expect(md).toContain('- Must preserve this bullet');
  });

  it('fallback summary with no sections renders lead in callout, frontmatter-only in omit (finding 10)', () => {
    const leadOnly = 'This summary has no sections.';
    const testMeeting: MeetingRow = { ...REAL_MEETING, notes: null, summary: leadOnly };

    const calloutMd = renderNote(testMeeting, SPEAKERS, { ...OPTS, summaryMode: 'callout' });
    expect(calloutMd).toContain('> [!summary]- Flow Summary');
    expect(calloutMd).toContain('> This summary has no sections.');

    const omitMd = renderNote(testMeeting, SPEAKERS, { ...OPTS, summaryMode: 'omit' });
    expect(omitMd).not.toContain('This summary has no sections.');
    const lines = omitMd.split('\n');
    const closingIdx = lines.indexOf('---', 1);
    const bodyPart = lines.slice(closingIdx + 1).join('\n').trim();
    expect(bodyPart).toBe('');
  });

  it('speaker placeholders in fallback summary resolve in both lead and sections (finding 10)', () => {
    const fallbackWithSpeakers = 'Asked by <@speaker:2> to check this.\n\n### Analysis\n<@speaker:1> found the issue.';
    const testMeeting: MeetingRow = { ...REAL_MEETING, notes: null, summary: fallbackWithSpeakers };
    const md = renderNote(testMeeting, SPEAKERS, { ...OPTS, resolveSpeakerNames: true });
    expect(md).toContain('Asked by Umair Qaiser to check this.');
    expect(md).toContain('Muhammad Bilal found the issue.');
  });
});

describe('renderTranscript', () => {
  const SEGS: TranscriptSegment[] = [
    { timestamp: '00:03', text: 'Assalam o alaikum', speakerId: 1 },
    { timestamp: '00:25', text: 'Checking things', speakerId: 2 },
    { timestamp: '00:40', text: 'Unattributed line', speakerId: null },
  ];

  it('renders timestamp, speaker and text per line', () => {
    const md = renderTranscript(MEETING, SEGS, SPEAKERS, OPTS);
    expect(md).toContain('**00:03** **Muhammad Bilal**: Assalam o alaikum');
    expect(md).toContain('**00:25** **Umair Qaiser**: Checking things');
  });

  it('marks type as transcript', () => {
    expect(renderTranscript(MEETING, SEGS, SPEAKERS, OPTS)).toContain('type: transcript');
  });

  it('falls back for unattributed segments', () => {
    expect(renderTranscript(MEETING, SEGS, SPEAKERS, OPTS)).toContain('**Unknown Speaker**');
  });

  it('produces frontmatter only when there are no segments', () => {
    const md = renderTranscript(MEETING, [], SPEAKERS, OPTS);
    expect(md).toContain('type: transcript');
    expect(md).not.toContain('**');
  });
});

describe('renderTranscriptBody', () => {
  const SEGS = [
    { timestamp: '00:03', text: 'Hello', speakerId: 1 },
    { timestamp: '00:25', text: 'Hi', speakerId: 2 },
  ];
  it('renders only the lines, with no frontmatter', () => {
    const body = renderTranscriptBody(SEGS, SPEAKERS, OPTS);
    expect(body).not.toContain('---');
    expect(body).not.toContain('wispr_id');
    expect(body).toContain('**00:03** **Muhammad Bilal**: Hello');
  });
  it('returns an empty string for no segments', () => {
    expect(renderTranscriptBody([], SPEAKERS, OPTS)).toBe('');
  });
  it('is the exact body used by renderTranscript', () => {
    const standalone = renderTranscript(MEETING, SEGS, SPEAKERS, OPTS);
    expect(standalone).toContain(renderTranscriptBody(SEGS, SPEAKERS, OPTS));
  });
});
