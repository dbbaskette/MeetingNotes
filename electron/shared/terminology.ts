export type TermArtifact = 'transcript' | 'summary';
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
  artifact: TermArtifact;
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
