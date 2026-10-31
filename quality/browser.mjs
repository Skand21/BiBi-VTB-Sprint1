import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { createServer } from '../server.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const selectedEngines = process.env.BIBI_TEST_ENGINES?.split(',').map(x=>x.trim());
if(selectedEngines?.some(x=>!['chromium','firefox','webkit'].includes(x)))throw new Error('Unknown BIBI_TEST_ENGINES');
const output=process.env.BIBI_QA_OUTPUT?path.resolve(process.env.BIBI_QA_OUTPUT):path.join(root,'qa','agent-ready');await mkdir(output,{recursive:true});
const feedback=[];const server=createServer({feedbackStore:{add:async p=>feedback.push(p)}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=process.env.BIBI_TEST_BASE_URL||`http://127.0.0.1:${server.address().port}`;
const results=[],skipped=[],failures=[];
const dialog=page=>page.locator('#dialog');
const nav=(page,name)=>page.locator(`[data-action=nav][data-view=${name}]:visible`).first();
const button=(page,name)=>page.getByRole('button',{name,exact:true});
const data=page=>page.evaluate(()=>JSON.parse(localStorage.getItem('bibi.portfolio.v1')));
async function cleanPage(browser,engine,viewport={width:390,height:844}) {
  const context=await browser.newContext({viewport,isMobile:engine!=='firefox'&&viewport.width<500,hasTouch:viewport.width<500,acceptDownloads:true});
  if(process.env.BIBI_TEST_BASE_URL)await context.route('**/api/feedback',route=>route.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'}));
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  page.setDefaultTimeout(7000);await page.goto(base);return {context,page,errors};
}
async function fit(page,label) {
  const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,
    outside:[...document.querySelectorAll('button,input,select,textarea')].filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden').filter(el=>{
      const b=el.getBoundingClientRect();return b.width>0&&(b.left< -1||b.right>innerWidth+1);
    }).map(el=>el.getAttribute('aria-label')||el.textContent.trim().slice(0,45))}));
  assert.ok(layout.scroll<=layout.width+1,`${label}: horizontal overflow ${JSON.stringify(layout)}`);
  assert.deepEqual(layout.outside,[],`${label}: controls outside viewport`);return layout;
}
async function calc(page) {await button(page,'Рассчитать покупки').click();await button(page,'Сохранить расчёт').waitFor();}
async function settings(page){await page.locator('[data-action=settings]:visible').first().click();}
async function screenshot(page,name){await page.screenshot({path:path.join(output,name+'.png'),fullPage:true});}
async function check(name,fn){
  try{const detail=await fn();results.push({name,status:'passed',...detail});console.log('PASS',name);}
  catch(error){failures.push({name,error:String(error.stack||error)});console.error('FAIL',name,String(error.message));}
}

try {
  for(const [engine,type]of Object.entries({chromium,firefox,webkit})){
    if(selectedEngines&&!selectedEngines.includes(engine))continue;
    let browser;try{browser=await type.launch({headless:true});}catch(error){skipped.push({engine,reason:String(error.message).slice(0,300)});continue;}
    try{
      for(const spec of [{width:320,height:740,theme:'dark'},{width:390,height:844,theme:'light'},{width:768,height:1024,theme:'dark'},{width:1440,height:1000,theme:'light'}])await check(`${engine} ${spec.width} ${spec.theme} two cycles`,async()=>{
        const {context,page,errors}=await cleanPage(browser,engine,spec);
        try{
          await fit(page,'welcome');await screenshot(page,`${engine}-${spec.width}-welcome`);
          await button(page,'Посмотреть пример').click();
          if(spec.theme==='light')await button(page,'Светлая тема').click();
          await fit(page,'portfolio');await calc(page);
          assert.ok((await page.locator('body').innerText()).includes('990,50'));
          await button(page,'Сохранить расчёт').click();
          await button(page,'Применить в примере').click();await button(dialog(page),'Учесть в примере').click();
          await calc(page);assert.ok((await page.locator('body').innerText()).includes('980,50'));
          await fit(page,'result');await screenshot(page,`${engine}-${spec.width}-result`);
          await nav(page,'history').click();assert.equal((await data(page)).history.length,1);
          await button(page,'Открыть').click();assert.ok((await page.locator('body').innerText()).includes('990,50'));
          await page.reload();assert.equal((await data(page)).plan.assets[1].quantity,'49');
          assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),spec.theme);
          await button(page,'Помощь').click();await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.querySelector('dialog').contains(document.activeElement)),true);
          await page.keyboard.press('Escape');await dialog(page).waitFor({state:'hidden'});
          assert.deepEqual(errors,[]);return {viewport:spec,browserErrors:errors.length};
        }finally{await context.close();}
      });
      await check(`${engine} own portfolio, invalid input, backup, XSS and CSV`,async()=>{
        const {context,page,errors}=await cleanPage(browser,engine);
        try{
          await button(page,'Создать портфель').click();
          for(const [i,ticker]of ['ONE','TWO'].entries()){
            await button(dialog(page),'Ввести бумагу вручную').click();const row=page.locator('.editor-row').nth(i);
            await row.getByLabel('Тикер',{exact:true}).fill(ticker);await row.getByLabel('Цена за штуку, ₽').fill('1000');await row.getByLabel('Уже есть, шт.').fill(i?'30':'70');
          }
          await button(dialog(page),'Далее: доли').click();await button(dialog(page),'Создать портфель').click();
          assert.ok((await page.locator('#editor-error').innerText()).length>0);
          await button(dialog(page),'Поровну').click();await page.getByLabel('Название портфеля').fill('Проверка сценария');
          await button(dialog(page),'Создать портфель').click();await button(page,'Пополнить').click();
          await page.locator('input[name=amount]').fill('-1');await button(page,'Рассчитать покупки').click();assert.equal(await button(page,'Сохранить расчёт').count(),0);
          await page.locator('input[name=amount]').fill('20000');await calc(page);
          await button(page,'Записать покупки').click();await page.locator('input[name=actualCash]').fill('-1');await button(dialog(page),'Записать в портфель').click();
          assert.ok((await page.locator('#book-error').innerText()).length>0);assert.equal((await data(page)).plan.assets[1].quantity,'30');
          await page.locator('input[name=actualCash]').fill('990.50');await button(dialog(page),'Записать в портфель').click();await page.reload();
          assert.equal((await data(page)).plan.assets[1].quantity,'49');await button(page,'Пополнить').click();await calc(page);assert.ok((await page.locator('body').innerText()).includes('980,50'));
          await settings(page);const ready=page.waitForEvent('download');await button(dialog(page),'Скачать копию').click();const download=await ready;
          const backupPath=path.join(output,`${engine}-synthetic-backup.json`);await download.saveAs(backupPath);
          const before=(await data(page)).plan;
          await page.locator('#import-file').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{bad')});assert.deepEqual((await data(page)).plan,before);
          const candidate=JSON.parse(await readFile(backupPath,'utf8'));candidate.plan.name='<img src=x onerror="window.bibiXss=1">';candidate.plan.assets[0].priceSource='\t=HYPERLINK("https://example.invalid")';
          await page.locator('#import-file').setInputFiles({name:'synthetic.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(candidate))});
          await button(dialog(page),'Восстановить').click();assert.equal(await page.locator('img').count(),0);assert.equal(await page.evaluate(()=>window.bibiXss),undefined);
          await button(page,'Пополнить').click();await calc(page);
          const csvReady=page.waitForEvent('download');await button(page,'Скачать CSV').click();const csvDownload=await csvReady,csvPath=path.join(output,`${engine}-synthetic.csv`);await csvDownload.saveAs(csvPath);
          assert.ok((await readFile(csvPath,'utf8')).includes('"\'\t='));
          await page.evaluate(()=>{for(const el of document.querySelectorAll('p,label,button,summary'))el.style.fontSize='20px';});
          await fit(page,'20px text');await screenshot(page,`${engine}-large-text`);assert.deepEqual(errors,[]);return {browserErrors:errors.length};
        }finally{await context.close();}
      });
      await check(`${engine} late feedback response preserves another dialog and calculation`,async()=>{
        const {context,page,errors}=await cleanPage(browser,engine);let release;
        try{
          let requestStarted;const started=new Promise(resolve=>{requestStarted=resolve;});
          await page.route('**/api/feedback',async route=>{await new Promise(resolve=>{release=async()=>{await route.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'});resolve();};requestStarted();});});
          await button(page,'Посмотреть пример').click();await calc(page);await button(page,'Оставить отзыв').click();
          for(const key of ['understood','commission','repeat'])await page.locator(`input[name=${key}][value=yes]`).check();
          await button(dialog(page),'Отправить отзыв').click();await started;
          await button(dialog(page),'Закрыть').click();await button(page,'Другой взнос').click();await calc(page);await button(page,'Создать свой').click();
          await release();await page.waitForFunction(()=>JSON.parse(localStorage.getItem('bibi.portfolio.v1')).events.some(e=>e.type==='feedback_submitted'));
          assert.equal(await page.locator('#editor-form').isVisible(),true);await button(dialog(page),'Закрыть').click();
          await button(page,'Оставить отзыв').click();assert.equal(await page.locator('#feedback-form').isVisible(),true);
          await page.keyboard.press('Escape');assert.deepEqual(errors,[]);return {browserErrors:errors.length,realFeedbackSubmitted:false};
        }finally{if(release)await release().catch(()=>{});await context.close();}
      });
      await check(`${engine} market search, network failure, oversized import and confirmed reset`,async()=>{
        const {context,page,errors}=await cleanPage(browser,engine);
        try{
          await page.route('**/api/search?*',async route=>{
            const q=new URL(route.request().url()).searchParams.get('q');
            if(q==='FAIL')return route.abort();
            return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({items:[{ticker:'ONE',title:'Тестовая бумага',board:'TQBR'}]})});
          });
          await page.route('**/api/quote/ONE',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ticker:'ONE',title:'Тестовая бумага',price:1000,lot:10,source:'Mocked public quote',quoteAt:'2026-10-22'})}));
          await button(page,'Создать портфель').click();await page.getByPlaceholder('Название или тикер').fill('ONE');
          await page.locator('[data-action=pick-security]').click();await page.locator('.editor-row').waitFor();
          assert.equal(await page.locator('[data-field=lot]').inputValue(),'10');assert.equal(await page.locator('[data-field=price]').inputValue(),'1000');
          await page.getByPlaceholder('Название или тикер').fill('FAIL');await page.locator('#security-search-status').filter({hasText:'Поиск недоступен'}).waitFor();
          await button(dialog(page),'Ввести бумагу вручную').click();assert.equal(await page.locator('.editor-row').count(),2);
          await button(dialog(page),'Закрыть').click();await button(page,'Посмотреть пример').click();await calc(page);await button(page,'Сохранить расчёт').click();
          const before=await data(page);await settings(page);
          await page.locator('#import-file').setInputFiles({name:'too-big.json',mimeType:'application/json',buffer:Buffer.alloc(1_000_001,32)});
          assert.ok((await page.locator('#import-error').innerText()).includes('1 МБ'));assert.deepEqual((await data(page)).plan,before.plan);
          await button(dialog(page),'Очистить историю').click();await button(dialog(page),'Отмена').click();assert.equal((await data(page)).history.length,1);
          await settings(page);await button(dialog(page),'Очистить историю').click();await button(dialog(page),'Очистить историю').click();
          assert.equal((await data(page)).history.length,0);assert.deepEqual((await data(page)).plan,before.plan);
          await settings(page);await button(dialog(page),'Удалить все локальные данные').click();await button(dialog(page),'Удалить данные').click();
          await button(page,'Создать портфель').waitFor();assert.equal((await data(page)).onboarded,false);assert.deepEqual(errors,[]);
          return {browserErrors:errors.length,externalMarketRequests:'mocked'};
        }finally{await context.close();}
      });
      await check(`${engine} offline portable build`,async()=>{
        const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
        await context.route(/^https?:\/\//,route=>route.abort());
        try{await page.goto(pathToFileURL(path.join(root,'dist','BiBi.html')).href,{waitUntil:'domcontentloaded'});await button(page,'Посмотреть пример').click();await calc(page);assert.ok((await page.locator('body').innerText()).includes('990,50'));await fit(page,'offline');assert.deepEqual(errors,[]);return {browserErrors:errors.length,internet:'all HTTP/S requests blocked'};}
        finally{await context.close();}
      });
    }finally{await browser.close();}
  }
  assert.equal(feedback.length,0,'Browser checks must not populate feedback aggregates');
}finally{
  // A browser may leave a preconnected socket with no request. Node's close()
  // waits for it forever; this server belongs only to this finished QA run.
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
  await writeFile(path.join(output,'checks.json'),JSON.stringify({at:new Date().toISOString(),base,localOnly:!process.env.BIBI_TEST_BASE_URL,offlineBuildIsLocal:true,feedbackIntercepted:true,physicalDevicesTested:false,results,skipped,failures},null,2));
}
console.log(JSON.stringify({passed:results.length,skipped,failed:failures.length}));
if(failures.length||results.length===0)process.exitCode=1;
