export type TermArtifact = 'transcript' | 'summary';
export type TermScope = TermArtifact | 'meeting';
export interface TermInput {
  source: string;
  replacement: string;
  groupId: string | null;
  mode: 'suggest' | 'automatic';
  caseSensitive: boolean;
  enabled: boolean;
}
export interface TermRule extends TermInput {
  id: string;
  revision: number;
}
export interface TermMatch {
  artifact?: TermArtifact;
  key: string;
  unit: number;
  start: number;
  before: string;
  after: string;
  context: string;
  ruleId: string | null;
  ruleRevision: number | null;
}
export interface TermHistory extends TermMatch {
  id: string;
  undone: boolean;
  batchId?: string;
}
export interface TermReview {
  revision: string;
  matches: TermMatch[];
  history: TermHistory[];
  stale: boolean;
  previousCorrections: boolean;
}
export interface TermTarget {
  meetingId: string;
  artifact: TermScope;
}
export interface TermPreviewInput extends TermTarget {
  source?: string;
  replacement?: string;
}
export interface TermCommitInput extends TermPreviewInput {
  revision: string;
  keys: string[];
  dismiss?: boolean;
}
