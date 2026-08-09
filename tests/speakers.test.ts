import { describe, it, expect } from 'vitest';
import { resolveSpeakers, speakerName } from '../src/wispr/speakers';

const REAL_MAP = JSON.stringify({
  people: {
    '4994d16f': { name: 'Muhammad Bilal', origin: 'self' },
    'dc2cbb7f': { name: 'Umair Qaiser', origin: 'user' },
  },
  assignments: {
    '1': { consensus: null, user: 'dc2cbb7f', mic: null, dom: null, llm: null },
    '2': { consensus: '4994d16f', user: null, mic: '4994d16f', dom: null, llm: null },
  },
});

describe('resolveSpeakers', () => {
  it('maps numeric speaker ids to names', () => {
    const s = resolveSpeakers(REAL_MAP);
    expect(s.get(1)).toBe('Umair Qaiser');
    expect(s.get(2)).toBe('Muhammad Bilal');
  });

  it('prefers an explicit user assignment over automatic inference', () => {
    const map = JSON.stringify({
      people: { a: { name: 'Human Pick' }, b: { name: 'Machine Pick' } },
      assignments: { '1': { consensus: 'b', user: 'a', mic: 'b', dom: 'b', llm: 'b' } },
    });
    expect(resolveSpeakers(map).get(1)).toBe('Human Pick');
  });

  it('follows the full precedence order consensus > mic > dom > llm', () => {
    const mk = (a: Record<string, string | null>) =>
      JSON.stringify({ people: { x: { name: 'X' } }, assignments: { '1': a } });
    const base = { consensus: null, user: null, mic: null, dom: null, llm: null };
    expect(resolveSpeakers(mk({ ...base, consensus: 'x' })).get(1)).toBe('X');
    expect(resolveSpeakers(mk({ ...base, mic: 'x' })).get(1)).toBe('X');
    expect(resolveSpeakers(mk({ ...base, dom: 'x' })).get(1)).toBe('X');
    expect(resolveSpeakers(mk({ ...base, llm: 'x' })).get(1)).toBe('X');
  });

  it('omits ids whose assignments are all null', () => {
    const map = JSON.stringify({
      people: { a: { name: 'A' } },
      assignments: { '1': { consensus: null, user: null, mic: null, dom: null, llm: null } },
    });
    expect(resolveSpeakers(map).has(1)).toBe(false);
  });

  it('omits ids pointing at a person who is not in the people map', () => {
    const map = JSON.stringify({ people: {}, assignments: { '1': { user: 'ghost' } } });
    expect(resolveSpeakers(map).has(1)).toBe(false);
  });

  it('returns an empty map for null, empty, or malformed json', () => {
    expect(resolveSpeakers(null).size).toBe(0);
    expect(resolveSpeakers('').size).toBe(0);
    expect(resolveSpeakers('{oops').size).toBe(0);
    expect(resolveSpeakers('[]').size).toBe(0);
  });
});

describe('resolveSpeakers adversarial input', () => {
  const cases: Array<[string, string]> = [
    ['prototype-polluting assignment key', '{"people":{"a":{"name":"A"}},"assignments":{"__proto__":{"user":"a"}}}'],
    ['prototype-polluting person key', '{"people":{"__proto__":{"name":"A"}},"assignments":{"1":{"user":"__proto__"}}}'],
    ['array-shaped people', '{"people":[{"name":"A"}],"assignments":{"1":{"user":"0"}}}'],
    ['array-shaped assignments', '{"people":{"a":{"name":"A"}},"assignments":[{"user":"a"}]}'],
    ['non-string name', '{"people":{"a":{"name":42}},"assignments":{"1":{"user":"a"}}}'],
    ['null name', '{"people":{"a":{"name":null}},"assignments":{"1":{"user":"a"}}}'],
    ['object name', '{"people":{"a":{"name":{"x":1}}},"assignments":{"1":{"user":"a"}}}'],
    ['whitespace-only name', '{"people":{"a":{"name":"   "}},"assignments":{"1":{"user":"a"}}}'],
    ['non-integer speaker id', '{"people":{"a":{"name":"A"}},"assignments":{"1.5":{"user":"a"}}}'],
    ['NaN speaker id', '{"people":{"a":{"name":"A"}},"assignments":{"NaN":{"user":"a"}}}'],
    ['top-level array', '[]'],
    ['top-level string', '"nope"'],
    ['top-level number', '42'],
    ['top-level null literal', 'null'],
  ];

  for (const [label, json] of cases) {
    it(`does not throw or pollute on ${label}`, () => {
      expect(() => resolveSpeakers(json)).not.toThrow();
      const m = resolveSpeakers(json);
      expect(m).toBeInstanceOf(Map);
      // no prototype pollution
      expect(({} as Record<string, unknown>)['user']).toBeUndefined();
      // every value that IS present must be a non-empty string
      for (const v of m.values()) {
        expect(typeof v).toBe('string');
        expect(v.length).toBeGreaterThan(0);
      }
    });
  }
});

describe('speakerName', () => {
  it('falls back to a stable placeholder', () => {
    const s = resolveSpeakers(REAL_MAP);
    expect(speakerName(s, 2)).toBe('Muhammad Bilal');
    expect(speakerName(s, 9)).toBe('Speaker 9');
    expect(speakerName(s, null)).toBe('Unknown Speaker');
  });
});
