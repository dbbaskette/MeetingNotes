const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-243-ui-'));
app.commandLine.appendSwitch('enable-precise-memory-info');
app.setPath('userData', profile);
process.on('exit', () => fs.rmSync(profile, { recursive: true, force: true }));
app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({
        show: false,
        width: 1100,
        height: 850,
        webPreferences: { contextIsolation: true, backgroundThrottling: false },
      }),
      errors = [];
    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 2 && !message.includes('Electron Security Warning')) errors.push(message);
    });
    const run = (code) => win.webContents.executeJavaScript(code, true),
      settle = () =>
        run(
          'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,60))))',
        );
    const until = async (expression) => {
      for (let i = 0; i < 100; i++) {
        if (await run(expression)) return;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      throw Error(expression);
    };
    const results = { before: [], after: [] };
    for (let sample = 0; sample < 4; sample++)
      for (const baseline of sample % 2 ? [false, true] : [true, false]) {
        await win.loadURL('about:blank');
        await win.loadURL(
          process.env.MN_LIBRARY_FIXTURE_URL + `?sample=${sample}${baseline ? '&baseline' : ''}`,
        );
        await until(
          'window.fixture && document.querySelectorAll("#scroll button[title^=Jump]").length>0',
        );
        await settle();
        const mounted = await run(
          'document.querySelectorAll("#scroll button[title^=Jump]").length',
        );
        console.log('Sample', sample, baseline, win.webContents.getURL(), mounted);
        assert(baseline ? mounted === 12000 : mounted < 100, `Transcript rows: ${mounted}`);
        const heap = app
          .getAppMetrics()
          .find((metric) => metric.pid === win.webContents.getOSProcessId())?.memory;
        const commit = await run('fixture.commits.reduce((a,b)=>a+b,0)');
        await run('fixture.commits=[];fixture.setTime(100)');await settle();
        const playback=await run('fixture.commits.reduce((a,b)=>a+b,0)');
        if (sample)
          results[baseline ? 'before' : 'after'].push({
            commit,
            playback,
            mounted,
            workingSetKB: heap?.workingSetSize,
            jsHeapBytes: await run('performance.memory.usedJSHeapSize'),
          });
      }
    const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    results.medians = {
      before: median(results.before.map((x) => x.commit)),
      after: median(results.after.map((x) => x.commit)),
    };
    assert(results.medians.after < results.medians.before * 0.5, JSON.stringify(results));
    await win.loadURL('about:blank');
    await win.loadURL(process.env.MN_LIBRARY_FIXTURE_URL);
    await until('window.fixture && document.querySelectorAll("[data-transcript-index]").length>0');
    win.show();
    win.focus();
    app.focus({ steal: true });
    win.webContents.focus();
    await until('document.hasFocus()');
    await run(
      `const input=document.querySelector('input[aria-label="Find in full transcript"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'NEEDLE-UNMOUNTED');input.dispatchEvent(new Event('input',{bubbles:true}));`,
    );
    await settle();
    await run(
      `Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Next').click()`,
    );
    await settle();
    await until(`!!document.querySelector('[data-transcript-index="11000"]')`);
    assert(
      await run(
        `document.querySelector('[data-transcript-index="11000"]').contains(document.activeElement)`,
      ),
    );
    await run('fixture.setTime(21000)');
    await settle();
    await until(`!!document.querySelector('[data-transcript-index="10500"]')`);
    await run(
      'document.getElementById("scroll").dispatchEvent(new WheelEvent("wheel",{bubbles:true}));document.getElementById("scroll").scrollTop=0;fixture.setTime(22000)',
    );
    await settle();
    assert(await run('document.getElementById("scroll").scrollTop<2000'),'Playback must respect manual scroll');
    await run(
      'Array.from(document.querySelectorAll("button")).find(button=>button.textContent==="Grouped").click()',
    );
    await settle();
    assert(await run('document.querySelectorAll("[data-transcript-index]").length<100'));
    win.setSize(680, 600);
    win.webContents.setZoomFactor(1.25);
    await run('document.documentElement.classList.add("dark")');
    await settle();
    assert(await run('document.querySelectorAll("[data-transcript-index]").length<100'));
    assert(await run('document.documentElement.scrollWidth<=innerWidth'),'Narrow/zoomed transcript must not overflow horizontally');
    win.setSize(1100, 850);
    win.webContents.setZoomFactor(1);
    await settle();
    await run(
      'document.querySelector("#open-modal").focus();document.querySelector("#open-modal").click()',
    );
    await settle();
    assert(await run('document.querySelector("#root").inert'));
    await run(
      'document.querySelector("#dialog-edit").focus();document.querySelector("#dialog-edit").setSelectionRange(2,5);fixture.rerender()',
    );
    await settle();
    assert.equal(await run('document.activeElement.id'), 'dialog-edit');
    assert.equal(await run('document.activeElement.selectionStart'), 2);
    assert.equal(await run('document.activeElement.selectionEnd'), 5);
    await run('document.querySelector("#nested").click()');
    await settle();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await settle();
    assert.equal(await run('document.querySelectorAll("[role=dialog]").length'), 1);
    await run('document.querySelector("#make-busy").click()');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await settle();
    assert.equal(await run('document.querySelectorAll("[role=dialog]").length'), 1);
    await run('document.querySelector("#make-busy").click()');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await settle();
    assert.equal(await run('document.activeElement.id'), 'open-modal');
    assert.equal(await run('document.querySelector("#root").inert'), false);
    await run('fixture.setMode("row")');
    await settle();
    await run('document.querySelector("[role=button]").focus()');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    await settle();
    assert.equal(await run('fixture.opened'), 1);
    await run('document.querySelector("[role=checkbox]").focus()');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await settle();
    assert.equal(await run('fixture.toggled'), 1);
    await run('document.querySelector("[role=button]").focus()');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    await settle();
    assert.equal(await run('fixture.toggled'), 2);
    await run('fixture.setMode("tasks")');
    await settle();
    await run('document.querySelector("input[type=checkbox]").click()');
    await settle();
    assert.equal(await run('document.querySelector("input[type=checkbox]").checked'), false);
    assert(
      await run(
        'document.querySelector("[role=alert]").textContent.includes("Synthetic save failed")',
      ),
    );
    await run(
      'Array.from(document.querySelectorAll("button")).find(button=>button.textContent==="Retry").click()',
    );
    await settle();
    assert.equal(await run('document.querySelector("input[type=checkbox]").checked'), true);
    assert.equal(await run('fixture.saved'), 1);
    await run(
      `const due=document.querySelector('input[type=date]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(due,'2026-10-10');due.dispatchEvent(new Event('input',{bubbles:true}));`,
    );
    await settle();
    await run(
      'Array.from(document.querySelectorAll("button")).find(button=>button.textContent==="Save").click()',
    );
    await settle();
    assert.deepEqual(await run('fixture.taskCalls.at(-1)'), {
      kind: 'update',
      patch: { dueDate: '2026-10-10' },
    });
    await run(
      'Array.from(document.querySelectorAll("button")).find(button=>button.textContent==="Snooze 1 week").click()',
    );
    await settle();
    assert.match(await run('fixture.taskCalls.at(-1).patch.dueDate'), /^\d{4}-\d{2}-\d{2}$/);
    assert(
      await run('document.querySelector("details").textContent.includes("Original task source")'),
    );
    assert.deepEqual(errors, []);
    console.log('Epic 243 transcript benchmark and keyboard fixtures:', JSON.stringify(results));
    if (process.env.MN_FIXTURE_RESULTS)
      fs.writeFileSync(
        path.join(process.env.MN_FIXTURE_RESULTS, 'epic243-benchmark.json'),
        JSON.stringify(results, null, 2),
      );
    win.destroy();
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
