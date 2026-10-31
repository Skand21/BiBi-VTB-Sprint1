import {getQuote,searchSecurities} from './market.mjs';
const proxy='https://kiton.pw/bibi/api/';
export function validateQuote(value,ticker){
  if(!value||value.ticker!==ticker||!Number.isFinite(value.price)||value.price<=0||value.price>=10_000_000||!Number.isInteger(value.lot)||value.lot<1||value.lot>100_000_000||!['TQBR','TQTF'].includes(value.board))throw new Error('Некорректная котировка источника');
  if(Math.abs(value.price*10000-Math.round(value.price*10000))>0.0001)throw new Error('Цена имеет более четырёх десятичных знаков');
  for(const [key,max]of [['title',80],['source',80],['quoteAt',60],['receivedAt',60]])if(typeof value[key]!=='string'||value[key].length>max||/[\u0000-\u001f\u007f]/.test(value[key]))throw new Error('Некорректные метаданные котировки');
  return {ticker,title:value.title,price:value.price,lot:value.lot,board:value.board,source:value.source,quoteAt:value.quoteAt,receivedAt:value.receivedAt,delayed:true};
}
async function proxyJSON(endpoint,fetchImpl){
  const response=await fetchImpl(proxy+endpoint,{redirect:'error',signal:AbortSignal.timeout(7000),headers:{Accept:'application/json'}});
  if(!response.ok)throw new Error('Источник котировок временно недоступен');
  const reader=response.body.getReader();let size=0;const chunks=[];
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>100_000)throw new Error('Ответ источника слишком большой');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function createMcpMarket({directQuote=getQuote,directSearch=searchSecurities,fetchImpl=fetch}={}){
  return {
    async quote(ticker){
      if(!/^[A-Z0-9._-]{1,16}$/.test(ticker))throw new Error('Некорректный тикер');
      try{return validateQuote(await directQuote(ticker),ticker);}catch{
        const quote=validateQuote(await proxyJSON('quote/'+encodeURIComponent(ticker),fetchImpl),ticker);return {...quote,transport:'BiBi fixed HTTPS proxy'};
      }
    },
    async search(query){
      if(typeof query!=='string'||query.trim().length<2||query.length>64)throw new Error('Введите от 2 до 64 символов');
      let items;try{items=await directSearch(query);}catch{items=(await proxyJSON('search?q='+encodeURIComponent(query),fetchImpl)).items;}
      if(!Array.isArray(items)||items.length>8)throw new Error('Некорректный ответ поиска');
      return items.map(a=>{if(!/^[A-Z0-9._-]{1,16}$/.test(a.ticker)||!['TQBR','TQTF'].includes(a.board)||typeof a.title!=='string'||a.title.length>80||typeof a.fullName!=='undefined'&&typeof a.fullName!=='string')throw new Error('Некорректный результат поиска');return {ticker:a.ticker,title:a.title,board:a.board};});
    }
  };
}
