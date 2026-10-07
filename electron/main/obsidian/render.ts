import { parseDocument, stringify } from 'yaml';
import { hash } from './files.js';
import { notesWithoutActionItems } from '../exporters/document-content.js';

export interface NoteData {
  id: string;
  title: string;
  date: string;
  groupId: string | null;
  group: string;
  duration: number | null;
  participants: string[];
  openActions: number;
  updated: string;
  deleted: boolean;
  stale: boolean;
  summary: string;
  transcript?: string;
  items: { text: string; ownerName: string | null; dueDate: string | null; status: string }[];
}
export interface Snapshot {
  data: NoteData;
  properties: Record<string, unknown>;
  block: string;
}
const START = '<!-- meetingnotes:generated:start -->';
const END = '<!-- meetingnotes:generated:end -->';
const clean = (s: string) => s.replaceAll('<!-- meetingnotes:', '&lt;!-- meetingnotes:');
const text = (s: string) => s.replace(/[\r\n]/g, ' ').replace(/([\\`*_[\]<>])/g, '\\$1');
export function filename(data: NoteData): string {
  const title =
    data.title
      .normalize('NFC')
      .replace(/[^\p{L}\p{N} -]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'Meeting';
  return `Notes/${data.date.slice(0, 10)} - ${title} - ${hash(data.id).slice(0, 16)}.md`;
}
export function snapshot(data: NoteData, owner: string): Snapshot {
  const properties = {
    mn_owner: owner,
    mn_id: data.id,
    mn_title: data.title,
    mn_date: data.date,
    mn_group_id: data.groupId,
    mn_group: data.group,
    mn_duration_seconds: data.duration,
    mn_participants: data.participants,
    mn_open_actions: data.openActions,
    mn_updated: data.updated,
    mn_removed: data.deleted,
    mn_notes_stale: data.stale,
  };
  const lines = [
    START,
    `# ${text(data.title)}`,
    '',
    `[Open in MeetingNotes](meetingnotes://open?id=${encodeURIComponent(data.id)})`,
    '',
    ...(data.deleted
      ? ['> Removed from MeetingNotes. This note and your annotations have been retained.', '']
      : []),
    ...(data.stale ? ['> These notes may be out of date after a transcript correction.', ''] : []),
    clean(notesWithoutActionItems(data.summary)),
    '',
  ];
  if (data.items.length) {
    lines.push('## Action items', '', '> One-way copy: manage task status in MeetingNotes.', '');
    for (const item of data.items)
      lines.push(
        `- [${item.status === 'done' ? 'x' : ' '}] ${text(item.text)}${item.ownerName ? ` — ${text(item.ownerName)}` : ''}${item.dueDate ? ` — due ${text(item.dueDate)}` : ''}`,
      );
  }
  if (data.transcript) lines.push('', '## Transcript', '', clean(data.transcript));
  lines.push('', END);
  return { data, properties, block: lines.join('\n') };
}
export function newNote(next: Snapshot): string {
  return `---\n${stringify(next.properties)}---\n\n${next.block}\n\n## Personal notes\n\nAdd your own notes here. This section is preserved during sync.\n`;
}
function split(note: string) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(note);
  if (!front) throw new Error('Note properties were removed or changed; review before replacing');
  const doc = parseDocument(front[1]!, { uniqueKeys: true });
  if (
    doc.errors.length ||
    !doc.toJSON() ||
    Array.isArray(doc.toJSON()) ||
    typeof doc.toJSON() !== 'object'
  )
    throw new Error('Note properties are invalid');
  const start = note.indexOf(START, front[0].length),
    end = note.indexOf(END, start);
  if (
    start < 0 ||
    end < start ||
    note.indexOf(START, start + START.length) !== -1 ||
    note.indexOf(END, end + END.length) !== -1
  )
    throw new Error('Generated section markers are missing or duplicated');
  return { doc, front, start, end: end + END.length, block: note.slice(start, end + END.length) };
}
export function mergeNote(
  current: string,
  previous: Snapshot,
  next: Snapshot,
  replace = false,
): string {
  const parts = split(current);
  // Even explicitly replacing a conflict must never adopt a different note.
  if (
    parts.doc.get('mn_owner') !== previous.properties.mn_owner ||
    parts.doc.get('mn_id') !== previous.data.id
  )
    throw new Error('Note ownership changed; not safe to replace');
  if (
    !replace &&
    (parts.block !== previous.block ||
      Object.keys(previous.properties).some(
        (key) =>
          JSON.stringify(parts.doc.toJSON()[key]) !== JSON.stringify(previous.properties[key]),
      ))
  ) {
    throw new Error('Generated content or meeting properties were edited in Obsidian');
  }
  for (const [key, value] of Object.entries(next.properties)) parts.doc.set(key, value);
  return (
    `---\n${parts.doc.toString()}---\n` +
    current.slice(parts.front[0].length, parts.start) +
    next.block +
    current.slice(parts.end)
  );
}
export const ownerOf = (note: string) => {
  const p = split(note);
  return { owner: p.doc.get('mn_owner'), id: p.doc.get('mn_id') };
};
export function templates(folder: string, owner: string): Record<string, string> {
  const filter = {
    and: [
      `mn_owner == ${JSON.stringify(owner)}`,
      `file.inFolder(${JSON.stringify(`${folder}/Notes`)})`,
      'mn_removed != true',
      'file.ext == "md"',
    ],
  };
  const order = ['file.name', 'mn_date', 'mn_group', 'mn_open_actions'];
  const sort = [{ property: 'mn_date', direction: 'DESC' }];
  return {
    'Meetings.base': stringify({
      filters: filter,
      properties: {
        mn_date: { displayName: 'Meeting date' },
        mn_group: { displayName: 'Group' },
        mn_open_actions: { displayName: 'Open actions' },
        'formula.meeting': { displayName: 'Meeting' },
      },
      formulas: { meeting: 'file.asLink(mn_title)' },
      views: [
        {
          type: 'table',
          name: 'By group',
          groupBy: { property: 'mn_group', direction: 'ASC' },
          order: ['formula.meeting', ...order.slice(1)],
          sort,
        },
        { type: 'table', name: 'By date', order: ['formula.meeting', ...order.slice(1)], sort },
        {
          type: 'table',
          name: 'Ungrouped',
          filters: '!mn_group_id',
          order: ['formula.meeting', ...order.slice(1)],
          sort,
        },
      ],
    }),
    'Meetings.md': `# Meetings\n\nOne note per meeting, with several ways to browse. Enable Obsidian's built-in Bases plugin to use these views.\n\n![[${folder}/Meetings.base]]\n\n[[${folder}/Meetings.base#By date|Browse by date]] · [[${folder}/Meetings.base#Ungrouped|Ungrouped]] · [[${folder}/Browse|Plain Markdown index]]\n\nMeetingNotes updates the generated section and mn_ properties. Write your own annotations under Personal notes. Task checkboxes are one-way copies; edit task status in MeetingNotes. External edits to generated content pause updates until reviewed. Audio is not copied.\n\nYou may customize this page and the Base: routine sync will not overwrite them.\n`,
  };
}
export function browse(
  rows: {
    filename: string;
    snapshot: { data: Pick<NoteData, 'title' | 'date' | 'group' | 'deleted'> };
  }[],
): string {
  const active = rows
    .filter((r) => !r.snapshot.data.deleted)
    .sort(
      (a, b) =>
        b.snapshot.data.date.localeCompare(a.snapshot.data.date) ||
        a.filename.localeCompare(b.filename),
    );
  const link = (r: (typeof active)[number]) =>
    `- [${text(r.snapshot.data.title)}](${r.filename.split('/').map(encodeURIComponent).join('/')}) — ${r.snapshot.data.date.slice(0, 10)}`;
  const buckets = new Map<string, typeof active>();
  for (const row of active) {
    const group = row.snapshot.data.group;
    const bucket = buckets.get(group);
    if (bucket) bucket.push(row); else buckets.set(group, [row]);
  }
  const groups = [...buckets.keys()].sort((a, b) =>
    a === 'Ungrouped' ? -1 : b === 'Ungrouped' ? 1 : a.localeCompare(b),
  );
  return [
    '# Browse meetings',
    '',
    'Generated link-only index. Personalize Meetings.md instead.',
    '',
    '## By group',
    '',
    ...groups.flatMap((g) => [
      `### ${text(g)}`,
      '',
      ...buckets.get(g)!.map(link),
      '',
    ]),
    '## By date',
    '',
    ...active.map(link),
    '',
  ].join('\n');
}
