const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-selection-fixture-'));
app.setPath('userData', profile);
const base = process.env.MN_LIBRARY_FIXTURE_URL;
assert(base?.startsWith('http://127.0.0.1:'), 'Launch with node scripts/library-pagination-fixture.mjs');
const timeout = setTimeout(() => { console.error('Selection fixture timeout'); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 1000,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  const run = (code) => win.webContents.executeJavaScript(code, true);
  const until = async (code) => { for (let i = 0; i < 150; i++) { if (await run(code)) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error(`Not ready: ${code}\n${await run('document.body.innerText')}`); };
  // Portaled confirmations are last in DOM order. "Process" also exists in
  // Needs Attention, so target the modal action when a confirmation is open.
  const button = (label) => `Array.from(document.querySelectorAll('button')).reverse().find(button => button.textContent.trim() === ${JSON.stringify(label)})`;
  const click = async (label) => { await until(`!!${button(label)} && !${button(label)}.disabled`); await run(`${button(label)}.click()`); };
  const selected = () => run('[...window.fixture.selection.getState().selected].sort()');
  const setSearch = async (value) => {
    await run(`(() => { const input = document.querySelector('input[placeholder^="Search titles"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  };
  const ids = (start, end) => Array.from({ length: end - start }, (_, index) => `selection-${start + index}`).sort();
  await win.loadURL(base);
  win.show(); win.focus(); win.webContents.focus();
  await until('window.fixture?.store.getState().items.length === 50');
  await click('Select all loaded');
  assert.deepEqual(await selected(), ids(0, 50));
  await click('Load more (50 of 120)');
  await until('window.fixture.store.getState().items.length === 100');
  assert.deepEqual(await selected(), ids(0, 50));
  await click('Cancel');
  await click('Select all 120 matching');
  await until('window.fixture.selection.getState().selected.size === 120');
  assert.deepEqual(await selected(), ids(0, 120));
  await run('window.fixture.arrive()');
  await until('window.fixture.store.getState().total === 121 && !window.fixture.store.getState().refreshing');
  assert.deepEqual(await selected(), ids(0, 120));
  await click('Load more (100 of 121)');
  await until('window.fixture.store.getState().items.length === 121');
  assert.deepEqual(await selected(), ids(0, 120));
  await click('Processed109');
  await until('window.fixture.store.getState().query.filter === "done" && !window.fixture.store.getState().loadingInitial');
  assert.deepEqual(await selected(), ids(0, 120));
  await setSearch('synthetic');
  await until('document.body.textContent.includes("Title matches") && !document.body.textContent.includes("searching…")');
  assert.deepEqual(await selected(), ids(0, 120));
  assert.equal(await run(`Array.from(document.querySelectorAll('button')).some(button => /^Select all [0-9]+ matching$/.test(button.textContent))`), false);
  await click('Cancel');
  const priorGlobalIds = await run('window.fixture.calls.ids.length');
  await click('Select all loaded');
  assert.deepEqual(await selected(), ids(110, 112));
  assert.equal(await run('window.fixture.calls.ids.length'), priorGlobalIds, 'Search selection must not query global browse IDs');
  await click('Cancel');
  await setSearch('');
  await click('All121');
  await until('window.fixture.store.getState().query.filter === "all" && !window.fixture.store.getState().loadingInitial');
  await click('Select all 121 matching');
  await until('window.fixture.selection.getState().selected.size === 121');
  // Explicitly deselect the later arrival: the bulk snapshot below is exactly
  // the original 120 IDs, including off-page/non-pending rows.
  await run('window.fixture.selection.getState().toggle("later-arrival")');
  await until(`!!${button('Process (12)')}`);
  // Change the backend status and click in the same renderer turn: the bar
  // still says 12, but opening the confirmation must freshly hydrate 11.
  await run(`window.fixture.statusChanged(); ${button('Process (12)')}.click()`);
  await until('document.body.innerText.includes("Process 11 pending recordings?")');
  assert.equal(await run('document.activeElement.textContent'), 'Cancel');
  await click('Process');
  await until('window.fixture.calls.process.length === 1 && !window.fixture.selection.getState().busy');
  assert.deepEqual(await run('window.fixture.calls.process[0].sort()'), ids(0, 11));
  const retained = ['selection-0', ...ids(11, 120)].sort();
  assert.deepEqual(await selected(), retained, 'Failed and non-pending IDs remain selected');
  await click('Delete (110)');
  await until('document.body.innerText.includes("Move 110 meetings to Recently deleted?")');
  await click('Delete');
  await until('window.fixture.calls.delete.length === 110 && !window.fixture.selection.getState().busy');
  assert.deepEqual(await run('window.fixture.calls.delete.slice().sort()'), retained);
  assert.deepEqual(await selected(), ['selection-0', 'selection-11']);
  await until('document.body.innerText.includes("108 meetings moved to Recently deleted")');
  assert.equal(await run('document.body.innerText.includes("2 not deleted; still selected for retry.")'), true);
  await click('Undo');
  await until('window.fixture.calls.undo.length === 108');
  assert.deepEqual(await run('window.fixture.calls.undo.slice().sort()'), ids(12, 120));
  assert.deepEqual(await selected(), ['selection-0', 'selection-11']);
  assert.deepEqual(errors, []);
  await until('document.body.textContent.includes("2 selected")');
  await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 250))))');
  fs.writeFileSync(path.join(profile, 'selection-after-undo.png'), (await win.webContents.capturePage()).toPNG());
  console.log('PASS selection: loaded=50, matching=120; fixed across paging/arrival/filter/search; search-only=2; process=11 (10 success/1 retained); delete=110 (108 success/1 rejected/1 no-op); Undo=108 successful-only');
  console.log('ISOLATED_PROFILE', profile);
  clearTimeout(timeout); win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
