const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meetingnotes-virtual-fixture-'));
app.setPath('userData', profile);
const base = process.env.MN_LIBRARY_FIXTURE_URL;
assert(base?.startsWith('http://127.0.0.1:'), 'Launch with node scripts/library-pagination-fixture.mjs');
const timeout = setTimeout(() => { console.error('Fixture timeout'); app.exit(1); }, 90000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error('Renderer:', message); });
  const run = (code) => win.webContents.executeJavaScript(code, true);
  const settle = () => run(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 20))))`);
  const until = async (code) => { for (let i = 0; i < 100; i++) { if (await run(code)) return; await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error(`Not ready: ${code}`); };
  const scroll = async (top) => { await run(`document.querySelector('#viewport > div').scrollTop = ${top}`); await settle(); };
  const count = () => run(`document.querySelectorAll('[data-meeting-id]').length`);
  await win.loadURL(base + '?plain');
  await until(`document.querySelectorAll('[data-meeting-id]').length === 1000`);
  console.log('BASELINE mounted:', await count());
  for (const width of [900, 1440]) {
    win.setContentSize(width, 900);
    await win.loadURL(base);
    win.show(); win.focus(); app.focus({ steal: true }); win.webContents.focus();
    await until(`document.querySelectorAll('[data-meeting-id]').length === 15`);
    await until('document.hasFocus()');
    const stats = { width, top: await count() };
    const layout = await run(`Array.from(document.querySelectorAll('[data-meeting-id]')).map(row => ({ height: row.firstElementChild.getBoundingClientRect().height, width: row.getBoundingClientRect().width, overflow: row.firstElementChild.scrollWidth > row.firstElementChild.clientWidth }))`);
    assert(layout.every(row => row.height === 64 && !row.overflow), JSON.stringify(layout));
    fs.writeFileSync(path.join(profile, `top-${width}.png`), (await win.webContents.capturePage()).toPNG());
    await scroll(36000); stats.middle = await count(); assert.equal(stats.middle, 20);
    fs.writeFileSync(path.join(profile, `middle-${width}.png`), (await win.webContents.capturePage()).toPNG());
    await scroll(71300); stats.end = await count(); assert.equal(stats.end, 15);
    await scroll(36000);
    await run(`document.querySelector('#viewport').style.height = '350px'`); await settle();
    assert.equal(await count(), 15);
    await run(`document.querySelector('#viewport').style.height = '700px'`); await settle();
    assert.equal(await count(), 20);
    await scroll(0);
    await run(`document.querySelector('[data-meeting-id="fixture-0"] button[aria-label="Select"]').focus()`);
    await scroll(36000);
    stats.pinned = await count(); assert.equal(stats.pinned, 21);
    assert.equal(await run(`document.activeElement.closest('[data-meeting-id]').dataset.meetingId`), 'fixture-0');
    await run(`document.querySelector('#outside').focus()`); await settle();
    assert.equal(await count(), 20);
    assert.equal(await run(`!!document.querySelector('[data-meeting-id="fixture-0"]')`), false);
    await scroll(0);
    await run(`document.querySelector('[data-meeting-id="fixture-0"] button[aria-label="Select"]').click()`); await settle();
    await scroll(36000); await scroll(0);
    assert.equal(await run(`!!document.querySelector('[data-meeting-id="fixture-0"] button[aria-label="Deselect"]')`), true);
    await run(`document.querySelector('#outside').click()`); await settle();
    await run(`document.querySelector('[data-meeting-id="fixture-0"] .group').click()`);
    assert.deepEqual(await run('window.fixture.opened'), ['fixture-0']);
    await run(`document.querySelector('[data-meeting-id="fixture-0"] button[aria-label="Actions"]').focus(); document.activeElement.click()`); await settle();
    assert.equal(await run(`Array.from(document.querySelectorAll('button')).some(button => button.textContent === 'Rename…')`), true);
    fs.writeFileSync(path.join(profile, `menu-${width}.png`), (await win.webContents.capturePage()).toPNG());
    await run(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Rename…').click()`); await settle();
    assert.equal(await run(`document.activeElement.tagName`), 'INPUT');
    await scroll(36000);
    assert.equal(await run(`document.activeElement.tagName`), 'INPUT');
    assert.equal(await count(), 21);
    await scroll(0);
    await win.webContents.insertText(`Unsaved fixture title ${width}`); await settle();
    await run(`window.fixture.originalDialogInput = document.querySelector('input.input'); undefined`);
    const headingPoint = await run(`(() => { const heading = [...document.querySelectorAll('div')].find(node => node.textContent === 'Rename meeting'); const rect = heading.getBoundingClientRect(); return { x: Math.round(rect.left + 15), y: Math.round(rect.top + rect.height / 2) }; })()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...headingPoint });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...headingPoint }); await settle();
    assert.equal(await run(`document.activeElement.tagName`), 'BODY');
    await scroll(36000);
    assert.equal(await run(`document.querySelector('input.input')?.value`), `Unsaved fixture title ${width}`, 'Open Rename dialog must retain its unsaved value after control focus leaves');
    assert.equal(await run(`document.querySelector('input.input') === window.fixture.originalDialogInput`), true);
    assert.equal(await count(), 21);
    fs.writeFileSync(path.join(profile, `blurred-dialog-${width}.png`), (await win.webContents.capturePage()).toPNG());
    await run(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Cancel').click()`); await settle();
    assert.equal(await run(`!!document.querySelector('input.input')`), false);
    assert.equal(await count(), 20);
    // Native Tab moves through the final currently rendered row, mounting
    // more rows as browser focus scrolling approaches the overscan edge.
    await scroll(0);
    await run(`document.querySelector('[data-meeting-id="fixture-14"] button[aria-label="Actions"]').focus()`); await settle();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' }); await settle();
    assert.equal(await run(`document.activeElement.closest('[data-meeting-id]')?.dataset.meetingId`), 'fixture-15');
    await run(`document.querySelector('#outside').focus(); window.fixture.paging()`); await settle();
    assert.equal(await run('window.fixture.requests.length'), 1);
    await scroll(2880);
    await until(`window.fixture.store.getState().loadingMore`);
    assert.equal(await run('window.fixture.requests.length'), 2);
    await run(`window.fixture.store.getState().loadMore(); window.fixture.store.getState().loadMore(); undefined`);
    assert.equal(await run('window.fixture.requests.length'), 2);
    assert.equal(await run(`!!document.querySelector('[role="status"]')`), true);
    await run(`window.fixture.fail()`); await settle();
    assert.equal(await run('window.fixture.store.getState().items.length'), 50);
    assert.equal(await run(`!!document.querySelector('[role="alert"]')`), true);
    await scroll(2890); await settle();
    assert.equal(await run('window.fixture.requests.length'), 2);
    await scroll(1_000_000);
    assert.equal(await run(`document.querySelector('[role="alert"] button').getBoundingClientRect().bottom <= document.querySelector('#viewport').getBoundingClientRect().bottom`), true);
    fs.writeFileSync(path.join(profile, `retry-${width}.png`), (await win.webContents.capturePage()).toPNG());
    await run(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Retry').click()`); await settle();
    assert.equal(await run('window.fixture.requests.length'), 3);
    await run('window.fixture.succeed()'); await settle();
    assert.equal(await run('window.fixture.store.getState().items.length'), 100);
    assert.equal(await run(`!!document.querySelector('[role="alert"]')`), false);
    console.log('PASS', JSON.stringify(stats), 'layout/scroll/resize/focus/selection/navigation/menu/portal/dialog-blur-retention-and-release/Tab/loadMore/dedupe/error/retry');
  }
  const measurements = [];
  for (let sample = 0; sample <= 7; sample++) {
    for (const plain of sample % 2 === 0 ? [true, false] : [false, true]) {
      await win.loadURL(base + (plain ? '?plain' : ''));
      await until(`document.querySelectorAll('[data-meeting-id]').length === ${plain ? 1000 : 15}`);
      await settle();
      const mounted = await count();
      if (!plain) assert(mounted < 40);
      // Include ResizeObserver's initial viewport update, not just the first
      // React mount (which can initially know a zero-height viewport).
      const mount = await run('window.fixture.commits.reduce((sum, commit) => sum + commit.actualDuration, 0)');
      const scrollSample = await run(`new Promise(resolve => {
        window.fixture.commits.length = 0;
        const start = performance.now();
        const viewport = document.querySelector('#viewport > div');
        viewport.scrollTop = 36000;
        // Scroll event -> rAF-coalesced state -> React commit -> next frame.
        viewport.addEventListener('scroll', () => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => {
          resolve({ elapsedMs: performance.now() - start, reactMs: window.fixture.commits.reduce((sum, commit) => sum + commit.actualDuration, 0), mounted: document.querySelectorAll('[data-meeting-id]').length });
        }))), { once: true });
      })`);
      if (!plain) assert(scrollSample.mounted < 40);
      measurements.push({ sample, mode: plain ? 'plain' : 'virtual', initialRenderReactMs: mount, mounted, scroll: scrollSample });
    }
  }
  console.log('MN_LIBRARY_RENDERER_BENCH_RESULT=' + JSON.stringify({ electron: process.versions.electron, chromium: process.versions.chrome, measurements }));
  clearTimeout(timeout); win.destroy(); console.log('ISOLATED_PROFILE', profile); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
