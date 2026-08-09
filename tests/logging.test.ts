import { describe, it, expect } from 'vitest';
import { NULL_LOGGER, withPrefix } from '../src/logging';

describe('logging', () => {
  it('NULL_LOGGER swallows messages without throwing', () => {
    expect(() => NULL_LOGGER('anything')).not.toThrow();
  });
  it('withPrefix prefixes every message', () => {
    const seen: string[] = [];
    const log = withPrefix('sync', (m) => seen.push(m));
    log('started');
    log('finished');
    expect(seen).toEqual(['[sync] started', '[sync] finished']);
  });
  it('withPrefix isolates a throwing sink so logging never breaks the caller', () => {
    const log = withPrefix('sync', () => { throw new Error('sink exploded'); });
    expect(() => log('hello')).not.toThrow();
  });
});
