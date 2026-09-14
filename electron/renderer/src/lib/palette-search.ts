export type PaletteSearchView<T> =
  | { kind: 'hint' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'empty'; query: string }
  | { kind: 'results'; results: T[] };

/** Distinguish a failed query from an empty hit list so ⌘K never looks like
 *  “nothing matched” when search itself broke. */
export function paletteSearchView<T>(input: {
  query: string;
  loading: boolean;
  error: string | null;
  results: readonly T[];
}): PaletteSearchView<T> {
  if (input.query.trim().length < 2) return { kind: 'hint' };
  if (input.loading) return { kind: 'loading' };
  if (input.error) return { kind: 'error', message: input.error };
  if (input.results.length === 0) return { kind: 'empty', query: input.query };
  return { kind: 'results', results: [...input.results] };
}
