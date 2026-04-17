export interface ExportableItem {
  id: string; text: string; ownerName: string | null; dueDate: string | null; status: string;
}
export interface ExportInput {
  items: ExportableItem[];
  meetingTitle: string;
  meetingFolder: string;
}
export interface Exporter {
  name: string;
  export(input: ExportInput): Promise<string>;
}
