import {randomBytes,timingSafeEqual} from 'node:crypto';
import {decodeState} from '../src/state.mjs';
import {WorkspaceError} from './workspace.mjs';
function isLocal(req){return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)&&['127.0.0.1','localhost','[::1]'].includes(new URL('http://'+req.headers.host).hostname);}
export function createWorkspaceHTTP(store){
  const session=randomBytes(32).toString('hex');
  const authorized=req=>{const value=String(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('bibi_workspace='))?.slice(15);return typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)&&timingSafeEqual(Buffer.from(value),Buffer.from(session));};
  return {
    page(req,res){
      if(!isLocal(req))return;
      res.setHeader('Set-Cookie',`bibi_workspace=${session}; Path=/api/workspace; HttpOnly; SameSite=Strict`);
    },
    async handle(req,res,url,json){
      if(!url.pathname.startsWith('/api/workspace'))return false;
      if(!isLocal(req)||req.headers['sec-fetch-site']==='cross-site'||req.headers.origin&&req.headers.origin!==new URL('http://'+req.headers.host).origin){json(res,403,{error:'Локальный портфель недоступен этому источнику'});return true;}
      if(!authorized(req)){json(res,401,{error:'Сначала откройте локальную страницу BiBi'});return true;}
      if(url.pathname!=='/api/workspace'){json(res,404,{error:'Страница не найдена'});return true;}
      const envelope=async()=>{const listing=await store.list();return {enabled:true,...listing,active:listing.activeId?await store.get(listing.activeId):null};};
      try{
        if(req.method==='GET'){json(res,200,await envelope());return true;}
        if(req.method!=='POST'){json(res,405,{error:'Метод не поддерживается'});return true;}
        if(req.headers.origin!==new URL('http://'+req.headers.host).origin){json(res,403,{error:'Требуется локальный Origin'});return true;}
        if(String(req.headers['content-type']||'').split(';',1)[0].trim().toLowerCase()!=='application/json'){json(res,415,{error:'Требуется application/json'});return true;}
        if(Number(req.headers['content-length']||0)>1_000_000){json(res,413,{error:'Копия больше 1 МБ'});return true;}
        let size=0;const chunks=[];
        for await(const chunk of req){size+=chunk.length;if(size>1_000_000)throw new WorkspaceError('TOO_LARGE','Копия больше 1 МБ');chunks.push(chunk);}
        const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const fields={create:['action','state'],replace:['action','portfolioId','expectedRevision','state'],select:['action','portfolioId']};
        if(!data||!Object.hasOwn(fields,data.action)||Object.keys(data).some(k=>!fields[data.action].includes(k)))throw new WorkspaceError('INVALID_INPUT','Неверный запрос');
        let active;
        if(data.action==='create'){const state=decodeState(data.state);active=await store.create(state.plan,state.mode,state);}
        if(data.action==='replace')active=await store.replace(data.portfolioId,data.expectedRevision,data.state);
        if(data.action==='select')active=await store.select(data.portfolioId);
        json(res,200,{...(await store.list()),enabled:true,active});
      }catch(e){json(res,e.code==='CONFLICT'?409:e.code==='TOO_LARGE'?413:e.code==='BUSY'?503:400,{code:e instanceof WorkspaceError?e.code:'INVALID_INPUT',error:e instanceof WorkspaceError?e.message:'Проверьте данные портфеля'});}
      return true;
    }
  };
}
