const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-terminology-fixture-'));
app.setPath('userData', profile);
process.on('exit', () => fs.rmSync(profile, { recursive: true, force: true }));
const base = process.env.MN_LIBRARY_FIXTURE_URL;
assert(base?.startsWith('http://127.0.0.1:'));
app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({
      show: false,
      width: 1050,
      height: 900,
      webPreferences: { contextIsolation: true, backgroundThrottling: false },
    });
    const errors = [];
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 3) errors.push(message);
    });
    const run = (code) => win.webContents.executeJavaScript(code, true);
    const until = async (expression) => {
      for (let i = 0; i < 100; i++) {
        if (await run(expression)) return;
        await new Promise((r) => setTimeout(r, 30));
      }
      throw new Error(expression);
    };
    const settle = () =>
      run(
        'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30))))',
      );
    const click = (text) =>
      run(
        `Array.from(document.querySelectorAll('button')).find(b => b.textContent === ${JSON.stringify(text)}).click()`,
      );
    await win.loadURL(base);
    await until('document.body.innerText.includes("Correct terminology…")');
    await run('document.querySelector("[aria-label=\\"Unsaved summary edits\\"]").click()');
    await settle();
    assert(
      await run(
        'Array.from(document.querySelectorAll("button")).find(b => b.textContent === "Correct terminology…").disabled',
      ),
    );
    await run('document.querySelector("[aria-label=\\"Unsaved summary edits\\"]").click()');
    await settle();
    await click('Correct terminology…');
    await settle();
    await run(
      '(() => { const fields = document.querySelectorAll("form input"); for (const [i,value] of ["Salsa","SLSA"].entries()) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(fields[i],value); fields[i].dispatchEvent(new Event("input",{bubbles:true})); } })()',
    );
    await settle();
    await click('Preview matches');
    await until('document.body.innerText.includes("Transcript: 2 · Summary: 1")');
    assert(await run('document.body.innerText.includes("Apply to both (3)")'));
    const toggleSummary = () =>
      run(
        'Array.from(document.querySelectorAll("[aria-label=\\"Terminology corrections\\"] label")).find(l => l.innerText.startsWith("Summary")).querySelector("input").click()',
      );
    await toggleSummary();
    await settle();
    assert(await run('document.body.innerText.includes("Apply to transcript (2)")'));
    await toggleSummary();
    await settle();
    assert(await run('document.body.innerText.includes("Apply to both (3)")'));
    if (process.env.MN_FIXTURE_RESULTS) {
      await settle();
      fs.writeFileSync(
        path.join(process.env.MN_FIXTURE_RESULTS, 'unified-terminology.png'),
        (await win.webContents.capturePage()).toPNG(),
      );
    }
    await run('window.fixture.fail=true');
    await click('Apply to both (3)');
    await until('document.body.innerText.includes("Text changed. Preview again.")');
    assert.equal(await run('window.fixture.commits.length'), 0);
    assert.equal(await run('document.body.innerText.includes("Remember this correction?")'), false);
    await run('window.fixture.fail=false');
    await click('Preview matches');
    await settle();
    await click('Apply to both (3)');
    await until('document.body.innerText.includes("Remember this correction?")');
    assert.equal(await run('window.fixture.commits.length'), 1);
    assert.deepEqual(await run('window.fixture.commits[0].keys'), [
      'transcript/0',
      'transcript/1',
      'summary/2',
    ]);
    assert.equal(await run('window.fixture.commits[0].artifact'), 'meeting');
    assert.equal(
      await run(
        'Array.from(document.querySelectorAll("[aria-label=\\"Remember terminology\\"] input[type=checkbox]")).at(-1).checked',
      ),
      false,
    );
    await click('Remember');
    await until('window.fixture.remembers.length === 1');
    await settle();
    assert.equal(await run('window.fixture.remembers[0].mode'), 'suggest');
    assert.equal(await run('window.fixture.remembers[0].groupId'), 'engineering');
    assert.equal(
      await run('window.fixture.commits.length'),
      1,
      'Remember does not perform another replacement',
    );
    await run(
      'Array.from(document.querySelectorAll("summary")).find(s => s.textContent.includes("Applied corrections (1)")).click()',
    );
    await settle();
    assert.equal(
      await run(
        'Array.from(document.querySelectorAll("button")).filter(b => b.textContent === "Undo").length',
      ),
      1,
    );
    await click('Undo');
    await until('window.fixture.undos.length === 1');
    assert.equal(await run('window.fixture.undos[0].artifact'), 'meeting');
    assert.deepEqual(errors, []);
    console.log(
      'TERMINOLOGY PASS both-document preview/one Apply/grouped Undo/edit blocking/error feedback/explicit remembered scope and mode',
    );
    win.destroy();
    app.quit();
  })
  .catch((e) => {
    console.error(e);
    app.exit(1);
  });
