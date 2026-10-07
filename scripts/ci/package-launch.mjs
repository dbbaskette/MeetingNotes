import {spawn} from 'node:child_process';
const [binary,...args]=process.argv.slice(2);
const child=spawn(binary,args,{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:''}});
let failed=false,forced;
const stop=()=>{failed=true;child.kill('SIGTERM');forced=setTimeout(()=>child.kill('SIGKILL'),5000);};
const timeout=setTimeout(stop,120000);
process.on('SIGINT',stop);process.on('SIGTERM',stop);
child.once('error',error=>{console.error(error);clearTimeout(timeout);process.exit(1);});
child.once('exit',code=>{clearTimeout(timeout);clearTimeout(forced);process.exit(failed?1:code??1);});
