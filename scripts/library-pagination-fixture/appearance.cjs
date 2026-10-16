const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-appearance-fixture-'));
app.setPath('userData', profile);
process.on('exit', () => fs.rmSync(profile, { recursive: true, force: true }));
const base = process.env.MN_LIBRARY_FIXTURE_URL;
assert(base?.startsWith('http://127.0.0.1:'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 900, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  win.webContents.on('render-process-gone', (_event, details) => errors.push(JSON.stringify(details)));
  const run = async code => {
    try { return await win.webContents.executeJavaScript(code, true); }
    catch (error) { throw Error(`${code}\n${error}\n${errors.join('\n')}`); }
  };
  const settle = () => run('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120))))');
  const until = async code => {
    for (let i = 0; i < 150; i++) { assert.deepEqual(errors, []); if (await run(code)) return; await new Promise(r => setTimeout(r, 30)); }
    throw Error(`Not ready: ${code}`);
  };
  const click = async label => { assert(await run(`(() => {const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)return false;b.click();return true;})()`)); await settle(); };
  const screenshot = async name => {
    if (!process.env.MN_FIXTURE_RESULTS) return;
    fs.mkdirSync(process.env.MN_FIXTURE_RESULTS, { recursive: true });
    fs.writeFileSync(path.join(process.env.MN_FIXTURE_RESULTS, `appearance-${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  await win.loadURL(base);
  await until('document.querySelectorAll(".meeting-row").length === 8');
  for (const dark of [false, true]) {
    await run(`document.documentElement.classList.toggle('dark',${dark})`);
    const theme = dark ? 'dark' : 'light';
    for (const view of ['library', 'detail', 'weekly', 'settings', 'onboarding']) {
      await run(`window.showView(${JSON.stringify(view)})`); await settle();
      await until('!!document.querySelector(".app-chrome")');
      if (view === 'detail') {
        await until('document.body.innerText.includes("Overview")');
        await click('transcript'); await until('document.body.innerText.includes("prototype is ready")');
        await click('actions'); await until('document.body.innerText.includes("Share the revised design")');
        await click('summary');
      }
      if (view === 'settings') { await click('Processing'); await until(`!!document.querySelector('[aria-label="Speech engine"]')`); }
      if (view === 'weekly') await until('document.body.innerText.includes("Saved report") && document.body.innerText.includes("Product quality")');
      await screenshot(`${view}-${theme}`);
      win.setContentSize(780, 650); await settle();
      assert(await run('document.documentElement.scrollWidth <= innerWidth'), `${view}/${theme}: no horizontal overflow`);
      await screenshot(`${view}-${theme}-narrow`);
      win.setContentSize(1280, 900); await settle();
    }
  }
  await run('window.showView("library")'); await until('document.querySelectorAll(".meeting-row").length === 8');
  // Check actual navigation, disclosure and a real shared dialog.
  await click('Weekly'); await until('document.body.innerText.includes("Weekly summary")');
  await click('Library'); await until('document.querySelectorAll(".meeting-row").length === 8');
  const group = 'document.querySelector("button[aria-controls=group-rows-00000000-0000-4000-8000-000000000001]")';
  await run(`${group}.click()`); await settle(); assert.equal(await run(`${group}.getAttribute('aria-expanded')`), 'false');
  await run(`${group}.click()`); await until('document.querySelectorAll(".meeting-row").length === 8');
  await click('+ New group'); await until('!!document.querySelector(".material-dialog")');
  assert(await run('!!document.querySelector("[role=dialog]").contains(document.activeElement)'));
  await screenshot('dialog-dark'); win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await until('!document.querySelector(".material-dialog")');
  await run('document.querySelector(".record-command").click()');
  await until('!!document.querySelector(".material-popover")'); await screenshot('source-picker-dark');
  assert(await run(`(() => {const p=document.querySelector('.material-popover'),r=p.getBoundingClientRect();return p.contains(document.elementFromPoint(r.left+20,r.top+20));})()`), 'Source picker remains above Library content');
  await click('Cancel');
  // Validate the fallback rather than assuming CSS media queries work.
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-reduced-transparency', value: 'reduce' }, { name: 'prefers-reduced-motion', value: 'reduce' },
    { name: 'prefers-contrast', value: 'more' },
  ] });
  await settle();
  assert.equal(await run('getComputedStyle(document.querySelector(".app-chrome")).backdropFilter'), 'none');
  assert.equal(await run('getComputedStyle(document.querySelector(".app-chrome")).backgroundColor.includes("rgba")'), false);
  // Force the CSS keyboard state in this hidden window. Actual keyboard
  // navigation/focus trapping is covered by the existing epic243 fixture.
  await win.webContents.debugger.sendCommand('DOM.enable');
  await win.webContents.debugger.sendCommand('CSS.enable');
  const { root } = await win.webContents.debugger.sendCommand('DOM.getDocument');
  const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '.library-search' });
  await win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['focus', 'focus-visible'] });
  assert.notEqual(await run('getComputedStyle(document.querySelector(".library-search")).outlineStyle'), 'none');
  await screenshot('reduced-effects-dark');
  win.webContents.debugger.detach();
  assert.deepEqual(await run('window.fixture'), { captures: 0, preparations: 0 });
  assert.deepEqual(errors, []);
  console.log('APPEARANCE PASS: five real screens, light/dark, desktop/narrow, detail tabs, navigation/disclosure/dialog/source picker, focus and opaque/reduced-effects fallback; no capture or setup.');
  win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
