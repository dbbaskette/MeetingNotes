// Disposable real Markdown/Base fixture. Never reads the user's library or vault.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { templates, snapshot, newNote, filename, browse, type NoteData } from '../electron/main/obsidian/render.js';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meetingnotes-obsidian-preview-'));
const vault = path.join(directory, 'Test vault');
fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
fs.mkdirSync(path.join(vault, 'MeetingNotes', 'Notes'), { recursive: true });
const rows = [
  { id: 'one', title: 'Roadmap planning', group: 'Platform', groupId: 'platform', date: '2026-10-02T14:00:00Z' },
  { id: 'two', title: 'Customer review', group: 'Customers', groupId: 'customers', date: '2026-10-01T15:00:00Z' },
  { id: 'three', title: 'New meeting to organize', group: 'Ungrouped', groupId: null, date: '2026-10-03T09:00:00Z' },
].map(m => {
  const data: NoteData = { ...m, duration: 900, participants: ['Alice', 'Sam'], openActions: 1,
    updated: m.date, deleted: false, stale: false, summary: '## Overview\n\nA synthetic meeting used only for compatibility testing.',
    items: [{ text: 'Review the draft', ownerName: 'Alice', dueDate: null, status: 'open' }] };
  const note = snapshot(data, 'disposable-fixture');
  const file = filename(data);
  fs.writeFileSync(path.join(vault, 'MeetingNotes', file), newNote(note));
  return { filename: file, snapshot: note };
});
for (const [file, content] of Object.entries({ ...templates('MeetingNotes', 'disposable-fixture'), 'Browse.md': browse(rows) }))
  fs.writeFileSync(path.join(vault, 'MeetingNotes', file), content);
console.log(JSON.stringify({ directory, vault }, null, 2));
