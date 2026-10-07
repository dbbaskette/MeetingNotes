// Explicit local packaging QA payload. Never copy credentials or a live
// library. Copy ONLY the required already-cached pyannote model folders.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const [appPath,speechPath]=process.argv.slice(2);
if(!appPath?.endsWith('/MeetingNotes.app')||!speechPath)throw new Error('Pass the disposable built app and synthetic WAV');
const root=path.resolve('.ci-package-fixture');
if(fs.existsSync(root))throw new Error('Payload already exists; preserve it or remove the exact owned fixture before preparing another');
fs.mkdirSync(path.join(root,'hub'),{recursive:true});
// Framework symlinks must remain relative/relocatable in the guest. Node's
// default rewrites their targets to absolute host paths.
fs.cpSync(appPath,path.join(root,'MeetingNotes.app'),{recursive:true,verbatimSymlinks:true});
fs.copyFileSync(speechPath,path.join(root,'speech.wav'));
const cache=process.env.MN_OFFLINE_MODEL_SOURCE??path.join(os.homedir(),'.cache/huggingface/hub');
function copyModel(source,dest,allowedRoot) {
  const real=fs.realpathSync(source);
  if(real!==allowedRoot&&!real.startsWith(allowedRoot+path.sep))throw new Error('Cached model link escapes its folder');
  const stat=fs.statSync(real);
  if(stat.isDirectory()) {
    fs.mkdirSync(dest,{recursive:true});
    for(const entry of fs.readdirSync(real))copyModel(path.join(real,entry),path.join(dest,entry),allowedRoot);
  } else if(stat.isFile())fs.copyFileSync(real,dest);
}
for(const name of ['speaker-diarization-3.1','segmentation-3.0','wespeaker-voxceleb-resnet34-LM','speaker-diarization-community-1']) {
  const folder=`models--pyannote--${name}`;
  // pyannote 4 loads PLDA from community-1 even for the configured 3.1
  // agglomerative pipeline. These tiny cached weights are required at init.
  const source=fs.realpathSync(path.join(cache,folder));
  copyModel(source,path.join(root,'hub',folder),source);
}
fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify({sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  preparedAt:new Date().toISOString(),offlineOnly:true,syntheticSpeech:true},null,2));
console.log(`Prepared task-owned package payload: ${root}`);
