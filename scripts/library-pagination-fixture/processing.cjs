const {app, BrowserWindow} = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-processing-fixture-'));
app.setPath('userData', profile);
process.on('exit', () => fs.rmSync(profile, {recursive: true, force: true}));
const base = process.env.MN_LIBRARY_FIXTURE_URL;
assert(base?.startsWith('http://127.0.0.1:'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({show: false, width: 900, height: 600,
    webPreferences: {contextIsolation: true, nodeIntegration: false, backgroundThrottling: false}});
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => {if (level >= 3) errors.push(message);});
  const run = code => win.webContents.executeJavaScript(code, true).catch(error => { throw new Error(`${code}: ${error.message}\nRenderer errors: ${errors.join('\n')}`); });
  const settle = () => run('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 150))))');
  const until = async code => {
    for (let i = 0; i < 200; i++) {
      assert.deepEqual(errors, [], 'No renderer crashes or React errors');
      if (await run(code)) return;
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error(`Not ready: ${code}\n${await run('document.body.innerText')}`);
  };
  const button = label => `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})`;
  const scroller = `document.querySelector('[aria-label="Meeting library"]')`;
  const progressRow = `document.querySelector('[role=button][aria-label="Open Synthetic meeting 1"]')`;
  const showFirstRows = async () => {
    await run(`(() => { const scroll=document.querySelector('[aria-label="Meeting library"]'); const rows=document.querySelector('#group-rows-ungrouped') ?? scroll.querySelector('section > div .relative'); scroll.scrollTop += rows.getBoundingClientRect().top-scroll.getBoundingClientRect().top; })()`);
    await settle();
  };
  await win.loadURL(base + '?startup&processing');
  await until('!!window.fixture && document.querySelectorAll("section [aria-expanded=true]").length === 3');
  await settle();
  await run('window.fixture.selection.getState().toggle("selection-1"); window.fixture.selection.getState().toggle("selection-12")');
  await until(`!!${button('Process (1)')}`);
  await run(`${button('Process (1)')}.click()`);
  await settle();
  await until('window.fixture.calls.process.length === 1 && !window.fixture.selection.getState().busy');
  assert.equal(await run('!!document.querySelector("[aria-modal=true]")'), false, 'Processing never opens a blocking dialog');
  assert.equal(await run('document.body.innerText.includes("Processing 1 recording")'), false, 'Inline queue status is not repeated in a success popup');
  await showFirstRows();
  await until(`!!${progressRow}`);
  assert.ok(await run(`(() => { const row=${progressRow}, rect=row.getBoundingClientRect(); return row.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)); })()`), 'A visible processing row receives the click, not an overlay');
  await run(`${progressRow}.click()`);
  assert.deepEqual(await run('window.fixture.calls.opened'), ['selection-1'], 'Processing row opens despite another selected meeting');
  assert.deepEqual(await run('[...window.fixture.selection.getState().selected]'), ['selection-12']);
  await run(`${progressRow}.querySelector('[role=checkbox]').click()`);
  assert.deepEqual(await run('[...window.fixture.selection.getState().selected].sort()'), ['selection-1', 'selection-12'], 'Processing checkboxes remain explicitly selectable');
  await run(`${progressRow}.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  assert.equal(await run('window.fixture.calls.opened.length'), 2, 'Enter opens progress rather than toggling it');
  await run(`${progressRow}.querySelector('[role=checkbox]').click()`);
  for (const view of ['Organized', 'All meetings']) {
    await run(`${button(view)}.click()`); await settle();
    for (const [width, height, zoom] of [[900,600,1], [1100,700,1.25], [1440,1000,1]]) {
      win.setSize(width, height); win.webContents.setZoomFactor(zoom); await settle();
      assert.equal(await run(`document.documentElement.scrollHeight > innerHeight + 1`), false, 'Library does not spill outside its window');
      assert.equal(await run(`[...document.querySelectorAll('div')].filter(el=>getComputedStyle(el).overflowY==='auto' && el.scrollHeight>el.clientHeight+1).length`), 1, 'Inbox and Library use one scroll surface');
      await run(`${scroller}.scrollTop = 1700`); await settle();
      const top = await run(`${scroller}.scrollTop`);
      assert.ok(top > 1000);
      await run('window.fixture.pushStage()'); await settle();
      assert.equal(await run(`${scroller}.scrollTop`), top, 'Pipeline refresh preserves scroll');
      assert.ok(await run('document.querySelectorAll("[role=button][aria-label^=Open]").length < 80'), 'Virtualization remains bounded');
      await run(`${scroller}.scrollTop = 0`); await settle();
    }
  }
  // Routine feedback auto-clears, never sets inert or captures keyboard focus.
  await run(`${button('Pause')}.click()`); await settle();
  assert.ok(await run('document.body.innerText.includes("Queue paused")'));
  assert.equal(await run('document.querySelector("#root").inert'), false);
  assert.equal(await run('!!document.querySelector("[aria-modal=true]")'), false);
  await run(`${button('Resume')}.click()`); await settle();
  await until('!document.body.innerText.includes("Queue paused")');
  // A slow queue acknowledgement must neither lock navigation nor send twice.
  await run('window.fixture.selection.getState().clear(); window.fixture.selection.getState().toggle("selection-2"); window.fixture.holdQueue()');
  await until(`!!${button('Process (1)')}`);
  await run(`${button('Process (1)')}.click(); ${button('Process (1)')}.click()`);
  await until('window.fixture.calls.process.length === 2');
  assert.equal(await run('!!document.querySelector("[aria-modal=true]")'), false);
  await showFirstRows();
  await until(`!!${progressRow}`);
  await run(`${progressRow}.click()`);
  assert.equal(await run('window.fixture.calls.opened.length'), 3);
  await run('window.fixture.finishQueue()');
  await until('!window.fixture.selection.getState().busy');
  // Queue rejection leaves the selection retryable, and its message expires.
  await run('window.fixture.selection.getState().toggle("selection-3"); window.fixture.rejectQueue()');
  await until(`!!${button('Process (1)')}`);
  await run(`${button('Process (1)')}.click()`);
  await until('!window.fixture.selection.getState().busy && document.body.innerText.includes("not queued; still selected for retry")');
  assert.deepEqual(await run('[...window.fixture.selection.getState().selected]'), ['selection-3']);
  await until('!document.body.innerText.includes("not queued; still selected for retry")');
  // Starting from Needs attention also relies only on the inline queue status.
  await run(`${scroller}.scrollTop=0; document.querySelector('[aria-label="Process: Synthetic meeting 4"]').click()`);
  await until(`document.body.innerText.includes(${JSON.stringify('Processing "Synthetic meeting 4"')})`);
  assert.equal(await run('document.body.innerText.includes("Meeting added to the processing queue")'), false);
  await showFirstRows();
  if (process.env.MN_FIXTURE_RESULTS) fs.writeFileSync(path.join(process.env.MN_FIXTURE_RESULTS, 'processing-after.png'), (await win.webContents.capturePage()).toPNG());
  await win.loadURL(base + '?startup&processing&live');
  const stopButton = `[...document.querySelectorAll('button')].find(button=>button.textContent.trim().endsWith('Stop'))`;
  await until(`!!${stopButton} && document.querySelectorAll('section [aria-expanded=true]').length === 3`);
  await run(`${scroller}.scrollTop=1700`); await settle();
  assert.ok(await run(`(() => { const stop=${stopButton}, rect=stop.getBoundingClientRect(); return rect.top>=0 && rect.bottom<innerHeight && stop.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)); })()`), 'Capture Stop remains reachable while meetings scroll');
  assert.equal(await run(`document.documentElement.scrollHeight > innerHeight + 1`), false);
  console.log('PROCESSING PASS: no blocking/redundant popup, processing rows open with selection, single scroll at three sizes/zoom in both views, stable refresh, bounded rows, slow/failed queue and auto-clearing feedback');
  win.destroy(); app.quit();
}).catch(error => {console.error(error); app.exit(1);});
