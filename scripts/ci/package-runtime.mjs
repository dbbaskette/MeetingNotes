// Run with the packaged Electron binary in ELECTRON_RUN_AS_NODE mode. Uses
// only synthetic fixtures and a private summary loopback server; no speech inference.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const [appPath, fixtureRoot, outputRoot] = process.argv.slice(2);
assert(appPath && fixtureRoot && outputRoot);
const resources = path.join(appPath, 'Contents/Resources');
const moduleUrl = file => pathToFileURL(path.join(resources, 'app.asar/dist/electron/main', file)).href;
const { LMStudioClient } = await import(moduleUrl('lm-studio/client.js'));
const { AppEnumerator } = await import(moduleUrl('recording/app-enumerator.js'));
assert(!fs.existsSync(path.join(resources, 'sidecar')), 'Legacy Python payload must not ship');
assert(fs.existsSync(path.join(resources, 'bin/meeting-notes-speech')), 'Native helper must ship');
assert.equal(typeof LMStudioClient.prototype.transcribe, 'undefined', 'Remote/legacy STT transport must not ship');
const sourceList = await new AppEnumerator({ helperPath: path.join(resources, 'bin/meeting-notes-tap') }).list();
console.log(`PASS packaged helper enumeration (${sourceList.length} sources; no capture)`);
const requests = [];
const mock = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString(); requests.push({ url: req.url, body });
  res.setHeader('content-type', 'application/json');
  if (req.url === '/v1/models') res.end(JSON.stringify({data: [{id:'synthetic-model'}]}));
  else if (req.url === '/v1/chat/completions') res.end(JSON.stringify({choices:[{message:{content:'Synthetic summary'}}]}));
  else {res.statusCode=404;res.end('{}');}
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
try {
  const url = `http://127.0.0.1:${mock.address().port}`;
  const client = new LMStudioClient(() => url);
  assert.deepEqual(await client.listModels(), ['synthetic-model']);
  assert.equal(await client.chat({model:'synthetic-model',messages:[{role:'user',content:'Synthetic prompt'}]}),'Synthetic summary');
  assert(requests.find(r => r.url === '/v1/chat/completions').body.includes('Synthetic prompt'));
  console.log('PASS packaged summary provider transport (synthetic HTTP responses, not real model inference)');
} finally { await new Promise(resolve => mock.close(resolve)); }

// Agents use only enumeration above; this assertion prevents a test fixture
// from quietly becoming a capture command during later maintenance.
assert(!requests.some(request => request.url?.includes('record')));
process.exit(0);
