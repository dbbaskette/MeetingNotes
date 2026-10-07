// Run with the packaged Electron binary in ELECTRON_RUN_AS_NODE mode. Uses
// only synthetic fixtures, cached offline models and a private loopback server.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [appPath, fixtureRoot, outputRoot] = process.argv.slice(2);
assert(appPath && fixtureRoot && outputRoot);
const resources = path.join(appPath, 'Contents/Resources');
const moduleUrl = file => pathToFileURL(path.join(resources, 'app.asar/dist/electron/main', file)).href;
const { LMStudioClient } = await import(moduleUrl('lm-studio/client.js'));
const { DiarizationClient } = await import(moduleUrl('diarization/client.js'));
const { AppEnumerator } = await import(moduleUrl('recording/app-enumerator.js'));
const sourceList = await new AppEnumerator({ helperPath: path.join(resources, 'bin/meeting-notes-tap') }).list();
console.log(`PASS packaged helper enumeration (${sourceList.length} sources; no capture)`);
const requests = [];
const mock = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString(); requests.push({ url: req.url, body });
  res.setHeader('content-type', 'application/json');
  if (req.url === '/v1/models') res.end(JSON.stringify({data: [{id:'synthetic-model'}]}));
  else if (req.url === '/v1/audio/transcriptions') res.end(JSON.stringify({text:'Synthetic speech',segments:[{start:0,end:1,text:'Synthetic speech'}]}));
  else if (req.url === '/v1/chat/completions') res.end(JSON.stringify({choices:[{message:{content:'Synthetic summary'}}]}));
  else {res.statusCode=404;res.end('{}');}
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
try {
  const url = `http://127.0.0.1:${mock.address().port}`;
  const client = new LMStudioClient(() => url);
  assert.deepEqual(await client.listModels(), ['synthetic-model']);
  assert.equal((await client.transcribe({audioPath:path.join(fixtureRoot,'speech.wav'),model:'synthetic-stt',language:'en'})).text,'Synthetic speech');
  assert.equal(await client.chat({model:'synthetic-model',messages:[{role:'user',content:'Synthetic prompt'}]}),'Synthetic summary');
  assert(requests.find(r => r.url === '/v1/audio/transcriptions').body.includes('synthetic-stt'));
  assert(requests.find(r => r.url === '/v1/chat/completions').body.includes('Synthetic prompt'));
  console.log('PASS packaged configured STT and summary provider transport (synthetic HTTP responses, not real model inference)');
} finally { await new Promise(resolve => mock.close(resolve)); }

// Locate a free port without interfering with the user/guest's model services.
const reservation = http.createServer();
await new Promise(resolve => reservation.listen(0,'127.0.0.1',resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const binary = path.join(resources,'sidecar/dist/meeting-notes-diarize/meeting-notes-diarize');
const logFd = fs.openSync(path.join(outputRoot,'sidecar.log'),'w');
const cache = path.join(fixtureRoot,'hub');
assert(fs.existsSync(cache));
const sidecar = spawn(binary,['--host','127.0.0.1','--port',String(port)],{stdio:['ignore',logFd,logFd],env:{...process.env,
  HF_TOKEN:'offline-synthetic-fixture', HF_HUB_OFFLINE:'1', HF_HUB_CACHE:cache,
  TORCH_HOME:path.join(outputRoot,'torch-cache'),MPLCONFIGDIR:path.join(outputRoot,'mpl-cache'),
  HF_HOME:path.join(outputRoot,'hf-empty'),ELECTRON_RUN_AS_NODE:''}});
let spawnError; sidecar.once('error',error => {spawnError=error;});
try {
  let health;
  for(let i=0;i<180;i++) {
    if(spawnError) throw spawnError;
    if(sidecar.exitCode !== null) throw new Error(`Packaged sidecar exited ${sidecar.exitCode}`);
    try {const response=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(1000)});if(response.ok){health=await response.json();break;}} catch {}
    await new Promise(resolve => setTimeout(resolve,1000));
  }
  assert(health,'Packaged sidecar health timeout');
  assert(health.build_id);
  const result = await new DiarizationClient(`http://127.0.0.1:${port}`).diarize(path.join(fixtureRoot,'speech.wav'));
  assert(result.segments.length > 0 && result.num_speakers > 0);
  for(const segment of result.segments) {
    assert(segment.end > segment.start && segment.embedding.length > 0 && segment.embedding.every(Number.isFinite));
    assert(segment.embedding.some(value => value !== 0),'Zero speaker embedding');
  }
  fs.writeFileSync(path.join(outputRoot,'inference.json'),JSON.stringify({health,segments:result.segments.length,numSpeakers:result.num_speakers,offline:true},null,2));
  console.log('PASS packaged sidecar health and real offline diarization of synthetic speech (finite, nonzero embeddings)');
} finally {
  if(sidecar.exitCode === null) {
    sidecar.kill('SIGTERM');
    await Promise.race([new Promise(resolve => sidecar.once('exit',resolve)),new Promise(resolve => setTimeout(resolve,5000))]);
    if(sidecar.exitCode === null) sidecar.kill('SIGKILL');
  }
  fs.closeSync(logFd);
}
// Agents use only enumeration above; this assertion prevents a test fixture
// from quietly becoming a capture command during later maintenance.
assert(!requests.some(request => request.url?.includes('record')));
process.exit(0);
