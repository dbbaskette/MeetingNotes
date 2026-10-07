import path from 'node:path';
import { restoreLibraryBackup } from '../electron/main/storage/library-backup.js';
const [backup, destination] = process.argv.slice(2);
if (!backup || !destination || !path.isAbsolute(backup) || !path.isAbsolute(destination))
  throw new Error(
    'Usage: node --import tsx scripts/restore-library-backup.ts /absolute/backup /absolute/new-destination',
  );
await restoreLibraryBackup(backup, destination);
console.log(
  `Restored to ${destination}. Original Library and canonical settings were not changed. Read docs/library-backup.md before using it.`,
);
