#!/usr/bin/env node
// scripts/ci/check-docs.mjs
//
// Keeps the README and guides true as the code moves (#255):
//   - every relative link and image in README.md and docs/**/*.md resolves;
//   - the README version badge and release-notes link match package.json;
//   - the README Electron badge matches the installed major version;
//   - no current document describes Audio Hijack as part of the setup.
//
// Historical material (release notes, specs, plans, reviews, verification
// reports) is checked for broken links only where it is linked from, not
// rewritten: it records what was true at the time.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const problems = [];
const rel = (file) => path.relative(root, file);

function markdownFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.name.endsWith('.md') ? [full] : [];
  });
}

const HISTORICAL = /^docs\/(releases|superpowers|plans|reviews|performance|mockups)\/|^docs\/(epic-\d+-verification|blog-brief)\.md$/;
const files = [path.join(root, 'README.md'), ...markdownFiles(path.join(root, 'docs'))];
const current = files.filter((file) => !HISTORICAL.test(rel(file)));

// 1. Relative links and images resolve.
for (const file of current) {
  const text = fs.readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<img[^>]+src="([^"]+)"/g)) {
    const target = (match[1] ?? match[2]).split('#')[0];
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // anchors and absolute URLs
    const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
    if (!fs.existsSync(resolved)) problems.push(`${rel(file)}: broken link ${target}`);
  }
}

// 2. Version and Electron badges.
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const versionBadge = /badge\/version-([0-9.]+)-/.exec(readme)?.[1];
if (versionBadge !== pkg.version) problems.push(`README.md: version badge says ${versionBadge}, package.json says ${pkg.version}`);
if (!readme.includes(`docs/releases/v${pkg.version}.md`)) problems.push(`README.md: version badge does not link to docs/releases/v${pkg.version}.md`);
if (!fs.existsSync(path.join(root, `docs/releases/v${pkg.version}.md`))) problems.push(`docs/releases/v${pkg.version}.md is missing`);
const electronMajor = /^\D*(\d+)/.exec(pkg.devDependencies.electron)?.[1];
const electronBadge = /badge\/Electron-(\d+)-/.exec(readme)?.[1];
if (electronBadge !== electronMajor) problems.push(`README.md: Electron badge says ${electronBadge}, package.json depends on ${electronMajor}`);

// 3. The recorder that current docs describe is the built-in one.
for (const file of current) {
  const text = fs.readFileSync(file, 'utf8');
  if (/Audio Hijack/i.test(text) && !/no longer uses|used to/i.test(text)) problems.push(`${rel(file)}: mentions Audio Hijack as if it were current`);
}
if (/Audio Hijack/i.test(pkg.description)) problems.push('package.json: description mentions Audio Hijack');

if (problems.length) {
  console.error(`Docs check failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`Docs check passed: ${current.length} current documents, links resolve, badges match package.json.`);
