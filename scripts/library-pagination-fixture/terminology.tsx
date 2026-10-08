import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../electron/renderer/src/index.css';
import type {
  TermCommitInput,
  TermInput,
  TermPreviewInput,
  TermReview,
  TermRule,
} from '../../electron/shared/terminology';
const matches = ['transcript', 'transcript', 'summary'].map((artifact, i) => ({
  artifact: artifact as 'transcript' | 'summary',
  key: `${artifact}/${i}`,
  unit: i,
  start: 0,
  before: 'Salsa',
  after: 'SLSA',
  context: 'We discussed Salsa compliance.',
  ruleId: null,
  ruleRevision: null,
}));
const fixture = {
  commits: [] as TermCommitInput[],
  remembers: [] as TermInput[],
  undos: [] as unknown[],
  reloads: 0,
  fail: false,
  rules: [] as TermRule[],
};
let review: TermReview = {
  revision: 'a'.repeat(64),
  matches: [],
  history: [],
  stale: false,
  previousCorrections: false,
};
Object.assign(window, {
  fixture,
  api: {
    terminology: {
      preview: async (input: TermPreviewInput) => {
        if (input.artifact !== 'meeting') throw new Error('Single-artifact request');
        return structuredClone({
          ...review,
          matches: input.source && !review.history.length ? matches : review.matches,
        });
      },
      commit: async (input: TermCommitInput) => {
        if (fixture.fail) throw new Error('Text changed. Preview again.');
        fixture.commits.push(input);
        review = {
          ...review,
          matches: [],
          history: matches.map((m, i) => ({
            ...m,
            id: `${m.artifact}/h${i}`,
            batchId: 'one-correction',
            undone: false,
          })),
        };
        return structuredClone(review);
      },
      undo: async (input: unknown) => {
        fixture.undos.push(input);
        review = { ...review, matches, history: [] };
        return structuredClone(review);
      },
      offers: async () => true,
      list: async () => fixture.rules,
      save: async (input: TermInput) => {
        fixture.remembers.push(input);
        fixture.rules.push({ ...input, id: 'rule', revision: 1 });
      },
    },
  },
});
const { TerminologyPanel } = await import('../../electron/renderer/src/components/Terminology');
function Fixture(): JSX.Element {
  const [disabled, setDisabled] = useState(false);
  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-xl mb-4">Meeting terminology</h1>
      <label>
        <input
          type="checkbox"
          aria-label="Unsaved summary edits"
          checked={disabled}
          onChange={(e) => setDisabled(e.target.checked)}
        />{' '}
        Unsaved summary edits
      </label>
      <TerminologyPanel
        meetingId="m"
        artifact="meeting"
        version="synthetic document revision"
        groupId="engineering"
        groupName="Engineering"
        disabled={disabled}
        onReload={async () => {
          fixture.reloads++;
        }}
      />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
