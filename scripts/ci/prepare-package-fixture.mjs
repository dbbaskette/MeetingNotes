// Explicit local packaging QA payload. Never copy credentials or a live
// library. Native model inference is verified separately on a physical supported Mac.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const [appPath,speechPath]=process.argv.slice(2);
if(!appPath?.endsWith('/MeetingNotes.app')||!speechPath)throw new Error('Pass the disposable built app and synthetic WAV');
const root=path.resolve('.ci-package-fixture');
if(fs.existsSync(root))throw new Error('Payload already exists; preserve it or remove the exact owned fixture before preparing another');
fs.mkdirSync(root,{recursive:true});
// Framework symlinks must remain relative/relocatable in the guest. Node's
// default rewrites their targets to absolute host paths.
fs.cpSync(appPath,path.join(root,'MeetingNotes.app'),{recursive:true,verbatimSymlinks:true});
fs.copyFileSync(speechPath,path.join(root,'speech.wav'));
fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify({sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  preparedAt:new Date().toISOString(),offlineOnly:true,syntheticSpeech:true},null,2));
console.log(`Prepared task-owned package payload: ${root}`);
