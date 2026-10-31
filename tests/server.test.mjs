import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.mjs';

test('Local server serves app and modules, rejects mutations and private paths', async t => {
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  let r=await fetch(base);assert.equal(r.status,200);assert.match(await r.text(),/BiBi/);
  assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  for(const route of ['/src/app.mjs','/src/allocator.mjs','/src/state.mjs','/src/editor.mjs','/src/styles.css','/src/kiton.css','/assets/inter.css','/assets/fonts/inter-latin.woff2','/assets/icon.svg','/health'])assert.equal((await fetch(base+route)).status,200);
  for(const route of ['/server.mjs','/PLAN.md','/.env','/tests/allocator.test.mjs','/../package.json','/lib/feedback.mjs','/var/feedback-aggregates.json'])assert.equal((await fetch(base+route)).status,404);
  assert.equal((await fetch(base,{method:'POST',body:'test'})).status,405);
  assert.equal((await fetch(base+'/api/quote/a%20b')).status,400);
});
