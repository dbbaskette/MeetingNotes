import { describe, expect, it } from 'vitest';
import { collapseUnchanged, diffLines, diffStats } from './line-diff';

const ops = (before: string, after: string): string[] => diffLines(before, after).map((line) => `${line.op === 'same' ? ' ' : line.op === 'added' ? '+' : '-'}${line.text}`);

describe('diffLines', () => {
  it('marks a changed line as removed then added and keeps the rest', () => {
    expect(ops('# Notes\n- Ship Friday\n- Call Ana', '# Notes\n- Ship Monday\n- Call Ana')).toEqual([' # Notes', '-- Ship Friday', '+- Ship Monday', ' - Call Ana']);
  });
  it('handles pure insertions and deletions', () => {
    expect(ops('a\nc', 'a\nb\nc')).toEqual([' a', '+b', ' c']);
    expect(ops('a\nb\nc', 'a\nc')).toEqual([' a', '-b', ' c']);
  });
  it('handles empty documents and identical documents', () => {
    expect(ops('', 'a\nb')).toEqual(['+a', '+b']);
    expect(ops('a\nb', '')).toEqual(['-a', '-b']);
    expect(ops('', '')).toEqual([]);
    expect(diffStats(diffLines('same\ntext', 'same\ntext'))).toEqual({ added: 0, removed: 0 });
  });
  it('finds the shortest edit when lines repeat', () => {
    const result = diffLines('x\na\nb\na\ny', 'x\na\ny');
    expect(diffStats(result)).toEqual({ added: 0, removed: 2 });
    expect(result.filter((line) => line.op === 'same').map((line) => line.text)).toEqual(['x', 'a', 'y']);
  });
  it('rebuilds both documents from the diff', () => {
    const before = 'one\ntwo\nthree\nfour\nfive', after = 'zero\none\nthree\nFOUR\nfive\nsix';
    const result = diffLines(before, after);
    expect(result.filter((line) => line.op !== 'added').map((line) => line.text).join('\n')).toBe(before);
    expect(result.filter((line) => line.op !== 'removed').map((line) => line.text).join('\n')).toBe(after);
  });
  it('treats Windows and Unix line endings alike', () => {
    expect(diffStats(diffLines('a\r\nb', 'a\nb'))).toEqual({ added: 0, removed: 0 });
  });
});

describe('collapseUnchanged', () => {
  it('keeps context around changes and collapses the rest', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 10', 'line ten');
    const rows = collapseUnchanged(diffLines(before, after), 2);
    expect(rows[0]).toEqual({ op: 'gap', text: '', skipped: 8 });
    expect(rows.map((row) => row.op)).toEqual(['gap', 'same', 'same', 'removed', 'added', 'same', 'same', 'gap']);
    expect(rows.at(-1)).toEqual({ op: 'gap', text: '', skipped: 7 });
  });
  it('collapses an unchanged document to one gap', () => {
    expect(collapseUnchanged(diffLines('a\nb\nc', 'a\nb\nc'))).toEqual([{ op: 'gap', text: '', skipped: 3 }]);
  });
});
