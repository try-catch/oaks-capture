import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
const root=path.resolve(__dirname,'..');
const worker=fs.readFileSync(path.join(root, 'actions/worker.ts'),'utf8');
const launch=fs.readFileSync(path.join(root, 'src/wx-launch.ts'),'utf8');
function functions(source: string,names: string[]){const ast=ts.createSourceFile('test.ts',source,ts.ScriptTarget.Latest,true);return ast.statements.filter((n): n is ts.FunctionDeclaration=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text??'')).map(n=>n.getText(ast).replace(/\bexport /g,'')).join('\n');}
const reset=worker.slice(worker.indexOf('    // 新租约必须先清理'),worker.indexOf('    const directory =',worker.indexOf('    // 新租约必须先清理')));
test('新租约入口必须重新请求，不能复用旧 play 错误缓存', async () => {
assert.ok(worker.indexOf('    // 新租约必须先清理') < worker.indexOf('await wxLaunchUrl(game.slug)'));
let network=0;
const sandbox: any={Buffer,Response,AbortSignal,URL,crypto,process:{env:{OAKS_SOURCE:'wx'}},console:{error(){},log(){}},realLog(){},stopped:()=>false,rpc:(op: string)=>op==='permit'?{granted:true}:{},syncFiles(){},installCaptureRuntime(){},fetch:async()=>{network++;return new Response(JSON.stringify({success:true,data:'https://3oaks.ssgfivegame.com/api/v1/games/new_game/play?token=synthetic-test-token'}),{headers:{'content-type':'application/json'}})},ProtocolHttpError:Error};
sandbox.browserFetch=sandbox.fetch;
const code=`let slug='new_game',pending={},requestKey='old-play',alternateLaunch,lastProgressAt=0;
const localResponses=new Map([['old-play',{body:Buffer.from('生成失败'),status:200,headers:{}}]]);
const timing={permit:0,permitWait:0,fetch:0,respond:0,append:0,mongo:0,polls:0,documents:0};
${functions(worker,['numberFromEnv','businessStatusCode','usableResponse','installDurability'])}
${functions(launch,['isWxLaunchUrl','wxLaunchUrl'])}
(async()=>{installDurability();let before;try{await wxLaunchUrl('new_game')}catch(e){before=e.message}
${reset}
const after=await wxLaunchUrl('new_game');return {before,after,pending,requestKey,cacheSize:localResponses.size};})()`;
const result=await vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,sandbox);
assert.equal(result.before,'WX_LINK_INVALID_JSON');assert.equal(network,1);assert.ok(result.after.includes('/new_game/play'));assert.equal(result.pending,undefined);assert.equal(result.requestKey,undefined);
});

test('本地短程验收每个完整局立即提交远端历史并记录Mongo确认', () => {
  const calls: any[]=[];
  const logs: any[]=[];
  let runtime: any;
  const sandbox: any={Date,JSON,process:{env:{OAKS_LOCAL_DOCKER:'true'}},
    installCaptureRuntime:(value:any)=>{runtime=value;},
    rpc:(op:string,data:any)=>{calls.push({op,data});return {};},
    realLog:(line:string)=>logs.push(JSON.parse(line)),syncFiles(){},stopped:()=>false};
  const code=`let pending,requestKey,lastProgressAt=0;const worker='local1.0',slug='one';
    const localResponses=new Map(),documentBatch=[];
    const timing={documents:0,permit:0,permitWait:0,fetch:0,respond:0,append:0,mongo:0,polls:0};
    ${functions(worker,['installDurability','flushDocuments'])}
    installDurability();`;
  vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,sandbox);
  runtime.writeDocument({game:'one',sourceRoundHash:'a'.repeat(64)});
  assert.equal(calls.length,1);
  assert.equal(calls[0].op,'append_batch');
  assert.equal(calls[0].data.lines.length,1);
  runtime.noteMongo(12);
  assert.equal(logs.at(-1).phase,'mongo-confirmed');
  assert.equal(logs.at(-1).elapsedMs,12);
});
