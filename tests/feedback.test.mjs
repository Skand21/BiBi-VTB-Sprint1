import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FeedbackStore, validateFeedback } from '../lib/feedback.mjs';
import { createServer } from '../server.mjs';
const payload={schema:1,mode:'demo',understood:true,commission:true,repeat:false};
test('Feedback schema rejects financial rows, text and unknown fields',()=>{
 assert.deepEqual(validateFeedback(payload),payload);
 for(const p of [{...payload,portfolio:[]},{...payload,email:'test'},{...payload,understood:'yes'},{...payload,mode:'other'},null])assert.throws(()=>validateFeedback(p));
});
test('Concurrent feedback stores only daily aggregate counts',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'bibi-feedback-'));
 t.after(async()=>{if(!path.resolve(dir).startsWith(path.join(path.resolve(os.tmpdir()),'bibi-feedback-')))throw new Error('Unexpected cleanup target');await rm(dir,{recursive:true,force:true});});
 const store=new FeedbackStore(dir);await Promise.all(Array.from({length:8},()=>store.add(payload)));
 const data=JSON.parse(await readFile(path.join(dir,'feedback-aggregates.json'),'utf8'));
 assert.deepEqual(data.totals.demo,{responses:8,understood:8,commission:8,repeat:0});
 assert.equal(data.totals.personal.responses,0);assert.equal(Object.keys(data.days).length,1);
 assert.equal(JSON.stringify(data).includes('portfolio'),false);assert.equal(JSON.stringify(data).includes('IP'),false);
});
test('Feedback API enforces origin, type, size, schema and request limits',async t=>{
 const recorded=[];const server=createServer({publicOrigin:'https://example.test',feedbackStore:{add:async x=>recorded.push(x)}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const url=`http://127.0.0.1:${server.address().port}/api/feedback`;
 const post=(body,headers={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://example.test',...headers},body:typeof body==='string'?body:JSON.stringify(body)});
 assert.equal((await post(payload,{Origin:'https://foreign.test'})).status,403);
 assert.equal((await post(payload,{'Content-Type':'text/plain'})).status,415);
 assert.equal((await post('x'.repeat(3000))).status,413);
 assert.equal((await post({...payload,portfolio:{}})).status,400);
 assert.equal((await post('{broken')).status,400);
 assert.equal((await post(payload)).status,200);assert.equal(recorded.length,1);
 for(let i=0;i<7;i++)assert.equal((await post(payload)).status,200);
 assert.equal((await post(payload)).status,429);
 assert.equal(recorded.length,8);
});
