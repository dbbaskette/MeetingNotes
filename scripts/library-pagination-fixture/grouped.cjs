const {app,BrowserWindow} = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const profile = fs.mkdtempSync(path.join(os.tmpdir(),'mn-group-fixture-')); app.setPath('userData',profile);
process.on('exit',() => fs.rmSync(profile,{recursive: true,force: true}));
const base = process.env.MN_LIBRARY_FIXTURE_URL; assert(base?.startsWith('http://127.0.0.1:'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({show: false,width: 1100,height: 900,webPreferences: {contextIsolation: true,backgroundThrottling: false}});
  win.webContents.on('console-message',(_event,level,message) => {if(level>=2) console.error('Renderer:',message);});
  const run = code => win.webContents.executeJavaScript(code,true).catch(error => {throw new Error(`${code}: ${error.message}`);});
  const settle = () => run('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r,40))))');
  const count = () => run('document.querySelectorAll("[data-meeting-id]").length');
  const until = async expression => {for(let i=0;i<100;i++){if(await run(expression))return;await new Promise(r => setTimeout(r,30));}throw new Error(expression);};
  const times = {before: [],after: []};
  for(let sample=0;sample<5;sample++) for(const plain of sample%2 ? [false,true] : [true,false]) {
    await win.loadURL(base+(plain?'?plain':'')); await until('window.fixture && document.querySelectorAll("[data-meeting-id]").length > 0'); await settle();
    const mounted = await count(); assert(plain ? mounted===3000 : mounted<40, `mounted ${mounted}`);
    const duration = await run('window.fixture.commits.reduce((a,b) => a+b,0)'); if(sample) times[plain?'before':'after'].push(duration);
  }
  await win.loadURL(base); await settle(); await until('document.querySelectorAll("[data-meeting-id]").length > 0');
  if (process.env.MN_FIXTURE_FOCUS === '1') {win.show(); win.focus(); app.focus({steal: true}); win.webContents.focus(); await until('document.hasFocus()');}
  await run('document.querySelector("[data-meeting-id=m-0] button[aria-label=Select]").focus()');
  await settle();
  await run('document.querySelector("#viewport").scrollTop=108000'); await settle();
  assert(await count()<40); if (process.env.MN_FIXTURE_FOCUS === '1') assert.equal(await run('document.activeElement.closest("[data-meeting-id]")?.dataset.meetingId'),'m-0');
  await run('document.querySelector("#outside").focus()'); await settle(); assert.equal(await run('!!document.querySelector("[data-meeting-id=m-0]")'),false);
  await run('document.querySelector("#collapse").click()'); await settle(); assert(await count()<40);
  await run('document.querySelector("#viewport").scrollTop=0'); await settle(); assert.equal(await run('document.querySelector("[data-meeting-id]").dataset.meetingId'),'m-1000');
  const median = values => values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
  console.log('GROUPED PASS',JSON.stringify({baselineMounted: 3000,afterMounted: await count(),beforeReactMedianMs: median(times.before),afterReactMedianMs: median(times.after),focusRetention: process.env.MN_FIXTURE_FOCUS === '1',collapseReflow: true}));
  win.destroy(); app.quit();
}).catch(e => {console.error(e);app.exit(1);});
