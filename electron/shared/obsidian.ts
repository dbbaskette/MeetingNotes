export interface ObsidianOptions {
  vault: string;
  folder: string;
  actionItems: boolean;
  transcript: boolean;
}
export interface ObsidianConfig extends ObsidianOptions {
  enabled: boolean;
  destination: string;
}
export interface ObsidianPreview {
  token: string;
  destination: string;
  meetings: number;
}
export interface ObsidianStatus {
  config: ObsidianConfig | null;
  running: boolean;
  lastSuccess: string | null;
  error: string | null;
  pending: number;
  synced: number;
  issues: { id: string; title: string; error: string }[];
}
export interface ObsidianComparison {
  id: string;
  revision: string;
  current: string;
  proposed: string;
  canReplace: boolean;
}
