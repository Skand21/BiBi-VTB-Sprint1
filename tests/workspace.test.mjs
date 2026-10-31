import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,lstat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import {WorkspaceStore,atomicWorkspaceRename} from '../lib/workspace.mjs';
import {createWorkspaceHTTP} from '../lib/workspace-http.mjs';
import {createServer} from '../server.mjs';
import {demoPlan} from '../src/state.mjs';
import {createMcpMarket} from '../lib/mcp-market.mjs';
async function temporary(t){const dir=await mkdtemp(path.join(os.tmpdir(),'bibi-workspace-'));t.after(async()=>{if(!path.resolve(dir).startsWith(path.join(path.resolve(os.tmpdir()),'bibi-workspace-')))throw Error('Unexpected cleanup path');await rm(dir,{recursive:true,force:true});});return dir;}
const error=code=>e=>e.code===code;
const quote=ticker=>({ticker,title:ticker,price:1000,lot:1,board:'TQBR',source:'Synthetic fixture',quoteAt:'2026-10-23',receivedAt:'2026-10-23T10:00:00Z',delayed:true});

test('Atomic workspace replacement retries transient sharing locks with a bound and never deletes the destination',async()=>{
 let calls=0;const waits=[];
 await atomicWorkspaceRename('temporary','portfolio',{renameFile:async(source,target)=>{assert.equal(source,'temporary');assert.equal(target,'portfolio');if(++calls<3)throw Object.assign(Error('sharing lock'),{code:'EPERM'});},wait:async ms=>waits.push(ms)});
 assert.equal(calls,3);assert.deepEqual(waits,[10,20]);
 calls=0;await assert.rejects(atomicWorkspaceRename('temporary','portfolio',{renameFile:async()=>{calls++;throw Object.assign(Error('persistent sharing lock'),{code:'EACCES'});},wait:async()=>{}}),e=>e.code==='EACCES');assert.equal(calls,12);
 calls=0;await assert.rejects(atomicWorkspaceRename('temporary','portfolio',{renameFile:async()=>{calls++;throw Object.assign(Error('missing file'),{code:'ENOENT'});},wait:async()=>{throw Error('must not retry');}}),e=>e.code==='ENOENT');assert.equal(calls,1);
});

test('Workspace persists across instances; saved calculation does not book purchases; isolated demo repeats',async t=>{
 const dir=await temporary(t),store=new WorkspaceStore(dir);assert.equal((await store.list()).portfolios.length,0);
 const real=await store.create(demoPlan(),'personal');const restored=await new WorkspaceStore(dir).get();assert.equal(restored.id,real.id);
 const first=await store.calculate(real.id,real.revision,'20000');assert.equal(first.calculation.result.cash,99050);assert.equal(first.portfolio.state.plan.assets[1].quantity,'30');
 await assert.rejects(store.simulate(real.id,first.portfolio.revision,first.calculation.id),error('SIMULATION_ONLY'));
 const model=await store.forkSimulation(real.id,first.portfolio.revision);assert.equal((await store.get(real.id)).state.plan.assets[1].quantity,'30');
 const a=await store.calculate(model.id,model.revision,'20000');const applied=await store.simulate(model.id,a.portfolio.revision,a.calculation.id);
 assert.equal(applied.state.plan.assets[1].quantity,'49');assert.equal(Number(applied.state.plan.cash),990.5);
 await assert.rejects(store.simulate(model.id,applied.revision,a.calculation.id));
 const b=await store.calculate(model.id,applied.revision,'20000');assert.equal(b.calculation.result.cash,98050);assert.equal(b.calculation.result.rows[1].buyQuantity,20);
 assert.equal((await store.get(real.id)).state.plan.assets[1].quantity,'30');assert.ok((await readFile(path.join(dir,'portfolios.json.backup'),'utf8')).includes('ALFA'));
});
test('Workspace atomic quote refresh preserves positions and rejects stale writes and partial failures',async t=>{
 const store=new WorkspaceStore(await temporary(t)),p=await store.create(demoPlan());const before=await readFile(store.file,'utf8');
 await assert.rejects(store.refresh(p.id,p.revision,async ticker=>{if(ticker==='BETA')throw Error('offline');return quote(ticker);}));assert.equal(await readFile(store.file,'utf8'),before);
 const updated=await store.refresh(p.id,p.revision,async ticker=>({...quote(ticker),price:1050}));assert.equal(updated.portfolio.state.plan.assets[0].price,'1050');assert.equal(updated.portfolio.state.plan.assets[0].quantity,'70');
 await assert.rejects(store.updatePlan(p.id,p.revision,demoPlan()),error('CONFLICT'));
 const stale=await store.calculate(p.id,updated.portfolio.revision,'20000');
 await store.updatePlan(p.id,stale.portfolio.revision,{...demoPlan(),cash:'20'});
 await assert.rejects(store.simulate(p.id,stale.portfolio.revision,stale.calculation.id),error('CONFLICT'));
});
test('Workspace concurrent writers and separate processes cannot silently overwrite a revision',async t=>{
 const dir=await temporary(t),a=new WorkspaceStore(dir),b=new WorkspaceStore(dir),p=await a.create(demoPlan());
 const results=await Promise.allSettled([a.updatePlan(p.id,p.revision,{...demoPlan(),name:'A'}),b.updatePlan(p.id,p.revision,{...demoPlan(),name:'B'})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'CONFLICT');
 const moduleURL=new URL('../lib/workspace.mjs',import.meta.url).href;
 const script=`import {WorkspaceStore} from ${JSON.stringify(moduleURL)};const s=new WorkspaceStore(process.argv[1]);const p=await s.get();await new Promise(r=>setTimeout(r,100));try{await s.updatePlan(p.id,p.revision,{...p.state.plan,name:process.argv[2]});console.log('saved')}catch(e){console.log(e.code)}`;
 const run=name=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',script,dir,name],{stdio:['ignore','pipe','pipe']});let out='';child.stdout.on('data',b=>out+=b);child.once('error',reject);child.once('exit',code=>code?reject(Error('Child failed')):resolve(out.trim()));});
 const both=await Promise.all([run('C'),run('D')]);assert.deepEqual(both.sort(),['CONFLICT','saved']);
});
test('Workspace refuses invalid inputs, oversized/corrupt store and caller file paths without overwriting',async t=>{
 const dir=await temporary(t),store=new WorkspaceStore(dir);await assert.rejects(store.create({...demoPlan(),assets:[]}));
 await assert.rejects(store.get('../../outside'));const p=await store.create(demoPlan());
 const state=structuredClone(p.state);state.history=[{id:'forged',plan:demoPlan(),contribution:'20000',mode:'demo',result:{cash:-99}}];
 const changed=await store.replace(p.id,p.revision,state);assert.equal(changed.state.history[0].result.cash,99050);
 for(let n=0;n<4;n++)await store.create({...demoPlan(),name:'Limit '+n});const full=await readFile(store.file,'utf8');await assert.rejects(store.create(demoPlan()),error('STORE_FULL'));assert.equal(await readFile(store.file,'utf8'),full);
 await writeFile(store.file,'x'.repeat(5_000_001));await assert.rejects(store.get(p.id),error('CORRUPT_STORE'));assert.equal((await lstat(store.file)).size,5_000_001);
 await writeFile(store.file,'broken');await assert.rejects(store.get(p.id),error('CORRUPT_STORE'));await assert.rejects(store.create(demoPlan()),error('CORRUPT_STORE'));assert.equal(await readFile(store.file,'utf8'),'broken');
});
test('Private workspace HTTP is disabled by default and protects local state with cookie, Origin and Host',async t=>{
 const store=new WorkspaceStore(await temporary(t));const server=createServer({workspace:createWorkspaceHTTP(store)});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base=`http://127.0.0.1:${server.address().port}`;
 assert.equal((await fetch(base+'/api/workspace')).status,401);
 const home=await fetch(base),cookie=home.headers.get('set-cookie').split(';')[0];assert.ok(home.headers.get('set-cookie').includes('HttpOnly'));assert.ok(home.headers.get('set-cookie').includes('SameSite=Strict'));
 const get=()=>fetch(base+'/api/workspace',{headers:{Cookie:cookie}});assert.equal((await get()).status,200);
 const state=(await import('../src/state.mjs')).initialState();state.onboarded=true;
 const post=(data,headers={})=>fetch(base+'/api/workspace',{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
 assert.equal((await post({action:'create',state},{Origin:'https://kiton.pw'})).status,403);
 assert.equal((await post({action:'create',state},{Origin:''})).status,403);
 assert.equal((await post({action:'create',state},{'Content-Type':'text/plain'})).status,415);
 assert.equal((await post({action:'create',state,url:'http://invalid/'})).status,400);
 const created=await (await post({action:'create',state})).json();assert.ok(created.active.id);
 assert.equal((await post({action:'replace',portfolioId:created.active.id,expectedRevision:0,state})).status,409);
 assert.equal((await fetch(base+'/api/workspace',{headers:{Cookie:cookie,'Sec-Fetch-Site':'cross-site'}})).status,403);
 const badHost=await new Promise((resolve,reject)=>{const req=http.get(base+'/api/workspace',{headers:{Cookie:cookie,Host:'invalid.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});assert.equal(badHost,403);
 for(const route of ['/lib/workspace.mjs','/portfolios.json','/.bibi/workspace/portfolios.json'])assert.equal((await fetch(base+route)).status,404);
 const plain=createServer();await new Promise(r=>plain.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>plain.close(r)));assert.equal((await fetch(`http://127.0.0.1:${plain.address().port}/api/workspace`)).status,404);
});
test('MCP market fallback uses fixed URLs, validates data, rejects redirects/oversized payload and does not forward holdings',async()=>{
 const requests=[],offline=async()=>{throw Error('unavailable');};
 const market=createMcpMarket({directQuote:offline,directSearch:offline,fetchImpl:async(url,options)=>{requests.push({url,options});return new Response(JSON.stringify(url.includes('quote/')?quote('SBER'):{items:[{ticker:'SBER',title:'Сбер',board:'TQBR'}]}));}});
 assert.equal((await market.quote('SBER')).ticker,'SBER');assert.equal((await market.search('Сбер'))[0].ticker,'SBER');assert.ok(requests.every(r=>r.url.startsWith('https://kiton.pw/bibi/api/')&&r.options.redirect==='error'));
 await assert.rejects(market.quote('http://evil/'));assert.equal(requests.length,2);
 const malformed=createMcpMarket({directQuote:offline,fetchImpl:async()=>new Response(JSON.stringify(quote('OTHER')))});await assert.rejects(malformed.quote('SBER'));
 const big=createMcpMarket({directQuote:offline,fetchImpl:async()=>new Response('x'.repeat(100001))});await assert.rejects(big.quote('SBER'));
});
