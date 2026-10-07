const {app, BrowserWindow} = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-startup-fixture-'));
app.setPath('userData', profile);
process.on('exit', () => fs.rmSync(profile, {recursive: true, force: true}));
const base = process.env.MN_LIBRARY_FIXTURE_URL;
assert(base?.startsWith('http://127.0.0.1:'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({show: false, width: 1440, height: 1000,
    webPreferences: {contextIsolation: true, nodeIntegration: false, backgroundThrottling: false}});
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => {if (level >= 3) {errors.push(message); console.error('Renderer:', message);}});
  win.webContents.on('render-process-gone', (_event, details) => errors.push(JSON.stringify(details)));
  const run = code => win.webContents.executeJavaScript(code, true);
  const settle = () => run('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 200))))');
  const until = async code => {
    for (let i = 0; i < 150; i++) {
      assert.deepEqual(errors, [], 'No renderer crashes or React errors');
      if (await run(code)) return;
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error(`Not ready: ${code}`);
  };
  const button = label => `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})`;
  const libraryView = `document.querySelector('[aria-label="Library view"]')`;
  const planningButton = 'document.querySelector("button[aria-controls=group-rows-00000000-0000-4000-8000-000000000001]")';
  for (const jitter of [true, false]) {
    await win.loadURL(base + '?startup' + (jitter ? '&jitter' : ''));
    await until(`!!window.fixture?.calls.pages.some(q => q.groupId === "00000000-0000-4000-8000-000000000002") && !!${libraryView}`);
    await settle();
    assert.deepEqual(errors, []);
    assert.equal(await run('document.querySelectorAll("section [aria-expanded=true]").length'), 3);
    assert.ok(await run('document.body.innerText.includes("Needs attention") && document.body.innerText.includes("Planning")'));
    if (jitter) {
      const before = await run('window.fixture.geometry.reads');
      await run('new Promise(r => setTimeout(r, 250))');
      const after = await run('window.fixture.geometry.reads');
      assert.ok(before > 0 && after - before < 10, `Geometry stabilizes rather than rendering forever: ${before} -> ${after}`);
    }
    for (const [width, height, zoom] of [[900,600,1], [1100,850,1.25], [1440,1000,0.85]]) {
      win.setSize(width, height); win.webContents.setZoomFactor(zoom);
      await settle();
      assert.ok(await run(`!!${libraryView}`));
      assert.deepEqual(errors, []);
    }
    await run(`${button('All meetings')}.click()`); await settle();
    await run(`${button('Organized')}.click()`); await settle();
    await until('document.querySelectorAll("section [aria-expanded=true]").length === 3');
    await run(`${planningButton}.click()`); await settle();
    assert.equal(await run(`${planningButton}.getAttribute("aria-expanded")`), 'false');
    assert.deepEqual(errors, []);
  }
  if (process.env.MN_FIXTURE_RESULTS) fs.writeFileSync(path.join(process.env.MN_FIXTURE_RESULTS, 'populated-library.png'), (await win.webContents.capturePage()).toPNG());
  console.log('STARTUP PASS: actual populated Library, 600 meetings, three expanded groups, 113 recovery items; subpixel jitter, resize, zoom, view switch and collapse; no React crash');
  win.destroy(); app.quit();
}).catch(error => {console.error(error); app.exit(1);});
