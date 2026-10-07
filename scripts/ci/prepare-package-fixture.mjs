// Explicit local packaging QA payload. Never copy credentials or a live
// library. Dereference ONLY the three already-cached pyannote model folders.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const [appPath,speechPath]=process.argv.slice(2);
if(!appPath?.endsWith('/MeetingNotes.app')||!speechPath)throw new Error('Pass the disposable built app and synthetic WAV');
const root=path.resolve('.ci-package-fixture');
if(fs.existsSync(root))throw new Error('Payload already exists; preserve it or remove the exact owned fixture before preparing another');
fs.mkdirSync(path.join(root,'hub'),{recursive:true});
fs.cpSync(appPath,path.join(root,'MeetingNotes.app'),{recursive:true});
fs.copyFileSync(speechPath,path.join(root,'speech.wav'));
const cache=process.env.MN_OFFLINE_MODEL_SOURCE??path.join(os.homedir(),'.cache/huggingface/hub');
for(const name of ['speaker-diarization-3.1','segmentation-3.0','wespeaker-voxceleb-resnet34-LM']) {
  const folder=`models--pyannote--${name}`;
  fs.cpSync(path.join(cache,folder),path.join(root,'hub',folder),{recursive:true,dereference:true});
}
fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify({sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  preparedAt:new Date().toISOString(),offlineOnly:true,syntheticSpeech:true},null,2));
console.log(`Prepared task-owned package payload: ${root}`);
