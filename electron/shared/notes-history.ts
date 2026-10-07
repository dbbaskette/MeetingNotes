export interface NotesVersion {
  id: string; createdAt: string; reason: string; summary: string;
  items: { id: string; text: string; status: string; ownerName: string | null; dueDate: string | null }[];
}
export interface NotesComparison {
  revision: string; current: NotesVersion; previous: NotesVersion;
}
