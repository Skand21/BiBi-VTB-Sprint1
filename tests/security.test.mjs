import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, symlink, unlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { csvCell, serializeCSV } from '../src/export.mjs';
import { createServer } from '../server.mjs';
import { initialState, decodeState } from '../src/state.mjs';

test('CSV neutralizes formula prefixes, leading controls and compatibility characters',()=>{
  for(const text of ['=1+1','+1','-1','@SUM(A1)',' =1','\t=1','\r=1','\n=1','\uFEFF=1','\u00a0=1','＝1','＋1','＠SUM(A1)'])
    assert.equal(csvCell(text).startsWith('"\''),true,JSON.stringify(text));
  assert.equal(csvCell('SBER'),'"SBER"');assert.equal(csvCell('quote "safe"'),'"quote ""safe"""');assert.equal(csvCell(19),'"19"');
  assert.equal(serializeCSV([['x','\t=1']]),'\uFEFF"x";"\'\t=1"');
});

function request(port,{host='127.0.0.1',url='/',method='GET',headers={},body}={}){
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path:url,method,headers:{Host:host,...headers}},res=>{
      const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));
    });req.on('error',reject);req.end(body);
  });
}
test('HTTP host and request-target checks reject rebinding/proxy requests; JSON type is exact',async t=>{
  let writes=0;const server=createServer({publicOrigin:'https://kiton.pw',feedbackStore:{add:async()=>{writes++;}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(r=>server.close(r)));
  const port=server.address().port;
  for(const host of ['attacker.invalid','kiton.pw.attacker.invalid','kiton.pw@attacker.invalid','kiton.pw:99999'])assert.equal((await request(port,{host})).status,403);
  for(const host of ['localhost','127.0.0.1','kiton.pw','KITON.PW'])assert.equal((await request(port,{host})).status,200);
  for(const url of ['http://attacker.invalid/health','//attacker.invalid/health'])assert.equal((await request(port,{url})).status,400);
  assert.equal((await request(port,{url:'/api/feedback',method:'POST',headers:{'Content-Type':'application/json-not-json'},body:'{}'})).status,415);
  for(const url of ['/mcp','/mcp/server.mjs','/mcp/package-lock.json','/docs/AGENT_PLAN.md','/.git/config','/%2e%2e/server.mjs'])assert.equal((await request(port,{url})).status,404);
  assert.equal(writes,0);
});

test('Backup reconstruction ignores prototype keys and never trusts a supplied result',()=>{
  const state=initialState();state.onboarded=true;
  state.history=[{id:'test',plan:state.plan,contribution:'20000',result:{cash:-1},mode:'demo'}];
  const raw=JSON.stringify(state).replace('"schema":1','"schema":1,"__proto__":{"bibiPolluted":true},"constructor":{"prototype":{"bibiPolluted":true}}');
  const restored=decodeState(raw);assert.equal(restored.history[0].result.cash,99050);assert.equal(restored.bibiPolluted,undefined);assert.equal({}.bibiPolluted,undefined);
});

test('HTTP entry point starts through a directory symlink/junction',{timeout:10000},async t=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),'bibi-entry-')),link=path.join(tmp,'project');
  const project=fileURLToPath(new URL('..',import.meta.url));let child;
  t.after(async()=>{
    if(child&&child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}
    await unlink(link).catch(e=>{if(e.code!=='ENOENT')throw e;});
    if(!path.resolve(tmp).startsWith(path.join(path.resolve(os.tmpdir()),'bibi-entry-')))throw new Error('Unexpected cleanup target');
    await rm(tmp,{recursive:true,force:true});
  });
  await symlink(project,link,process.platform==='win32'?'junction':'dir');
  child=spawn(process.execPath,[path.join(link,'server.mjs')],{env:{...process.env,PORT:'0',BIBI_HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{
    let output='';const timer=setTimeout(()=>reject(new Error('Entry did not start')),5000);
    child.stdout.on('data',b=>{output+=b;if(output.includes('BiBi')){clearTimeout(timer);resolve();}});
    child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',()=>{clearTimeout(timer);if(!output.includes('BiBi'))reject(new Error('Entry exited before listening'));});
  });
});
