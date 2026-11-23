import { expect, it } from 'vitest';
import { speechVocabulary, VOCABULARY_LIMIT } from './vocabulary.js';

it('lists dictionary spellings first, then the user and the roster', () => {
  expect(speechVocabulary({ terms: ['SLSA', 'Kubernetes'], userName: 'Dana', speakers: ['Priya Raghunathan', 'Zbigniew'] }))
    .toEqual(['SLSA', 'Kubernetes', 'Dana', 'Priya Raghunathan', 'Zbigniew']);
});
it('trims, drops blanks and removes repeats without regard to case', () => {
  expect(speechVocabulary({ terms: ['  SLSA ', '', 'slsa'], userName: '  ', speakers: ['SLSA', 'Dana', 'dana'] })).toEqual(['SLSA', 'Dana']);
});
it('leaves out generated speaker labels, multi-line text and very long entries', () => {
  expect(speechVocabulary({ terms: ['two\nlines', 'x'.repeat(81), 'Tanzu'], speakers: ['Speaker 3', 'SPEAKER_00', 'Unknown', 'You', 'Keith'] }))
    .toEqual(['Tanzu', 'Keith']);
});
it('is bounded so a large dictionary cannot crowd out the audio context', () => {
  const many = Array.from({ length: 500 }, (_, index) => `Term ${index}`);
  const result = speechVocabulary({ terms: many, speakers: ['Never reached'] });
  expect(result).toHaveLength(VOCABULARY_LIMIT);
  expect(result[0]).toBe('Term 0');
});
it('returns an empty list when there is nothing to offer', () => {
  expect(speechVocabulary({})).toEqual([]);
});
