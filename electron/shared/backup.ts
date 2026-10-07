export interface BackupPreview {
  destination: string;
  bytes: number;
  files: number;
  missing: string[];
}
export interface BackupStatus {
  state: 'idle' | 'working' | 'complete' | 'failed';
  completed: number;
  total: number;
  destination?: string;
  error?: string;
}
export interface BackupManifest {
  format: 1;
  createdAt: string;
  version: string;
  libraryRoot: string;
  settingsDatabase: string;
  files: { path: string; bytes: number; sha256: string }[];
  paths: { original: string; relative: string }[];
  links: { path: string; target: string }[];
}
