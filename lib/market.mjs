const quoteCache=new Map();let catalogue=null,cataloguePending=null;
const boards=['TQBR','TQTF'];
let inFlight=0;
const blockRows=block=>(block?.data??[]).map(row=>Object.fromEntries((block.columns??[]).map((key,i)=>[key,row[i]])));
async function readJSON(url){
  if(inFlight>=6)throw new Error('Источник занят. Повторите через несколько секунд');
  inFlight++;
  try{
  const response=await fetch(url,{signal:AbortSignal.timeout(5000),redirect:'error',headers:{Accept:'application/json'}});
  if(!response.ok)throw new Error('Источник котировок временно недоступен');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2_000_000)throw new Error('Слишком большой ответ источника');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }finally{inFlight--;}
}
export async function getQuote(ticker){
  if(!/^[A-Z0-9._-]{1,16}$/.test(ticker))throw new Error('Некорректный тикер');
  const hit=quoteCache.get(ticker);if(hit&&Date.now()-hit.at<60_000)return hit.value;
  for(const board of boards){
    const url=new URL(`https://iss.moex.com/iss/engines/stock/markets/shares/boards/${board}/securities/${encodeURIComponent(ticker)}.json`);
    url.searchParams.set('iss.meta','off');url.searchParams.set('iss.only','securities,marketdata');
    url.searchParams.set('securities.columns','SECID,SHORTNAME,LOTSIZE,PREVPRICE,PREVDATE,CURRENCYID');
    url.searchParams.set('marketdata.columns','SECID,LAST,SYSTIME,UPDATETIME');
    const data=await readJSON(url),security=blockRows(data.securities)[0],market=blockRows(data.marketdata)[0]??{};
    if(!security)continue;
    if(security.SECID!==ticker||!Number.isInteger(security.LOTSIZE)||security.LOTSIZE<1)continue;
    if(security.CURRENCYID&&!['SUR','RUB','RUR'].includes(security.CURRENCYID))throw new Error('В этой версии доступны бумаги в рублях');
    const last=Number(market.LAST),price=last>0?last:Number(security.PREVPRICE);
    if(!Number.isFinite(price)||price<=0)throw new Error('Цена не опубликована. Введите её вручную');
    if(Math.abs(price*10000-Math.round(price*10000))>0.0001)throw new Error('Для этой цены требуется более 4 знаков после запятой. Бумага пока не поддерживается');
    const value={ticker,title:String(security.SHORTNAME||ticker),lot:security.LOTSIZE,price,board,
      source:last>0?'MOEX ISS · LAST':'MOEX ISS · PREVPRICE',quoteAt:String(last>0?market.SYSTIME||market.UPDATETIME||'Время не опубликовано':security.PREVDATE||'Дата не опубликована'),receivedAt:new Date().toISOString(),delayed:true};
    if(quoteCache.size>=300)quoteCache.delete(quoteCache.keys().next().value);
    quoteCache.set(ticker,{at:Date.now(),value});return value;
  }
  throw new Error('Бумага не найдена среди рублёвых акций и фондов. Проверьте тикер или введите данные вручную');
}
async function getCatalogue(){
  if(catalogue&&Date.now()-catalogue.at<600_000)return catalogue.items;
  if(cataloguePending)return cataloguePending;
  cataloguePending=(async()=>{
    const list=await Promise.all(boards.map(async board=>{
      const url=new URL(`https://iss.moex.com/iss/engines/stock/markets/shares/boards/${board}/securities.json`);
      url.searchParams.set('iss.meta','off');url.searchParams.set('iss.only','securities');url.searchParams.set('securities.columns','SECID,SHORTNAME,SECNAME,LOTSIZE,PREVPRICE,CURRENCYID');
      const data=await readJSON(url);
      return blockRows(data.securities).slice(0,5000).filter(a=>typeof a.SECID==='string'&&/^[A-Z0-9._-]{1,16}$/.test(a.SECID)&&(!a.CURRENCYID||['SUR','RUB','RUR'].includes(a.CURRENCYID))).map(a=>({ticker:a.SECID,title:String(a.SHORTNAME||a.SECID),fullName:String(a.SECNAME||''),board}));
    }));
    const unique=new Map();for(const a of list.flat())if(!unique.has(a.ticker))unique.set(a.ticker,a);
    catalogue={at:Date.now(),items:[...unique.values()]};return catalogue.items;
  })();
  try{return await cataloguePending;}finally{cataloguePending=null;}
}
export async function searchSecurities(query){
  const q=String(query??'').trim().toLocaleLowerCase('ru-RU');
  if(q.length<2||q.length>64)throw new Error('Введите от 2 до 64 символов');
  const list=await getCatalogue();
  return list.filter(a=>`${a.ticker} ${a.title} ${a.fullName}`.toLocaleLowerCase('ru-RU').includes(q)).sort((a,b)=>{
    const score=x=>x.ticker.toLowerCase()===q?0:x.ticker.toLowerCase().startsWith(q)?1:x.title.toLocaleLowerCase('ru-RU').startsWith(q)?2:3;
    return score(a)-score(b)||a.title.localeCompare(b.title,'ru');
  }).slice(0,8).map(({fullName,...a})=>a);
}
