import { app, BrowserWindow, dialog, ipcMain, net, protocol, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { SpeechClient } from '../speech/client.js';
import { BetaService } from './service.js';

// Independent entry point: never imports stable's bootstrap, supervisors,
// recording recovery, watcher, exporters, global shortcuts, or URL handlers.
app.setName('MeetingNotes Beta');
const fixtureRoot = !app.isPackaged ? process.env.MN_SPEECH_BETA_TEST_ROOT : undefined;
if (fixtureRoot && (!path.resolve(fixtureRoot).startsWith(fs.realpathSync(os.tmpdir()) + path.sep) ||
  !fs.existsSync(path.join(fixtureRoot, '.speech-beta-fixture')))) throw new Error('Invalid beta fixture profile.');
const profile = fixtureRoot ?? path.join(os.homedir(), 'Library', 'Application Support', 'MeetingNotes Beta');
app.setPath('userData', profile);
app.setAppLogsPath(fixtureRoot ? path.join(profile, 'logs') : path.join(os.homedir(), 'Library', 'Logs', 'MeetingNotes Beta'));
protocol.registerSchemesAsPrivileged([{ scheme: 'beta-audio', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);
if (!app.requestSingleInstanceLock()) app.quit();
const directory = path.dirname(fileURLToPath(import.meta.url));
const Id = z.string().min(1).max(200);
const Command = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('status') }),
  z.object({ operation: z.literal('preview-import') }),
  z.object({ operation: z.literal('import') }),
  z.object({ operation: z.literal('prepare'), provider: z.enum(['apple', 'speakers']) }),
  z.object({ operation: z.literal('compare'), id: Id }),
  z.object({ operation: z.literal('run'), id: Id, mode: z.enum(['transcript', 'full']) }),
  z.object({ operation: z.literal('cancel') }),
  z.object({ operation: z.literal('confirm'), id: Id, label: z.string().regex(/^SPEAKER_\d+$/).max(100), rosterId: Id }),
]);
let window: BrowserWindow | null = null, beta: BetaService | null = null;
app.on('second-instance', () => { window?.show(); window?.focus(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => beta?.shutdown());

void app.whenReady().then(async () => {
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(profile) !== profile) throw new Error('The beta data folder cannot be an alias or symbolic link.');
  const helper = app.isPackaged ? path.join(process.resourcesPath, 'bin', 'meeting-notes-speech') :
    path.resolve(directory, '../../../../speech-engine/.build/release/meeting-notes-speech');
  beta = new BetaService(profile, new SpeechClient(helper));
  const service = beta;
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  protocol.handle('beta-audio', request => {
    try {
      const url = new URL(request.url);
      if (url.host !== 'meeting') return new Response(null, { status: 404 });
      const id = Id.parse(decodeURIComponent(url.pathname.slice(1)));
      return net.fetch(pathToFileURL(service.audioPath(id)).href, { headers: request.headers });
    } catch { return new Response(null, { status: 404 }); }
  });
  window = new BrowserWindow({ width: 1240, height: 850, minWidth: 780, minHeight: 560,
    title: 'MeetingNotes Beta — local speech comparison', backgroundColor: '#fafaf9',
    webPreferences: { preload: path.join(directory, '../../../preload/electron/preload/beta.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-redirect', event => event.preventDefault());
  contents.on('will-attach-webview', event => event.preventDefault());
  ipcMain.handle('speech-beta', async (event, input: unknown) => {
    if (event.sender !== contents || event.senderFrame !== contents.mainFrame) throw new Error('Untrusted beta request.');
    const command = Command.parse(input);
    switch (command.operation) {
      case 'status': return service.status();
      case 'preview-import': {
        const selected = await dialog.showOpenDialog(window!, { title: 'Choose your existing MeetingNotes library',
          defaultPath: path.join(os.homedir(), 'Documents', 'MeetingNotes'), properties: ['openDirectory'] });
        return selected.canceled || !selected.filePaths[0] ? null : service.importer.preview(selected.filePaths[0]);
      }
      case 'import': return service.importLibrary();
      case 'prepare': return service.prepare(command.provider);
      case 'compare': return service.compare(command.id);
      case 'run': return service.run(command.id, command.mode);
      case 'cancel': return service.cancel();
      case 'confirm': return service.confirm(command.id, command.label, command.rosterId);
    }
  });
  await window.loadFile(path.join(directory, '../../../renderer/beta.html'));
  void service.checkApple();
  if (fixtureRoot && process.env.MN_SPEECH_BETA_UI_SMOKE === '1') {
    const failures: string[] = [];
    contents.on('console-message', (_event, level, message) => { if (level === 3) failures.push(message); });
    const evidence = await contents.executeJavaScript(`(async () => {
      const waitFor = async (test) => { for(let i=0;i<100;i++){if(test())return;await new Promise(r=>setTimeout(r,50));}throw new Error('Beta UI timed out'); };
      await waitFor(()=>document.querySelector('.beta-meeting'));
      if(!document.body.textContent.includes('Weekly review'))throw new Error('Copied meeting missing');
      document.querySelector('.beta-meeting').click();
      await waitFor(()=>document.querySelector('.beta-columns'));
      if(!document.body.textContent.includes('Original wording.'))throw new Error('Original transcript missing');
      if(!document.body.textContent.includes('New wording.'))throw new Error('Beta transcript missing');
      const noteTab=[...document.querySelectorAll('.beta-tabs button')].find(b=>b.textContent.includes('notes'));
      noteTab.click(); await waitFor(()=>document.querySelector('.beta-notes'));
      if(!document.body.textContent.includes('Original notes.'))throw new Error('Notes changed or missing');
      document.querySelector('.beta-tabs button').click();
      await waitFor(()=>document.querySelector('.beta-columns'));
      const media=document.querySelector('audio');
      await waitFor(()=>media.readyState>=1||media.error);
      if(media.error)throw new Error('Beta audio did not load: '+media.error.message);
      return {title:document.title,comparison:true,notes:true,audio:true,meetings:document.querySelectorAll('.beta-meeting').length};
    })()`);
    if (failures.length) throw new Error(failures.join('\n'));
    fs.writeFileSync(path.join(fixtureRoot, 'ui-result.json'), JSON.stringify(evidence));
    fs.writeFileSync(path.join(fixtureRoot, 'comparison.png'), (await contents.capturePage()).toPNG());
    app.quit();
  }
}).catch(error => {
  if (fixtureRoot) { console.error((error as Error).message); app.exit(1); return; }
  dialog.showErrorBox('MeetingNotes Beta could not start', (error as Error).message);
  app.quit();
});
