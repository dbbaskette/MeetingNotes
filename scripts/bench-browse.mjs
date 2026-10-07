// Synthetic, byte-for-byte comparison with the reviewed baseline. No user data.
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import assert from 'node:assert/strict';
import { browse } from '../electron/main/obsidian/render.ts';
const repo = process.env.MN_BENCH_REPO ?? process.cwd();
const source = execFileSync('git', ['-c', `safe.directory=${repo}`, '-C', repo, 'show', 'a801017:electron/main/obsidian/render.ts'], {encoding: 'utf8'});
const helper = source.split('\n').find(line => line.startsWith('const text ='));
const legacy = `${helper}\n${source.slice(source.indexOf('export function browse('))}`;
const compiled = ts.transpile(legacy, {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022});
const exports = {};
runInNewContext(compiled, {exports});
const before = exports.browse;
const median = values => values.sort((a,b) => a-b)[Math.floor(values.length/2)];
for (const count of [1000, 10000]) {
  const rows = Array.from({length: count}, (_,i) => ({filename: `Notes/Meeting ${i}.md`, snapshot: {data: {title: `Meeting *${i}*`, date: `2026-10-${String(i%28+1).padStart(2,'0')}`, group: i%7 ? `Group ${i%500}` : 'Ungrouped', deleted: i%101===0}}}));
  assert.equal(browse(rows), before(rows));
  const times = {before: [], after: []};
  for (let sample=0;sample<11;sample++) for (const [name,fn] of sample%2 ? [['after',browse],['before',before]] : [['before',before],['after',browse]]) {
    const started = performance.now(); fn(rows); if (sample>0) times[name].push(performance.now()-started);
  }
  console.log(JSON.stringify({count, groups: 500, beforeMedianMs: median(times.before), afterMedianMs: median(times.after), identicalOutput: true}));
}
