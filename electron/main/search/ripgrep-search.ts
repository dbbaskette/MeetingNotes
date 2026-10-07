import { spawn } from 'node:child_process';
import { rgPath as rgPathRaw } from '@vscode/ripgrep';
const rgPath = rgPathRaw.replace(/[\\/]app\.asar[\\/]/, m => m.replace('app.asar','app.asar.unpacked'));
export interface RgMatch { file:string; lineNumber:number; lineText:string }
export interface RipgrepOptions {
  maxCountPerFile?:number; globs?:string[]; timeoutMs?:number; maxTotalMatches?:number;
  signal?:AbortSignal; acceptFile?:(file:string)=>boolean;
  /** Optional diagnostics; invoked once on spawn and once after actual exit. */
  onProcess?:(state:'started'|'closed')=>void;
}
export interface RipgrepResult { matches:RgMatch[]; status:'complete'|'partial'|'limit'|'failed'|'cancelled'; message?:string }
export async function ripgrepSearch(searchRoot:string,query:string,opts:RipgrepOptions={}):Promise<RgMatch[]> {
  return (await ripgrepSearchDetailed(searchRoot,query,opts)).matches;
}
/** Resolve only after child exit, so replacement owners cannot overlap subprocesses. */
export async function ripgrepSearchDetailed(searchRoot:string,query:string,opts:RipgrepOptions={}):Promise<RipgrepResult> {
  if(opts.signal?.aborted) return {matches:[],status:'cancelled'};
  if(!query) return {matches:[],status:'complete'};
  const args=['--json','--no-config','--no-ignore','--no-messages','-F','-i'];
  if(opts.maxCountPerFile) args.push('--max-count',String(opts.maxCountPerFile));
  for(const g of opts.globs??[]) args.push('-g',g);
  args.push('--',query,searchRoot);
  return new Promise(resolve=>{
    const matches:RgMatch[]=[], counts=new Map<string,number>();
    let buffer='', reason:RipgrepResult['status']|null=null, message:string|undefined, settled=false, perFileLimited=false;
    const child=spawn(rgPath,args,{stdio:['ignore','pipe','ignore']});
    opts.onProcess?.('started');
    let killTimer:ReturnType<typeof setTimeout>|undefined;
    const stop=(status:RipgrepResult['status'],text?:string):void=>{
      if(reason||settled) return;
      reason=status;message=text;
      child.kill(); killTimer=setTimeout(()=>child.kill('SIGKILL'),250);
    };
    const abort=():void=>stop('cancelled');
    opts.signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>stop('partial','Search timed out; these results are incomplete.'),opts.timeoutMs??3000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',(chunk:string)=>{
      if(reason) return;
      buffer+=chunk;
      if(buffer.length>2_000_000) {stop('partial','A very long line exceeded the search buffer; results are incomplete.');return;}
      let nl:number;
      while(!reason&&(nl=buffer.indexOf('\n'))>=0) {
        const line=buffer.slice(0,nl);buffer=buffer.slice(nl+1);
        try {
          const event=JSON.parse(line) as {type:string;data:{path:{text:string};lines:{text:string};line_number:number}};
          if(event.type!=='match') continue;
          const file=event.data.path.text;
          if(opts.acceptFile&&!opts.acceptFile(file)) continue;
          const count=(counts.get(file)??0)+1;counts.set(file,count);
          if(opts.maxCountPerFile&&count>=opts.maxCountPerFile) perFileLimited=true;
          matches.push({file,lineNumber:event.data.line_number,lineText:event.data.lines.text.replace(/\r?\n$/,'')});
          if(matches.length>=(opts.maxTotalMatches??10000)) stop('limit','Search result limit reached; refine the query or filters.');
        } catch {stop('partial','Could not read a search event; results are incomplete.');}
      }
    });
    child.on('error',(error)=>{reason='failed';message=error.message;});
    child.on('close',(code)=>{
      if(settled)return;settled=true;clearTimeout(timer);if(killTimer)clearTimeout(killTimer);
      opts.onProcess?.('closed');
      opts.signal?.removeEventListener('abort',abort);
      const status=reason??(code===0||code===1?perFileLimited?'limit':'complete':'failed');
      resolve({matches:status==='cancelled'?[]:matches,status,...(message?{message}:status==='failed'?{message:'Search could not complete.'}:status==='limit'?{message:'Per-file or total result limit reached; refine the query.'}:{})});
    });
    if(opts.signal?.aborted) abort();
  });
}
