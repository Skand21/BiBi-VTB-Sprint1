import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { allocate } from '../src/allocator.mjs';
import { demoPlan } from '../src/state.mjs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const serverFile=fileURLToPath(new URL('server.mjs',import.meta.url));
async function connected(t) {
  const transport=new StdioClientTransport({command:process.execPath,args:['--max-old-space-size=128',serverFile],stderr:'pipe',maxBufferSize:65_536});
  let stderr='';transport.stderr.on('data',chunk=>{stderr+=chunk.toString();});
  const client=new Client({name:'bibi-integration-check',version:'1.0.0'});
  t.after(async()=>{await client.close();assert.equal(stderr,'','Server should not log portfolios or ordinary requests');});
  await client.connect(transport);return client;
}
test('MCP stdio discovers read-only tools/resources and calculates the same result as the site',{timeout:15000},async t=>{
  const client=await connected(t),tools=(await client.listTools()).tools;
  assert.equal(tools.length,14);
  for(const name of ['bibi_calculate_contribution','bibi_validate_plan']){const tool=tools.find(t=>t.name===name);assert.equal(tool.annotations.readOnlyHint,true);assert.equal(tool.annotations.openWorldHint,false);}
  for(const tool of tools)assert.equal(tool.inputSchema.additionalProperties,false);
  const resources=(await client.listResources()).resources;
  assert.deepEqual(resources.map(r=>r.uri).sort(),['bibi://examples/two-assets','bibi://method']);
  const sample=JSON.parse((await client.readResource({uri:'bibi://examples/two-assets'})).contents[0].text);
  assert.equal(sample.synthetic,true);
  const valid=await client.callTool({name:'bibi_validate_plan',arguments:{plan:sample.plan}});assert.equal(valid.isError,undefined);assert.equal(valid.structuredContent.valid,true);
  const raw=JSON.stringify(sample.plan),core=allocate(sample.plan,sample.contribution);
  const response=await client.callTool({name:'bibi_calculate_contribution',arguments:{plan:valid.structuredContent.plan,contribution:sample.contribution}});
  assert.notEqual(response.isError,true);const data=response.structuredContent;
  assert.equal(data.moneyUnit,'kopeck');assert.equal(data.priceUnit,'0.0001 RUB');assert.equal(data.executesTrades,false);
  assert.equal(data.purchasesKopecks,core.purchaseTotal);assert.equal(data.feesKopecks,950);assert.equal(data.cashKopecks,99050);
  assert.equal(data.purchases[0].ticker,'BETA');assert.equal(data.purchases[0].quantity,19);assert.equal(JSON.stringify(sample.plan),raw);
  for(const name of ['execute_trade','read_file','fetch_url'])await assert.rejects(client.callTool({name,arguments:{}}));
  for(const uri of ['file:///etc/passwd','https://example.invalid/','bibi://other'])await assert.rejects(client.readResource({uri}));
});
test('MCP rejects extra fields, wrong units/types, invalid weights and oversized arguments',{timeout:15000},async t=>{
  const client=await connected(t),plan=demoPlan();
  const cases=[{plan,contribution:20000},{plan,contribution:'-1'},{plan,contribution:'1000000001'},{plan,contribution:'1e10'},{plan,contribution:'1.001'},
    {plan,contribution:'20000',url:'http://127.0.0.1/'},{plan:{...plan,brokerToken:'NOT-A-REAL-TOKEN'},contribution:'20000'},
    {plan:{...plan,name:'x'.repeat(81)},contribution:'20000'},
    {plan:{...plan,assets:plan.assets.map(a=>({...a,weight:'60'}))},contribution:'20000'},
    {plan:{...plan,assets:[...plan.assets,null]},contribution:'20000'},
    {plan:{...plan,assets:Array.from({length:13},()=>plan.assets[0])},contribution:'20000'}];
  for(const args of cases){let error=false;try{error=(await client.callTool({name:'bibi_calculate_contribution',arguments:args})).isError===true;}catch{error=true;}assert.equal(error,true,JSON.stringify(Object.keys(args)));}
  const after=await client.callTool({name:'bibi_calculate_contribution',arguments:{plan,contribution:'20000'}});assert.notEqual(after.isError,true);assert.equal(after.structuredContent.cashKopecks,99050);
});
test('MCP repeated deterministic scenarios preserve budget and match the core',{timeout:20000},async t=>{
  const client=await connected(t);
  for(let i=1;i<=20;i++){
    const plan=demoPlan(i%2?'three':'empty');plan.cash=String(i*7);const contribution=String(i*977),core=allocate(plan,contribution);
    const response=await client.callTool({name:'bibi_calculate_contribution',arguments:{plan,contribution}});assert.notEqual(response.isError,true);
    const d=response.structuredContent;assert.equal(d.purchasesKopecks+d.feesKopecks+d.cashKopecks,d.budgetKopecks);assert.equal(d.cashKopecks,core.cash);
    assert.deepEqual(d.positions.map(a=>a.afterQuantity),core.rows.map(a=>a.afterQuantity));
    for(const p of d.purchases)assert.equal(p.quantity%p.lotSize,0);
  }
});
test('MCP transport stops an oversized message without echoing its body',{timeout:10000},async()=>{
  const child=spawn(process.execPath,[serverFile],{stdio:['pipe','pipe','pipe']});let stderr='',stdout='';
  child.stdout.on('data',b=>{stdout+=b;});child.stderr.on('data',b=>{stderr+=b;});child.stdin.on('error',()=>{});
  const exit=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('Oversized input did not close server'));},6000);child.once('error',reject);child.once('exit',()=>{clearTimeout(timer);resolve();});});
  child.stdin.end('X'.repeat(70_000)+'\n');await exit;assert.equal(stdout.includes('XXXX'),false);assert.equal(stderr.includes('XXXX'),false);
});

test('MCP accepts an older 2025-11-25 initialize handshake and tools calls',{timeout:10000},async t=>{
  const child=spawn(process.execPath,[serverFile],{stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:child.stdout}),pending=new Map();let id=0,stderr='';
  child.stderr.on('data',b=>{stderr+=b;});
  const exited=new Promise(resolve=>child.once('exit',resolve));
  t.after(async()=>{child.stdin.end();await exited;lines.close();assert.equal(stderr,'');});
  lines.on('line',line=>{const msg=JSON.parse(line);const p=pending.get(msg.id);if(p){pending.delete(msg.id);clearTimeout(p.timer);if(msg.error)p.reject(new Error(JSON.stringify(msg.error)));else p.resolve(msg.result);}});
  function call(method,params){return new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>reject(new Error('Legacy response timeout')),5000);pending.set(n,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n');});}
  const init=await call('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'bibi-legacy-check',version:'1.0.0'}});
  assert.equal(init.protocolVersion,'2025-11-25');child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const tools=await call('tools/list',{});assert.equal(tools.tools.length,14);
  const r=await call('tools/call',{name:'bibi_calculate_contribution',arguments:{plan:demoPlan(),contribution:'20000'}});assert.notEqual(r.isError,true);assert.equal(r.structuredContent.cashKopecks,99050);
});
