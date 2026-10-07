// Opt-in integration check: Electron media from an HTTP renderer origin,
// using only a generated temporary WAV; no real meeting data or app profile.
const { app, BrowserWindow, protocol, net } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-media-smoke-'));
app.setPath('userData', path.join(root, 'profile'));
protocol.registerSchemesAsPrivileged([{ scheme: 'recovery-audio', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);
let server;
const timer = setTimeout(() => { console.error('Media smoke timeout'); app.exit(1); }, 20000);
app.whenReady().then(async () => {
  const { recoveryMediaHandler } = await import('../dist/electron/main/recording/recovery-media.js');
  const wav = Buffer.alloc(44 + 16000);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(16000, 40);
  const file = path.join(root, 'test.wav'); fs.writeFileSync(file, wav);
  protocol.handle('recovery-audio', recoveryMediaHandler({ preview: async id => {
    if (id !== 'test') throw new Error('unknown');
    return { url: pathToFileURL(file).href, durationS: 1 };
  } }));
  const range = await net.fetch('recovery-audio://preview?id=test', {headers: {Range: 'bytes=44-99'}});
  const length = (await range.arrayBuffer()).byteLength;
  console.log('RANGE', range.status, Object.fromEntries(range.headers), length);
  if (range.status !== 206 || length !== 56) throw new Error(`Range streaming failed: status=${range.status} bytes=${length}`);
  server = http.createServer((_req, res) => res.end(`<audio controls src="recovery-audio://preview?id=test"></audio><script>
    const a=document.querySelector('audio'); a.oncanplay=()=>console.log('MEDIA_OK:'+a.duration);
    a.onerror=()=>console.log('MEDIA_ERROR:'+a.error.code);
  </script>`));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  win.webContents.on('console-message', (_e, _level, message) => {
    if (!message.startsWith('MEDIA_')) return;
    console.log(message); clearTimeout(timer); win.destroy(); server.close();
    fs.rmSync(root, { recursive: true, force: true }); app.exit(message === 'MEDIA_OK:1' ? 0 : 1);
  });
  await win.loadURL(`http://127.0.0.1:${server.address().port}`);
}).catch(error => { console.error(error); app.exit(1); });
