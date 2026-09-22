import fs from 'node:fs/promises';
import path from 'node:path';
import { BrowserWindow } from 'electron';
import { micromark } from 'micromark';
import type { ExportInput, Exporter } from './interface.js';
import { notesWithoutActionItems } from './document-content.js';
export { notesWithoutActionItems } from './document-content.js';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]!);
}

export function renderMeetingPdfHtml(input: ExportInput): string {
  const notes = notesWithoutActionItems(input.summaryMd ?? '');
  const notesHtml = notes ? micromark(notes, { allowDangerousHtml: false, allowDangerousProtocol: false }) : '';
  const itemsHtml = input.items.length > 0
    ? `<section class="actions"><h2>Action items</h2><ul>${input.items.map((item) => {
      const details = [item.ownerName, item.dueDate ? `Due ${item.dueDate}` : null].filter(Boolean);
      return `<li><span class="box">${item.status === 'done' ? '✓' : ''}</span><span><strong>${escapeHtml(item.text)}</strong>${details.length ? `<small>${escapeHtml(details.join(' · '))}</small>` : ''}</span></li>`;
    }).join('')}</ul></section>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>
    @page { size: A4; margin: 19mm 18mm; }
    * { box-sizing: border-box; }
    body { color: #1c1917; background: white; font: 11pt/1.5 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; margin: 0; }
    header { border-bottom: 2px solid #6366f1; padding-bottom: 13px; margin-bottom: 22px; }
    header h1 { font-size: 24pt; line-height: 1.15; margin: 0; overflow-wrap: anywhere; }
    .label { color: #4f46e5; text-transform: uppercase; letter-spacing: .14em; font-size: 8pt; font-weight: 700; margin: 0 0 7px; }
    h1, h2, h3 { line-height: 1.24; break-after: avoid; }
    article h1 { font-size: 18pt; } h2 { font-size: 15pt; margin: 24px 0 8px; } h3 { font-size: 12pt; margin: 18px 0 6px; }
    p, ul, ol { margin: 0 0 12px; } ul, ol { padding-left: 22px; } li { margin: 3px 0; }
    blockquote { margin: 12px 0; padding: 3px 0 3px 14px; border-left: 3px solid #c7d2fe; color: #57534e; }
    pre { background: #f5f5f4; padding: 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
    code { font: 9pt/1.4 ui-monospace, Menlo, monospace; overflow-wrap: anywhere; }
    table { border-collapse: collapse; width: 100%; font-size: 9pt; } th, td { border: 1px solid #d6d3d1; padding: 5px 7px; text-align: left; }
    a { color: #4338ca; text-decoration: none; overflow-wrap: anywhere; }
    .actions { margin-top: 28px; border-top: 1px solid #d6d3d1; }
    .actions ul { list-style: none; padding: 0; }
    .actions li { display: flex; align-items: flex-start; gap: 10px; margin: 0; padding: 8px 0; break-inside: avoid; }
    .actions .box { flex: 0 0 13px; width: 13px; height: 13px; border: 1px solid #78716c; border-radius: 3px; font-size: 10px; line-height: 11px; text-align: center; margin-top: 3px; }
    .actions strong { font-weight: 500; overflow-wrap: anywhere; } .actions small { display: block; color: #57534e; font-size: 9pt; }
  </style></head><body><header><p class="label">MeetingNotes</p><h1>${escapeHtml(input.meetingTitle)}</h1></header><article>${notesHtml}</article>${itemsHtml}</body></html>`;
}

export class PdfExporter implements Exporter {
  name = 'pdf';

  async export(input: ExportInput): Promise<string> {
    const outputPath = input.outputPath ?? path.join(input.meetingFolder, 'exports', 'notes.pdf');
    const win = new BrowserWindow({ show: false, webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true,
    } });
    try {
      const html = renderMeetingPdfHtml(input);
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, pdf);
      return outputPath;
    } finally {
      win.destroy();
    }
  }
}
