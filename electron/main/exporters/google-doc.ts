// electron/main/exporters/google-doc.ts
//
// Exports a meeting to a real Google Doc. Builds the same Markdown content as
// the Markdown file exporter (summary + action-items checklist), uploads it to
// Drive with the target mimeType `application/vnd.google-apps.document` so
// Drive converts it to a Doc, drops it in a "MeetingNotes" folder, and returns
// the Doc's URL. Uses the `drive.file` scope (per-file access to files we
// create) — no broad Drive access.

import type { Exporter, ExportInput } from './interface.js';
import { buildMeetingMarkdown } from './markdown.js';

type FetchImpl = typeof fetch;

export interface GoogleAuthLike {
  getAccessToken(): Promise<string>;
}

export interface GoogleDocDeps {
  auth: GoogleAuthLike;
  fetchImpl?: FetchImpl;
}

const FOLDER_NAME = 'MeetingNotes';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOC_MIME = 'application/vnd.google-apps.document';
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink';

export class GoogleDocExporter implements Exporter {
  name = 'google-doc';
  private readonly fetchImpl: FetchImpl;

  constructor(private readonly deps: GoogleDocDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async export(input: ExportInput): Promise<string> {
    const token = await this.deps.auth.getAccessToken();
    const folderId = await this.resolveFolderId(token);
    const markdown = buildMeetingMarkdown(input);
    const link = await this.uploadDoc(token, input.meetingTitle, markdown, folderId);
    // Mark items as exported so the UI can show "already sent".
    for (const it of input.items) input.onItemExported?.(it.id);
    return link;
  }

  /** Find the "MeetingNotes" Drive folder, creating it if absent. */
  private async resolveFolderId(token: string): Promise<string> {
    const q = encodeURIComponent(
      `name='${FOLDER_NAME}' and mimeType='${FOLDER_MIME}' and trashed=false`,
    );
    const found = await this.api(token, `${DRIVE_FILES}?q=${q}&fields=files(id,name)`);
    const files = (found.files ?? []) as Array<{ id: string }>;
    if (files[0]) return files[0].id;
    const created = await this.api(token, DRIVE_FILES, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
    });
    return created.id as string;
  }

  /** Multipart upload: JSON metadata + the Markdown body, with the target
   *  mimeType set so Drive converts it into a Google Doc. Returns webViewLink. */
  private async uploadDoc(
    token: string, title: string, markdown: string, folderId: string,
  ): Promise<string> {
    const boundary = `mn-${Math.abs(hashString(title + markdown.length)).toString(36)}-boundary`;
    const metadata = {
      name: title,
      mimeType: DOC_MIME,
      parents: [folderId],
    };
    const body =
      `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      'Content-Type: text/markdown\r\n\r\n' +
      `${markdown}\r\n` +
      `--${boundary}--`;

    const resp = await this.fetchImpl(DRIVE_UPLOAD, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': `multipart/related; boundary=${boundary}`,
      },
      body,
    });
    const json = (await resp.json().catch(() => ({}))) as {
      webViewLink?: string; id?: string; error?: { message?: string };
    };
    if (!resp.ok) {
      throw new Error(`Google Drive ${resp.status}: ${json.error?.message ?? 'upload failed'}`);
    }
    return json.webViewLink ?? (json.id ? `https://docs.google.com/document/d/${json.id}/edit` : 'Google Doc created');
  }

  private async api(token: string, url: string, init: RequestInit = {}): Promise<any> {
    const resp = await this.fetchImpl(url, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) },
    });
    const json = (await resp.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!resp.ok) throw new Error(`Google Drive ${resp.status}: ${json.error?.message ?? 'request failed'}`);
    return json;
  }
}

/** Tiny deterministic hash for a unique-ish multipart boundary (avoids
 *  Math.random for determinism in tests). */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
