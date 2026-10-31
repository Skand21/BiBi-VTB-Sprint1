import test from 'node:test';
import assert from 'node:assert/strict';
import { getQuote,searchSecurities } from '../lib/market.mjs';
test('Market search ranks the visible name first and price source falls back to previous session',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async (input,options)=>{
  assert.equal(options.redirect,'error');
  const url=new URL(input);assert.equal(url.hostname,'iss.moex.com');
  if(url.pathname.endsWith('/securities.json'))return new Response(JSON.stringify({securities:{columns:['SECID','SHORTNAME','SECNAME','LOTSIZE','PREVPRICE','CURRENCYID'],data:url.pathname.includes('/TQTF/')?[]:[['ZZFULL','Другой фонд','Фонд Сбербанк',1,1,'SUR'],['ZZSBER','Сбербанк','ПАО Сбербанк',1,100,'SUR']]}}));
  return new Response(JSON.stringify({securities:{columns:['SECID','SHORTNAME','LOTSIZE','PREVPRICE','PREVDATE','CURRENCYID'],data:[['ZZTEST','Тест',10,12.3456,'2026-10-16','SUR']]},marketdata:{columns:['LAST','SYSTIME'],data:[[null,'2026-10-17 19:00:00']]}}));
 };
 const found=await searchSecurities('сбер');assert.equal(found[0].ticker,'ZZSBER');assert.equal(found.length,2);
 const quote=await getQuote('ZZTEST');assert.equal(quote.price,12.3456);assert.equal(quote.lot,10);assert.equal(quote.source,'MOEX ISS · PREVPRICE');assert.equal(quote.quoteAt,'2026-10-16');
 await assert.rejects(getQuote('BAD PATH'));await assert.rejects(searchSecurities('x'));
});
