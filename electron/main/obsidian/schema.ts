// Durable source revisions cover every repository write, including bulk edits
// and changes made while sync is disabled. No renderer notification is required.
const bump = (id: string) => `INSERT INTO obsidian_revisions(meeting_id, revision) VALUES (${id}, 1)
  ON CONFLICT(meeting_id) DO UPDATE SET revision = revision + 1;`;
const triggers = (table: string, key: string) =>
  ['INSERT', 'UPDATE', 'DELETE']
    .map(
      (event) =>
        `CREATE TRIGGER obsidian_${table}_${event.toLowerCase()} AFTER ${event} ON ${table}
   BEGIN ${bump(`${event === 'DELETE' ? 'OLD' : 'NEW'}.${key}`)} END;`,
    )
    .join('\n');
export const OBSIDIAN_SCHEMA = `
  CREATE TABLE obsidian_revisions(meeting_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
  INSERT INTO obsidian_revisions SELECT id, 1 FROM meetings;
  CREATE TABLE obsidian_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE obsidian_destinations(id TEXT PRIMARY KEY, vault TEXT NOT NULL, folder TEXT NOT NULL,
    identity TEXT NOT NULL, root_identity TEXT, last_success TEXT, browse_hash TEXT);
  CREATE TABLE obsidian_exports(destination TEXT NOT NULL, meeting_id TEXT NOT NULL,
    filename TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
    snapshot TEXT, pending TEXT, error TEXT, PRIMARY KEY(destination, meeting_id),
    UNIQUE(destination, filename));
  ${triggers('meetings', 'id')}
  ${triggers('action_items', 'meeting_id')}
  ${triggers('meeting_speakers', 'meeting_id')}
  ${triggers('terminology_documents', 'meeting_id')}
  CREATE TRIGGER obsidian_groups_update AFTER UPDATE ON groups BEGIN
    INSERT INTO obsidian_revisions SELECT id, 1 FROM meetings WHERE group_id = NEW.id
    ON CONFLICT(meeting_id) DO UPDATE SET revision = revision + 1;
  END;
  CREATE TRIGGER obsidian_speakers_update AFTER UPDATE ON speakers BEGIN
    INSERT INTO obsidian_revisions SELECT meeting_id, 1 FROM meeting_speakers WHERE roster_speaker_id = NEW.id
    ON CONFLICT(meeting_id) DO UPDATE SET revision = revision + 1;
  END;
`;
