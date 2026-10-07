import { describe, expect, it } from 'vitest';
import { paletteSearchView } from './palette-search';

describe('paletteSearchView', () => {
  it('does not treat a thrown query as “no matches”', () => {
    expect(paletteSearchView({ query: 'ab', loading: false, error: 'search unavailable', results: [] })).toEqual({
      kind: 'error', message: 'search unavailable',
    });
    expect(paletteSearchView({ query: 'ab', loading: false, error: null, results: [] })).toEqual({
      kind: 'empty', query: 'ab',
    });
    expect(paletteSearchView({ query: 'a', loading: false, error: null, results: [] })).toEqual({
      kind: 'hint',
    });
    expect(paletteSearchView({ query: 'ab', loading: true, error: null, results: [] })).toEqual({
      kind: 'loading',
    });
  });
});
