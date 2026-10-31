import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isIP } from 'node:net';
import { realpathSync } from 'node:fs';
import { getQuote, searchSecurities } from './lib/market.mjs';
import { FeedbackStore, validateFeedback } from './lib/feedback.mjs';
export { getQuote } from './lib/market.mjs';
const directory=path.dirname(fileURLToPath(import.meta.url));
const APP_VERSION=JSON.parse(await readFile(path.join(directory,'package.json'),'utf8')).version;
const port=Number(process.env.PORT||4173),host=process.env.BIBI_HOST||'127.0.0.1';
const publicPaths=new Set(['/','/index.html','/src/app.mjs','/src/allocator.mjs','/src/state.mjs','/src/editor.mjs','/src/export.mjs','/src/workspace-client.mjs','/src/styles.css','/src/kiton.css','/assets/inter.css','/assets/icon.svg','/assets/fonts/OFL.txt',...['latin','latin-ext','cyrillic','cyrillic-ext'].map(x=>'/assets/fonts/inter-'+x+'.woff2')]);
const types={'.html':'text/html; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8'};
const headers={
 'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin',
 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
 'Permissions-Policy':'camera=(), microphone=(), geolocation=()'
};
function json(res,status,data){res.writeHead(status,{...headers,'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
function bodyJSON(req){return new Promise((resolve,reject)=>{
 let size=0,done=false;const chunks=[];
 req.on('data',chunk=>{if(done)return;size+=chunk.length;if(size>2048){done=true;reject(Object.assign(new Error('Слишком большой запрос'),{status:413}));return;}chunks.push(chunk);});
 req.on('end',()=>{if(done)return;done=true;try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(Object.assign(new Error('Некорректный JSON'),{status:400}));}});
 req.on('error',()=>{if(!done){done=true;reject(Object.assign(new Error('Запрос прерван'),{status:400}));}});
});}
export function createServer(options={}){
 const market=options.market||{quote:getQuote,search:searchSecurities};
 const feedback=options.feedbackStore||new FeedbackStore(options.dataDirectory||process.env.BIBI_DATA_DIR||path.join(directory,'var'));
  const configuredOrigin=options.publicOrigin||process.env.BIBI_PUBLIC_ORIGIN;
  const allowedHosts=new Set(['localhost','127.0.0.1','[::1]']);
  if(configuredOrigin)allowedHosts.add(new URL(configuredOrigin).hostname.toLowerCase());
  function validHost(raw){
    if(typeof raw!=='string'||raw.length>260||!/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::\d{1,5})?$/i.test(raw))return false;
    try{return allowedHosts.has(new URL('http://'+raw).hostname.toLowerCase());}catch{return false;}
  }
 const limits=new Map();
 function allow(req,group,max){
  let ip=req.socket.remoteAddress||'local';
  if(['127.0.0.1','::1','::ffff:127.0.0.1'].includes(ip)&&process.env.BIBI_TRUST_PROXY==='1'){
   const forwarded=String(req.headers['x-forwarded-for']||'').split(',').at(-1).trim();if(isIP(forwarded))ip=forwarded;
  }
  const key=group+ip,now=Date.now(),old=limits.get(key);if(!old||old.until<now){
   if(limits.size>2000){for(const [k,v]of limits)if(v.until<now)limits.delete(k);if(limits.size>2000)limits.delete(limits.keys().next().value);}
   limits.set(key,{count:1,until:now+60_000});return true;
  }
  return ++old.count<=max;
 }
 const server=http.createServer(async(req,res)=>{
  try{
    // Bound the local HTTP trust boundary; do not trust arbitrary DNS/Host values.
    if(!validHost(req.headers.host))return json(res,403,{error:'Адрес сервера не разрешён'});
    if(!req.url.startsWith('/')||req.url.startsWith('//'))return json(res,400,{error:'Некорректный адрес запроса'});
   const url=new URL(req.url,'http://127.0.0.1');
   if(options.workspace&&await options.workspace.handle(req,res,url,json))return;
   if(url.pathname==='/api/feedback'&&req.method==='POST'){
    if(req.headers.origin){const expected=options.publicOrigin||process.env.BIBI_PUBLIC_ORIGIN||`http://${req.headers.host}`;if(req.headers.origin!==expected)return json(res,403,{error:'Источник запроса не разрешён'});}
    if(String(req.headers['content-type']||'').split(';',1)[0].trim().toLowerCase()!=='application/json')return json(res,415,{error:'Требуется application/json'});
    if(Number(req.headers['content-length']||0)>2048)return json(res,413,{error:'Слишком большой запрос'});
    if(!allow(req,'feedback',10))return json(res,429,{error:'Слишком много отзывов. Попробуйте позже'});
    let data;try{data=validateFeedback(await bodyJSON(req));}catch(err){return json(res,err.status||400,{error:err.message});}
    try{await feedback.add(data);return json(res,200,{ok:true});}catch{return json(res,503,{error:'Не удалось сохранить отзыв. Попробуйте позже'});}
   }
   if(!['GET','HEAD'].includes(req.method)){res.setHeader('Allow','GET, HEAD');return json(res,405,{error:'Метод не поддерживается'});}
   if(url.pathname==='/health')return json(res,200,{status:'ok',product:'bibi',version:APP_VERSION,release:process.env.BIBI_RELEASE||'development'});
   if(url.pathname.startsWith('/api/quote/')){
    const ticker=decodeURIComponent(url.pathname.slice('/api/quote/'.length));
    if(!/^[A-Z0-9._-]{1,16}$/.test(ticker))return json(res,400,{error:'Некорректный тикер'});
    if(!allow(req,'market',90))return json(res,429,{error:'Слишком много запросов. Попробуйте через минуту'});
    try{return json(res,200,await market.quote(ticker));}catch(err){return json(res,502,{error:err.name==='TimeoutError'?'Источник не ответил. Введите цену вручную':err.message});}
   }
   if(url.pathname==='/api/search'){
    const q=url.searchParams.get('q')||'';
    if(q.trim().length<2||q.length>64)return json(res,400,{error:'Введите от 2 до 64 символов'});
    if(!allow(req,'market',90))return json(res,429,{error:'Слишком много запросов. Попробуйте через минуту'});
    try{return json(res,200,{items:await market.search(q)});}catch{return json(res,502,{error:'Поиск временно недоступен. Введите бумагу вручную'});}
   }
   if(!publicPaths.has(url.pathname))return json(res,404,{error:'Страница не найдена'});
   if(options.workspace&&['/','/index.html'].includes(url.pathname))options.workspace.page(req,res);
   const filename=url.pathname==='/'?'/index.html':url.pathname,bytes=await readFile(path.join(directory,filename));
   res.writeHead(200,{...headers,'Content-Type':types[path.extname(filename)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:bytes);
  }catch(err){if(!res.headersSent)json(res,err instanceof URIError?400:500,{error:'Не удалось обработать запрос'});else res.end();}
 });
 server.requestTimeout=10_000;server.headersTimeout=10_000;server.keepAliveTimeout=5000;server.maxRequestsPerSocket=100;
 return server;
}
if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
 const server=createServer();server.listen(port,host,()=>console.log(`BiBi ${APP_VERSION}: http://${host}:${port}`));
 server.on('error',err=>{console.error(err.code==='EADDRINUSE'?`Порт ${port} занят`:err.message);process.exitCode=1;});
 process.on('SIGTERM',()=>{server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),10000).unref();});
}
