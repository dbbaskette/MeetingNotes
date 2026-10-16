import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
// Only generated compiler output: removed modules must not survive tsc and
// enter the next installer. Never touch release artifacts or user data.
const generated = fileURLToPath(new URL('../dist/', import.meta.url));
fs.rmSync(generated, { recursive: true, force: true });
