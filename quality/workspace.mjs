import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {chromium,firefox,webkit} from 'playwright';
import {createServer} from '../server.mjs';
import {WorkspaceStore} from '../lib/workspace.mjs';
import {createWorkspaceHTTP} from '../lib/workspace-http.mjs';
import {demoPlan} from '../src/state.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),out=path.join(root,'qa','workspace');await mkdir(out,{recursive:true});
const require=createRequire(new URL('../mcp/package.json',import.meta.url));
const {Client}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href);
const {StdioClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/client/stdio')).href);
const results=[],failures=[];
async function until(fn,timeout=12000){const until=Date.now()+timeout;while(Date.now()<until){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('State propagation timeout');}
for(const [engine,type]of Object.entries({chromium,firefox,webkit})){
 if(process.env.BIBI_TEST_ENGINE&&process.env.BIBI_TEST_ENGINE!==engine)continue;
 const dir=await mkdtemp(path.join(os.tmpdir(),'bibi-workspace-browser-')),store=new WorkspaceStore(dir),server=createServer({workspace:createWorkspaceHTTP(store)});
 let browser,client;const networkDiagnostics=[],storeDiagnostics=[];
 const transaction=store.transaction.bind(store);store.transaction=async fn=>{try{return await transaction(fn);}catch(e){storeDiagnostics.push({code:e.code,message:String(e.message).replaceAll(dir,'<test-directory>')});throw e;}};
 try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  browser=await type.launch({headless:true});const context=await browser.newContext({viewport:{width:engine==='chromium'?320:390,height:844}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('requestfailed',request=>{if(request.url().includes('/api/workspace'))networkDiagnostics.push({method:request.method(),failure:request.failure()?.errorText});});
  page.on('response',response=>{if(response.url().includes('/api/workspace')&&response.status()>=400)networkDiagnostics.push({status:response.status(),method:response.request().method()});});
  await page.goto(base);await page.locator('#workspace-notice').waitFor();
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'mcp/workspace-fixture.mjs')],env:{...process.env,BIBI_WORKSPACE_DIR:dir},stderr:'pipe',maxBufferSize:65536});
  client=new Client({name:'bibi-browser-mcp-acceptance',version:'1.0.0'});await client.connect(transport);
  const call=async(name,args={})=>{const response=await client.callTool({name,arguments:args});assert.ok(!response.isError,JSON.stringify(response));return response.structuredContent;};
  const saved=await call('bibi_create_portfolio',{plan:{...demoPlan(),name:'Browser MCP acceptance'},mode:'personal'});
  await page.getByRole('heading',{name:'Browser MCP acceptance',exact:true}).waitFor();
  const browserData=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('bibi.portfolio.v1')));
  assert.equal((await browserData()).plan.assets[1].quantity,'30');
  const preview=await call('bibi_refresh_quotes',{portfolioId:saved.id,expectedRevision:saved.revision});
  const refreshed=await call('bibi_apply_quotes',{portfolioId:saved.id,expectedRevision:saved.revision,refreshId:preview.refreshId});
  await until(async()=>String((await browserData()).plan.assets[0].priceSource).includes('Synthetic'));
  const model=await call('bibi_create_simulation',{portfolioId:saved.id,expectedRevision:refreshed.portfolio.revision});await call('bibi_select_portfolio',{portfolioId:model.id});
  await until(async()=>(await browserData()).mode==='demo');
  const a=await call('bibi_calculate_saved',{portfolioId:model.id,expectedRevision:model.revision,contribution:'20000'});
  const applied=await call('bibi_simulate_calculation',{portfolioId:model.id,expectedRevision:a.portfolio.revision,calculationId:a.calculation.id});
  await until(async()=>(await browserData()).plan.assets[1].quantity==='49');
  const b=await call('bibi_calculate_saved',{portfolioId:model.id,expectedRevision:applied.revision,contribution:'20000'});assert.equal(b.calculation.result.cash,98050);
  await until(async()=>(await browserData()).history.length===2);
  const nav=page.locator('[data-action=nav][data-view=contribution]:visible').first();await nav.click();await page.getByRole('button',{name:'Рассчитать покупки',exact:true}).click();await page.getByRole('button',{name:'Сохранить расчёт',exact:true}).click();
  await until(async()=>(await store.get(model.id)).state.history.length===3);
  assert.equal((await call('bibi_get_portfolio',{portfolioId:model.id})).history.length,3);
  assert.equal((await call('bibi_get_portfolio',{portfolioId:saved.id})).plan.assets[1].quantity,'30');
  // Delay an old poll response until a newer browser save has finished.
  let releasePoll,markPoll,markReleased;const pollStarted=new Promise(r=>markPoll=r),pollReleased=new Promise(r=>markReleased=r);let held=false;
  const holdOldPoll=async route=>{
    if(route.request().method()==='GET'&&!held){held=true;const response=await route.fetch(),body=await response.text();markPoll();await new Promise(r=>releasePoll=r);await route.fulfill({response,body});markReleased();}
    else await route.continue();
  };
  await page.route('**/api/workspace',holdOldPoll);await pollStarted;
  const priorRevision=(await store.get(model.id)).revision;
  await page.locator('[data-action=nav][data-view=contribution]:visible').first().click();await page.getByRole('button',{name:'Рассчитать покупки',exact:true}).click();
  await until(async()=>(await store.get(model.id)).revision>priorRevision);releasePoll();await pollReleased;
  // Wait for the browser to receive its own POST acknowledgement before removing
  // interception. A committed file alone does not prove fetch has settled.
  await until(async()=>String(await page.locator('#workspace-notice').innerText()).includes('Сохранено на этом компьютере'));
  await page.unroute('**/api/workspace',holdOldPoll);
  await page.getByRole('button',{name:'Сохранить расчёт',exact:true}).click();await until(async()=>(await store.get(model.id)).state.history.length===4);
  assert.equal((await browserData()).history.length,4);
  const dimensions=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(dimensions.scroll<=dimensions.width+1);
  await page.screenshot({path:path.join(out,engine+'-shared.png'),fullPage:true});
  // A form opened before an AI update must never overwrite that new revision.
  await page.locator('[data-action=nav][data-view=portfolio]:visible').first().click();
  await page.getByRole('button',{name:'Настроить',exact:true}).click();
  await page.locator('[data-action=editor-next]').first().click();
  await page.getByLabel('Название портфеля',{exact:true}).fill('Unsaved browser edit');
  const current=await call('bibi_get_portfolio',{portfolioId:model.id});
  await call('bibi_update_portfolio',{portfolioId:model.id,expectedRevision:current.revision,plan:{...current.plan,name:'Edited by AI'}});
  await page.getByRole('button',{name:'Сохранить изменения',exact:true}).click();
  await until(async()=>String(await page.locator('#workspace-notice').innerText()).includes('Портфель изменился'));
  assert.equal((await call('bibi_get_portfolio',{portfolioId:model.id})).plan.name,'Edited by AI');
  assert.equal((await browserData()).plan.name,'Unsaved browser edit');
  await page.getByRole('button',{name:'Загрузить свежую версию',exact:true}).click();
  await until(async()=>(await browserData()).plan.name==='Edited by AI');
  assert.deepEqual(errors,[]);
  await page.reload();await until(async()=>(await browserData()).history.length===4);
  await page.setViewportSize({width:1440,height:1000});const desktop=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(desktop.scroll<=desktop.width+1);await page.screenshot({path:path.join(out,engine+'-desktop.png'),fullPage:true});
  results.push({engine,passed:true,twoWaySync:true,latePollCannotUndoNewerSave:true,staleBrowserWriteBlocked:true,quoteFixture:true,realDataUnchanged:true,historyPersisted:true,viewport:dimensions,desktop,errors,networkDiagnostics});console.log('PASS',engine,'browser ↔ saved MCP workspace');
 }catch(e){const page=browser?.contexts()[0]?.pages()[0];const debug=page?await page.evaluate(()=>({notice:document.querySelector('#workspace-notice')?.textContent,state:JSON.parse(localStorage.getItem('bibi.portfolio.v1'))})).catch(()=>null):null;failures.push({engine,error:String(e.stack||e),networkDiagnostics,storeDiagnostics,debug});console.error('FAIL',engine,String(e.stack||e),JSON.stringify({networkDiagnostics,storeDiagnostics}));}
 finally{if(client)await client.close();if(browser)await browser.close();await new Promise(r=>server.close(r));if(!path.resolve(dir).startsWith(path.join(path.resolve(os.tmpdir()),'bibi-workspace-browser-')))throw Error('Unexpected cleanup path');await rm(dir,{recursive:true,force:true});}
}
await writeFile(path.join(out,'checks.json'),JSON.stringify({at:new Date().toISOString(),syntheticDataOnly:true,physicalDevicesTested:false,results,failures},null,2));
if(failures.length)process.exitCode=1;
