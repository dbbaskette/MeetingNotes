#!/usr/bin/env node
// scripts/ci/check-docs.mjs
//
// Keeps the README, guides and website true as the code moves (#255, #303):
//   - every relative link and image in README.md and docs/**/*.md resolves;
//   - the README version badge and release-notes link match package.json;
//   - the README Electron badge matches the installed major version;
//   - no current document describes Audio Hijack as part of the setup;
//   - LICENSE exists at the repository root and README.md links to it;
//   - site/index.html shows the package.json version and no other one;
//   - site/index.html does not present the removed speech stack (whisper.cpp,
//     pyannote, a Hugging Face token, sidecar servers) as the product;
//   - every link on site/index.html resolves: `#id` anchors match an id on
//     the page, relative files exist under site/, and links into this
//     repository on GitHub name a file that exists and, where they carry an
//     anchor, a heading that exists. Other absolute links are not fetched.
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

// 4. The license the README declares is in the repository.
if (!fs.existsSync(path.join(root, 'LICENSE'))) problems.push('LICENSE is missing at the repository root');
if (!/\]\((?:\.\/)?LICENSE\)/.test(readme)) problems.push('README.md: does not link to LICENSE');

// 5. The website describes the current release and architecture.
const REPOSITORY = 'github.com/dbbaskette/MeetingNotes';
const sitePath = path.join(root, 'site/index.html');
const REMOVED_ARCHITECTURE = [
  [/whisper[\s.-]?cpp/i, 'whisper.cpp'],
  [/pyannote/i, 'pyannote'],
  [/(?:hugging\s?face|\bHF)[\s-]+(?:access[\s-]+)?token/i, 'a Hugging Face token'],
  [/side-?car/i, 'sidecar servers'],
];
/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
const headingSlug = (heading) => heading.trim().toLowerCase()
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
function headingSlugs(markdownFile) {
  const body = fs.readFileSync(markdownFile, 'utf8').replace(/```[\s\S]*?```/g, '');
  return new Set([...body.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm), ...body.matchAll(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/g)]
    .map((match) => headingSlug(match[1].replace(/<[^>]+>/g, ''))));
}
if (!fs.existsSync(sitePath)) problems.push('site/index.html is missing');
else {
  const site = fs.readFileSync(sitePath, 'utf8');
  const prose = site.replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, '');
  const visible = prose.replace(/<[^>]*>/g, ' '); // text only, so a link to a tagged file is not read as the page's version
  const versions = [...new Set([...visible.matchAll(/\bv(\d+\.\d+\.\d+)\b/g)].map((match) => match[1]))];
  if (!versions.includes(pkg.version)) problems.push(`site/index.html: does not show v${pkg.version} (package.json)`);
  for (const version of versions) if (version !== pkg.version) problems.push(`site/index.html: shows v${version}, package.json says ${pkg.version}`);
  for (const [pattern, name] of REMOVED_ARCHITECTURE) {
    if (pattern.test(prose)) problems.push(`site/index.html: mentions ${name}, which the app no longer uses`);
  }

  // 6. Links on the website resolve.
  const ids = new Set([...site.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
  for (const match of prose.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
    const target = match[1];
    if (target.startsWith('#')) {
      if (target.length > 1 && !ids.has(decodeURIComponent(target.slice(1)))) problems.push(`site/index.html: anchor ${target} has no matching id on the page`);
      continue;
    }
    const inRepository = new RegExp(`^https?://${REPOSITORY.replace(/\./g, '\\.')}(?:/(?:blob|tree)/main/([^#?]*))?/?(?:#(.*))?$`, 'i').exec(target);
    if (inRepository) {
      const file = path.join(root, decodeURIComponent(inRepository[1] ?? '') || 'README.md');
      if (!fs.existsSync(file)) problems.push(`site/index.html: ${target} names a file that is not in the repository`);
      else if (inRepository[2] && fs.statSync(file).isFile() && file.endsWith('.md') && !headingSlugs(file).has(decodeURIComponent(inRepository[2]).toLowerCase()))
        problems.push(`site/index.html: ${target} names a heading that is not in ${rel(file)}`);
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue; // other absolute URLs are not fetched
    const local = target.split(/[?#]/)[0];
    if (!local || !fs.existsSync(path.resolve(path.dirname(sitePath), decodeURIComponent(local)))) problems.push(`site/index.html: broken link ${target}`);
  }
}

if (problems.length) {
  console.error(`Docs check failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`Docs check passed: ${current.length} current documents and site/index.html, links resolve, versions match package.json, LICENSE present.`);
