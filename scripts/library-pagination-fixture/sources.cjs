const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-sources-fixture-'));
app.setPath('userData', profile);
process.on('exit', () => fs.rmSync(profile, { recursive: true, force: true }));
const url = process.env.MN_LIBRARY_FIXTURE_URL;
assert(url?.startsWith('http://127.0.0.1:'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 700, height: 850, webPreferences: { contextIsolation: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  const run = code => win.webContents.executeJavaScript(code, true);
  const until = async expression => {
    for (let i = 0; i < 100; i++) { if (await run(expression)) return; await new Promise(r => setTimeout(r, 30)); }
    throw new Error(expression);
  };
  await win.loadURL(url);
  await until('!!document.querySelector("[data-source-pid=\\"502\\"]")');
  assert(await run('document.body.innerText.includes("Zoom · 2 audio streams")'));
  await run(`const title=document.querySelector('input[placeholder="Use the default title"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(title,'Platform planning');title.dispatchEvent(new Event('input',{bubbles:true}));`);
  await run('window.fixture.fail=true; Array.from(document.querySelectorAll("button")).find(b => b.textContent === "Refresh").click()');
  await until('document.body.innerText.includes("Could not refresh sources")');
  assert.equal(await run('!!document.querySelector("[data-source-pid=\\"502\\"]")'),true,'Failed refresh keeps usable sources');
  await run('window.fixture.fail=false; Array.from(document.querySelectorAll("button")).find(b => b.textContent === "Retry").click()');
  await until('!document.body.innerText.includes("Could not refresh sources")');
  assert.equal(await run('window.fixture.refreshes'),3);
  assert.equal(await run('document.querySelector("input[placeholder=\\"Use the default title\\"]").value'),'Platform planning');
  assert.equal(await run('window.fixture.picks.length'),0,'Refreshing never silently chooses a source');
  for (const pid of [501,502]) {
    await run(`document.querySelector('[data-source-pid="${pid}"]').click()`);
    assert.equal(await run('window.fixture.picks.at(-1).targetPid'), pid);
    assert.equal(await run('window.fixture.picks.at(-1).groupId'), 'g');
    assert.equal(await run('window.fixture.picks.at(-1).title'), 'Platform planning');
  }
  assert.equal(await run('!!document.querySelector("[data-source-pid=\\"700\\"]")'), false);
  await run('Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("Background processes")).click()');
  await until('!!document.querySelector("[data-source-pid=\\"700\\"]")');
  await run('document.querySelector("[data-source-pid=\\"700\\"]").click()');
  assert.equal(await run('window.fixture.picks.at(-1).targetPid'),700);
  const count = await run('window.fixture.picks.length');
  await run('document.querySelector("[data-source-pid=\\"600\\"]").click()');
  await until('document.body.innerText.includes("Start anyway")');
  assert.equal(await run('window.fixture.picks.length'),count);
  await run('Array.from(document.querySelectorAll("button")).find(b => b.textContent === "Start anyway").click()');
  assert.equal(await run('window.fixture.picks.at(-1).targetPid'),600);
  await run('Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("All system audio (catch-all)")).click()');
  assert.equal(await run('window.fixture.picks.at(-1).targetPid'),'system');
  assert.deepEqual(errors,[]);
  if (process.env.MN_FIXTURE_RESULTS) fs.writeFileSync(path.join(process.env.MN_FIXTURE_RESULTS,'sources.png'),(await win.webContents.capturePage()).toPNG());
  console.log('SOURCE PICKER PASS: distinct audible helpers, app grouping, background disclosure, idle confirmation, group assignment, system fallback');
  win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
