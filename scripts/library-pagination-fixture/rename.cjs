const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-rename-fixture-'));
app.setPath('userData', profile);
process.on('exit', () => fs.rmSync(profile, { recursive: true, force: true }));
const base = process.env.MN_LIBRARY_FIXTURE_URL;
assert(base?.startsWith('http://127.0.0.1:'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 1000,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  const run = code => win.webContents.executeJavaScript(code, true).catch(error => {
    throw Error(`${code}: ${error.message}\nRenderer errors: ${errors.join('\n')}`);
  });
  const until = async code => {
    for (let i = 0; i < 200; i++) {
      assert.deepEqual(errors, [], 'No renderer crashes or React errors');
      if (await run(code)) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw Error(`Not ready: ${code}\n${await run('document.body.innerText')}`);
  };
  const button = text => `[...document.querySelectorAll('button')].filter(b => b.getClientRects().length).find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
  const click = async text => { await until(`!!${button(text)}`); await run(`${button(text)}.click()`); };
  const row = title => `document.querySelector('[aria-label=${JSON.stringify(`Open ${title}`)}]')`;
  const input = async (selector, value) => {
    await run(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  };
  // Virtual rows measure layout in requestAnimationFrame. Read scroll only
  // after both that measurement and the resulting React layout have painted.
  const settleLayout = () => run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const open = async title => {
    await until(`!!${row(title)}`); await run(`${row(title)}.click()`);
    await until(`!!document.querySelector('[title="Click to rename"]')`);
  };
  const inlineRename = async title => {
    await run(`document.querySelector('[title="Click to rename"]').click()`);
    await input('[aria-label="Meeting title"]', title);
    await run(`document.querySelector('[aria-label="Meeting title"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    await until(`document.querySelector('[title="Click to rename"]')?.textContent.includes(${JSON.stringify(title)})`);
  };
  const menuRename = async (title, fail = false) => {
    await click('Rename…'); await until('!!document.querySelector("[aria-modal=true] input")');
    await input('[aria-modal=true] input', title); await click('Save');
    await until(fail ? 'document.body.innerText.includes("Synthetic rename rejected")' : '!document.querySelector("[aria-modal=true]")');
  };
  const group = '00000000-0000-4000-8000-000000000001';
  const planning = `document.querySelector('#group-rows-${group}')`;
  const scroller = `document.querySelector('[aria-label="Meeting library"]')`;
  await win.loadURL(base + '?startup&rename');
  await until('!!window.fixture && document.querySelectorAll("section [aria-expanded=true]").length === 3');
  // Keep one expanded group and load two pages. Returning must not recreate it.
  await run('document.querySelector("[aria-controls=group-rows-ungrouped]").click(); document.querySelector("[aria-controls=group-rows-00000000-0000-4000-8000-000000000002]").click()');
  await until(`!!${planning} && ${planning}.textContent.includes('Load more (50 of 200)')`);
  await click('Load more (50 of 200)');
  await until(`${planning}.textContent.includes('Load more (100 of 200)')`);
  await settleLayout();
  await run(`(() => { const scroll = ${scroller}; scroll.scrollTop += ${planning}.getBoundingClientRect().top - scroll.getBoundingClientRect().top + 300; })()`);
  await settleLayout();
  const before = await run(`${scroller}.scrollTop`);
  await open('Synthetic meeting 205');
  await inlineRename('Updated grouped meeting'); await click('← Back');
  await until(`!!${row('Updated grouped meeting')}`);
  await settleLayout();
  assert.equal(await run(`${scroller}.scrollTop`), before, 'Return preserves scroll');
  assert.equal(await run('document.querySelectorAll("section [aria-expanded=true]").length'), 1, 'Return preserves expansion');
  assert.ok(await run(`${planning}.textContent.includes('Load more (100 of 200)')`), 'Return preserves loaded pages');
  // A stale group page pending before rename cannot win after navigation.
  await run('window.fixture.holdGroupRefresh()'); await until('window.fixture.groupPageHeld()');
  await open('Updated grouped meeting'); await inlineRename('Fresh after pending page'); await click('← Back');
  await run('window.fixture.releaseGroupPage()');
  await until(`!!${row('Fresh after pending page')}`);
  // Both detail rename entry points and rejected writes retain correct titles.
  await open('Fresh after pending page');
  await run('[...document.querySelectorAll("button[aria-label=Actions]")].find(b => b.getClientRects().length).click()');
  await menuRename('Details menu title'); await click('← Back'); await until(`!!${row('Details menu title')}`);
  await open('Details menu title'); await run('window.fixture.rejectRename(true)');
  await run('[...document.querySelectorAll("button[aria-label=Actions]")].find(b => b.getClientRects().length).click()');
  await menuRename('Not saved', true); await click('Cancel'); await click('← Back');
  await until(`!!${row('Details menu title')}`);
  assert.equal(await run(`!!${row('Not saved')}`), false);
  await run('window.fixture.rejectRename(false)');
  // Existing Library row rename still updates its section without navigation.
  await run(`${row('Details menu title')}.querySelector('button[aria-label=Actions]').click()`);
  await menuRename('Library row title'); await until(`!!${row('Library row title')}`);
  // Flat list and focused-group browsing use the same activation boundary.
  await click('All meetings'); await until(`!!${row('Synthetic meeting 0')}`);
  await open('Synthetic meeting 0'); await inlineRename('Updated flat meeting'); await click('← Back');
  await until(`!!${row('Updated flat meeting')}`);
  await click('Organized');
  await until(`!!document.querySelector('[aria-label="View only Planning"]')`);
  await run(`document.querySelector('[aria-label="View only Planning"]').click()`);
  await until(`!!${row('Synthetic meeting 200')}`);
  await open('Synthetic meeting 200'); await inlineRename('Updated scoped meeting'); await click('← Back');
  await until(`!!${row('Updated scoped meeting')}`);
  assert.equal(await run('window.fixture.store.getState().query.groupId'), group);
  // An unchanged search must rehydrate titles, rather than keeping old hits.
  await win.loadURL(base + '?rename');
  await until('window.fixture?.store.getState().items.length === 50');
  await input('input[placeholder^="Search titles"]', 'synthetic');
  await until(`!!${row('Synthetic meeting 110')}`);
  await open('Synthetic meeting 110'); await inlineRename('Updated search title'); await click('← Back');
  await until(`!!${row('Updated search title')}`);
  assert.equal(await run(`document.querySelector('input[placeholder^="Search titles"]').value`), 'synthetic');
  assert.deepEqual(errors, []);
  console.log('RENAME PASS: real detail inline/menu rename and Back refresh grouped/flat/scoped/search views; pages, expansion and scroll retained; pending stale page, rejected write and Library row rename covered.');
  win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
