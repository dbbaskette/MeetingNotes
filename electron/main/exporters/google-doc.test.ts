import { describe, it, expect, vi } from 'vitest';
import { GoogleDocExporter } from './google-doc.js';
import type { ExportInput } from './interface.js';

const auth = { getAccessToken: async () => 'AT' };

function input(over: Partial<ExportInput> = {}): ExportInput {
  return {
    items: [{ id: 'a', text: 'Do thing', ownerName: 'Alice', dueDate: '2026-07-01', status: 'open' }],
    meetingTitle: 'Q3 Planning',
    meetingFolder: '/tmp/x',
    summaryMd: '## Overview\nGreat meeting.',
    ...over,
  };
}

describe('GoogleDocExporter', () => {
  it('reuses the MeetingNotes folder, uploads a Doc, returns the link', async () => {
    let uploadBody = '';
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/drive/v3/files?q=')) {
        return { ok: true, status: 200, json: async () => ({ files: [{ id: 'FOLDER1' }] }) };
      }
      if (u.includes('/upload/drive/v3/files')) {
        uploadBody = String(init?.body);
        return { ok: true, status: 200, json: async () => ({ id: 'DOC1', webViewLink: 'https://docs.google.com/document/d/DOC1/edit' }) };
      }
      throw new Error(`unexpected ${u}`);
    }) as unknown as typeof fetch;

    const exported: string[] = [];
    const out = await new GoogleDocExporter({ auth, fetchImpl }).export(
      input({ onItemExported: (id) => exported.push(id) }),
    );
    expect(out).toBe('https://docs.google.com/document/d/DOC1/edit');
    expect(exported).toEqual(['a']);
    // The upload carries the Doc conversion mime + the summary content.
    expect(uploadBody).toContain('application/vnd.google-apps.document');
    expect(uploadBody).toContain('"parents":["FOLDER1"]');
    expect(uploadBody).toContain('Great meeting.');
    expect(uploadBody).toContain('## Action Items');
  });

  it('creates the MeetingNotes folder when missing', async () => {
    let createdFolder = false;
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/drive/v3/files?q=')) return { ok: true, status: 200, json: async () => ({ files: [] }) };
      if (u === 'https://www.googleapis.com/drive/v3/files' && init?.method === 'POST') {
        createdFolder = true;
        return { ok: true, status: 200, json: async () => ({ id: 'NEWFOLDER' }) };
      }
      if (u.includes('/upload/drive/v3/files')) return { ok: true, status: 200, json: async () => ({ id: 'D', webViewLink: 'L' }) };
      throw new Error(u);
    }) as unknown as typeof fetch;
    const out = await new GoogleDocExporter({ auth, fetchImpl }).export(input());
    expect(createdFolder).toBe(true);
    expect(out).toBe('L');
  });

  it('throws a clear error on a Drive failure', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('?q=')) return { ok: true, status: 200, json: async () => ({ files: [{ id: 'F' }] }) };
      return { ok: false, status: 403, json: async () => ({ error: { message: 'insufficientPermissions' } }) };
    }) as unknown as typeof fetch;
    await expect(new GoogleDocExporter({ auth, fetchImpl }).export(input())).rejects.toThrow(/insufficientPermissions/);
  });
});
