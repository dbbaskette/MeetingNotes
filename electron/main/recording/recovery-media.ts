import type { RecordingRecoveryService } from './recovery.js';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Only cataloged recovery IDs may be resolved; never accept a renderer path. */
export function recoveryMediaHandler(service: Pick<RecordingRecoveryService, 'preview'>) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (url.hostname !== 'preview' || !id || request.method !== 'GET') return new Response(null, { status: 400 });
    try {
      const preview = await service.preview(id);
      const file = fileURLToPath(preview.url);
      const { size } = await fs.promises.stat(file);
      const range = request.headers.get('range');
      let start = 0; let end = size - 1;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
        if (match[1]) {
          start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
        } else start = Math.max(0, size - Number(match[2]));
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
        }
      }
      const mime = path.extname(file).toLowerCase() === '.mp3' ? 'audio/mpeg'
        : path.extname(file).toLowerCase() === '.wav' ? 'audio/wav' : 'audio/mp4';
      const headers = new Headers({ 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), 'Cache-Control': 'no-store' });
      if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
      const body = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream<Uint8Array>;
      return new Response(body, { status: range ? 206 : 200, headers });
    } catch { return new Response(null, { status: 404 }); }
  };
}
