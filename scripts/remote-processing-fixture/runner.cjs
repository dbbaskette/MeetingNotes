const { app, BrowserWindow, Notification, safeStorage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meetingnotes-remote-fixture-'));
const profile = path.join(fixtureRoot, 'user-data');
const library = path.join(fixtureRoot, 'library');
fs.mkdirSync(profile, { recursive: true });
fs.mkdirSync(library, { recursive: true });
app.setPath('userData', profile);
const base = process.env.MN_REMOTE_FIXTURE_URL;
assert(base?.startsWith('http://127.0.0.1:'), 'Launch with node scripts/remote-processing-fixture.mjs');
const timeout = setTimeout(() => { console.error('Fixture timeout'); app.exit(1); }, 90_000);

app.whenReady().then(async () => {
  const securityUrl = pathToFileURL(path.join(process.cwd(), 'dist/electron/main/security/window-boundary.js')).href;
  const { installWindowBoundary } = await import(securityUrl);
  let keychain = { available: safeStorage.isEncryptionAvailable(), roundTrip: false, ciphertextRedacted: false };
  if (keychain.available) {
    const Database = require('better-sqlite3');
    const db = new Database(path.join(library, 'fixture.sqlite'));
    db.exec('CREATE TABLE remote_credentials (identity TEXT PRIMARY KEY, ciphertext BLOB NOT NULL)');
    const moduleUrl = pathToFileURL(path.join(process.cwd(), 'dist/electron/main/remote/credentials.js')).href;
    const { RemoteCredentials } = await import(moduleUrl);
    const credentials = new RemoteCredentials(db, safeStorage, 'darwin');
    const token = 'synthetic-keychain-token-00000000000000';
    credentials.set('https://processing.synthetic.invalid', 'fixture-owner', token);
    const row = db.prepare('SELECT ciphertext FROM remote_credentials').get();
    keychain.roundTrip = credentials.get('https://processing.synthetic.invalid', 'fixture-owner') === token;
    keychain.ciphertextRedacted = Buffer.isBuffer(row.ciphertext) && !row.ciphertext.includes(Buffer.from(token));
    assert.equal(keychain.roundTrip, true);
    assert.equal(keychain.ciphertextRedacted, true);
    db.close();
  }

  const win = new BrowserWindow({
    show: false, width: 900, height: 1050,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const externalUrls = [];
  installWindowBoundary(win.webContents, base, async url => { externalUrls.push(url); });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error('Renderer:', message); });
  const run = (code) => win.webContents.executeJavaScript(code, true);
  const settle = () => run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 30))))');
  const until = async (code) => {
    for (let i = 0; i < 150; i += 1) { if (await run(code)) return; await new Promise(resolve => setTimeout(resolve, 30)); }
    throw new Error(`Not ready: ${code}`);
  };
  const click = async (text) => {
    const found = await run(`(() => { const button = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === ${JSON.stringify(text)}); if (!button) return false; button.click(); return true; })()`);
    assert.equal(found, true, `Missing button: ${text}`); await settle();
  };
  const screenshot = async (name) => {
    const output = path.join(fixtureRoot, name);
    fs.writeFileSync(output, (await win.webContents.capturePage()).toPNG());
    return output;
  };

  await win.loadURL(base);
  win.show(); win.focus(); app.focus({ steal: true }); win.webContents.focus();
  await until(`document.querySelector('#remote-processing-title')?.textContent === 'Processing location'`);
  const originalLocation = await run('location.href');
  await run(`(() => { const link = document.createElement('a'); link.href = 'https://docs.synthetic.invalid/operator'; link.textContent = 'fixture link'; document.body.append(link); link.click(); })()`);
  await settle();
  assert.equal(await run('location.href'), originalLocation);
  assert.deepEqual(externalUrls, ['https://docs.synthetic.invalid/operator']);
  await run(`(() => { const select = document.querySelector('select'); select.value = 'remote'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await settle();
  await run(`(() => {
    const set = (input, value) => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); };
    const inputs = document.querySelectorAll('input'); set(inputs[0], 'https://processing.synthetic.invalid'); set(inputs[1], 'synthetic-ui-token-00000000000000000000');
  })()`);
  await settle();
  await click('Test connection');
  await until(`document.querySelector('[role="status"]')?.textContent.includes('Connection verified')`);
  assert.equal(await run(`document.querySelector('input[type="password"]').value`), '');
  await click('Save processing location');
  await until(`window.fixture.calls.saved.includes('remote')`);
  const settingsScreenshot = await screenshot('settings-remote.png');

  await run(`window.fixture.showPhase('offline')`); await settle(); await settle();
  await until(`document.querySelector('[aria-label="Remote processing status"]')?.textContent.includes('Offline / reconnecting')`);
  await settle();
  const reconnectScreenshot = await screenshot('status-reconnect.png');
  await click('Retry / reconnect');
  await until(`document.querySelector('[aria-label="Remote processing status"]')?.textContent.includes('Uploading')`);
  assert.equal(await run(`window.fixture.calls.actions.at(-1)`), 'retry');

  await run(`window.fixture.showPhase('uploading')`); await settle();
  await click('Cancel remote run');
  await until(`document.querySelector('[aria-label="Remote processing status"]')?.textContent.includes('Cancelled')`);
  assert.equal(await run(`window.fixture.calls.actions.at(-1)`), 'cancel');
  const cancelScreenshot = await screenshot('status-cancelled.png');

  await run(`window.fixture.showPhase('offline'); window.fixture.setConfirm(false)`); await settle();
  const beforeFallback = await run(`window.fixture.calls.actions.length`);
  await click('Process locally');
  assert.equal(await run(`window.fixture.calls.actions.length`), beforeFallback);
  await run(`window.fixture.setConfirm(true)`); await click('Process locally');
  assert.equal(await run(`window.fixture.calls.actions.at(-1)`), 'local');
  assert.equal(await run(`window.fixture.calls.confirms`), 2);

  await run(`window.fixture.showPhase('conflict')`); await settle();
  await click('Review result');
  await until(`document.body.textContent.includes('Replace with reviewed remote result')`);
  const conflictScreenshot = await screenshot('status-conflict-review.png');
  await click('Keep local content');
  assert.equal(await run(`window.fixture.calls.resolves.at(-1)`), false);

  await run(`window.fixture.showPhase('conflict')`); await settle();
  await click('Review result');
  await until(`document.body.textContent.includes('Replace with reviewed remote result')`);
  await click('Replace with reviewed remote result');
  assert.equal(await run(`window.fixture.calls.resolves.at(-1)`), true);

  const result = await run('window.fixture.calls');
  console.log('MN_REMOTE_ELECTRON_FIXTURE_RESULT=' + JSON.stringify({
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    keychain,
    notificationSupported: Notification.isSupported(),
    isolatedProfile: profile,
    isolatedLibrary: library,
    calls: result,
    externalNavigation: externalUrls,
    screenshots: [settingsScreenshot, reconnectScreenshot, cancelScreenshot, conflictScreenshot],
  }));
  clearTimeout(timeout); win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
