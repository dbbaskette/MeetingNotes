import { describe, it, expect } from 'vitest';
import { extractOverviewRecap } from './recap.js';

describe('extractOverviewRecap', () => {
  it('returns the first paragraph of the Overview section, up to N sentences', () => {
    const md = [
      '## Overview',
      '',
      'The team discussed the Q3 migration. Postgres fixtures are blocking QA. A decision was deferred to next week. An extra sentence that should be cut.',
      '',
      '## Key Discussion Points',
      '- something',
    ].join('\n');
    const recap = extractOverviewRecap(md, 3, 1000);
    expect(recap).toBe(
      'The team discussed the Q3 migration. Postgres fixtures are blocking QA. A decision was deferred to next week.',
    );
  });

  it('falls back to the first non-heading paragraph when there is no Overview heading', () => {
    const md = [
      '# Some Title',
      '',
      'First real paragraph here. Second sentence.',
      '',
      'Later paragraph.',
    ].join('\n');
    expect(extractOverviewRecap(md, 3, 1000)).toBe('First real paragraph here. Second sentence.');
  });

  it('caps the result at maxChars without splitting mid-word', () => {
    const md = '## Overview\n\nalpha beta gamma delta epsilon zeta eta theta.';
    const recap = extractOverviewRecap(md, 5, 20);
    expect(recap).not.toBeNull();
    expect(recap!.length).toBeLessThanOrEqual(21); // +ellipsis tolerance
    expect(recap!.startsWith('alpha beta')).toBe(true);
  });

  it('returns null for empty or heading-only input', () => {
    expect(extractOverviewRecap('', 3, 1000)).toBeNull();
    expect(extractOverviewRecap('## Overview\n\n', 3, 1000)).toBeNull();
    expect(extractOverviewRecap(null, 3, 1000)).toBeNull();
  });

  it('handles an Overview with fewer sentences than the cap', () => {
    const md = '## Overview\n\nJust one sentence.';
    expect(extractOverviewRecap(md, 3, 1000)).toBe('Just one sentence.');
  });
});
