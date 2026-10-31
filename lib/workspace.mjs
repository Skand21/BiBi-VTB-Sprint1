import {mkdir,readFile,writeFile,rename,unlink,open,lstat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {allocate} from '../src/allocator.mjs';
import {decodeState,initialState,normalizePlan,fingerprint,applyDemo} from '../src/state.mjs';

export class WorkspaceError extends Error {
  constructor(code,message){super(message);this.code=code;}
}
export const workspaceDirectory=()=>path.resolve(process.env.BIBI_WORKSPACE_DIR||path.join(os.homedir(),'.bibi','workspace'));
const fail=(code,message)=>{throw new WorkspaceError(code,message);};
const clone=value=>structuredClone(value);
const MAX_BYTES=5_000_000;
export async function atomicWorkspaceRename(source,destination,{renameFile=rename,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  // Windows readers/antivirus can briefly hold the destination open. Preserve
  // atomic replacement: never unlink the existing portfolio to work around it.
  for(let attempt=0;;attempt++){
    try{return await renameFile(source,destination);}
    catch(e){if(!['EPERM','EACCES','EBUSY'].includes(e.code)||attempt>=11)throw e;await wait(Math.min(100,(attempt+1)*10));}
  }
}
function validId(id){if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))fail('INVALID_ID','Неверный идентификатор');return id;}
function summary(p){return {id:p.id,revision:p.revision,name:p.state.plan.name,mode:p.state.mode,assetCount:p.state.plan.assets.length,calculationCount:p.state.history.length,updatedAt:p.updatedAt};}
function snapshot(p){return {...summary(p),state:clone(p.state),executesTrades:false};}
function normalizeDatabase(raw){
  if(!raw||raw.schema!==1||!Number.isSafeInteger(raw.revision)||raw.revision<0||!Array.isArray(raw.portfolios)||raw.portfolios.length>5)fail('CORRUPT_STORE','Хранилище повреждено; исходный файл не перезаписан');
  const ids=new Set();
  const portfolios=raw.portfolios.map(p=>{
    validId(p.id);if(ids.has(p.id)||!Number.isSafeInteger(p.revision)||p.revision<1)fail('CORRUPT_STORE','Неверная структура хранилища');ids.add(p.id);
    return {id:p.id,revision:p.revision,state:decodeState(p.state),updatedAt:String(p.updatedAt).slice(0,40)};
  });
  if(raw.activeId!==null&&!ids.has(raw.activeId))fail('CORRUPT_STORE','Активный портфель не найден');
  return {schema:1,revision:raw.revision,activeId:raw.activeId,portfolios};
}
export class WorkspaceStore {
  constructor(directory=workspaceDirectory()){this.directory=path.resolve(directory);this.file=path.join(this.directory,'portfolios.json');}
  async read(){
    try{
      const stat=await lstat(this.file);if(stat.isSymbolicLink()||stat.size>MAX_BYTES)fail('CORRUPT_STORE','Небезопасное или слишком большое хранилище');
      return normalizeDatabase(JSON.parse(await readFile(this.file,'utf8')));
    }catch(e){if(e.code==='ENOENT')return {schema:1,revision:0,activeId:null,portfolios:[]};if(e instanceof WorkspaceError)throw e;fail('CORRUPT_STORE','Не удалось прочитать портфели; исходный файл сохранён');}
  }
  async transaction(fn){
    await mkdir(this.directory,{recursive:true,mode:0o700});
    if((await lstat(this.directory)).isSymbolicLink())fail('UNSAFE_STORE','Каталог хранилища не должен быть ссылкой');
    const lockPath=path.join(this.directory,'write.lock');let lock;
    for(let n=0;n<80;n++){
      try{lock=await open(lockPath,'wx',0o600);break;}catch(e){if(e.code!=='EEXIST')throw e;await new Promise(resolve=>setTimeout(resolve,25));}
    }
    if(!lock)fail('BUSY','Портфель занят другим процессом. Повторите позже');
    let temporary;
    try{
      const db=await this.read(),result=await fn(db);db.revision++;
      const text=JSON.stringify(normalizeDatabase(db));if(Buffer.byteLength(text)>MAX_BYTES)fail('STORE_FULL','Хранилище заполнено. Сохраните копию');
      temporary=this.file+'.'+randomUUID()+'.tmp';await writeFile(temporary,text,{mode:0o600,flag:'wx'});
      const file=await open(temporary,'r+');try{await file.sync();}finally{await file.close();}
      try{const old=await readFile(this.file);await writeFile(this.file+'.backup',old,{mode:0o600});}catch(e){if(e.code!=='ENOENT')throw e;}
      await atomicWorkspaceRename(temporary,this.file);temporary=null;return result;
    }finally{if(temporary)await unlink(temporary).catch(()=>{});await lock.close();await unlink(lockPath);}
  }
  find(db,id){const p=db.portfolios.find(p=>p.id===(id||db.activeId));if(!p)fail('NOT_FOUND','Портфель не найден. Создайте его или выберите сохранённый');return p;}
  check(p,revision){if(!Number.isSafeInteger(revision)||p.revision!==revision)fail('CONFLICT','Портфель изменился. Загрузите свежую версию перед записью');}
  touch(p){p.revision++;p.updatedAt=new Date().toISOString();}
  async list(){const db=await this.read();return {activeId:db.activeId,portfolios:db.portfolios.map(summary),executesTrades:false};}
  async get(id){return snapshot(this.find(await this.read(),id));}
  async create(plan,mode='personal',providedState){
    if(!['personal','demo'].includes(mode))fail('INVALID_MODE','Неверный режим');
    const normalized=normalizePlan(plan);
    return this.transaction(db=>{
      if(db.portfolios.length>=5)fail('STORE_FULL','Можно сохранить до пяти портфелей');
      const state=providedState?decodeState(providedState):initialState();state.plan=normalized;state.mode=mode;state.onboarded=true;
      const p={id:randomUUID(),revision:1,state,updatedAt:new Date().toISOString()};db.portfolios.push(p);db.activeId=p.id;return snapshot(p);
    });
  }
  async select(id){validId(id);return this.transaction(db=>{const p=this.find(db,id);db.activeId=id;return snapshot(p);});}
  async replace(id,revision,state){
    validId(id);const normalized=decodeState(state);
    return this.transaction(db=>{const p=this.find(db,id);this.check(p,revision);p.state=normalized;this.touch(p);return snapshot(p);});
  }
  async updatePlan(id,revision,plan){
    const normalized=normalizePlan(plan);
    return this.transaction(db=>{const p=this.find(db,validId(id));this.check(p,revision);p.state.plan=normalized;p.state.revision++;this.touch(p);return snapshot(p);});
  }
  async calculate(id,revision,contribution){
    return this.transaction(db=>{
      const p=this.find(db,validId(id));this.check(p,revision);if(p.state.history.length>=30)fail('HISTORY_FULL','В истории уже 30 расчётов');
      const result=allocate(p.state.plan,contribution),record={id:randomUUID(),date:new Date().toISOString(),plan:clone(p.state.plan),contribution:String(contribution),result,mode:p.state.mode,applied:false,booked:false,feedback:false,fingerprint:fingerprint(p.state.plan),version:result.version};
      p.state.history.unshift(record);this.touch(p);return {portfolio:snapshot(p),calculation:clone(record),executesTrades:false};
    });
  }
  async simulate(id,revision,calculationId){
    return this.transaction(db=>{
      const p=this.find(db,validId(id));this.check(p,revision);const record=p.state.history.find(r=>r.id===validId(calculationId));
      if(!record)fail('NOT_FOUND','Расчёт не найден');
      if(p.state.mode!=='demo')fail('SIMULATION_ONLY','Личные позиции не меняются по расчёту. Сначала создайте отдельную модель портфеля');
      applyDemo(p.state,record);this.touch(p);return {...snapshot(p),simulated:true};
    });
  }
  async forkSimulation(id,revision){
    return this.transaction(db=>{
      const source=this.find(db,validId(id));this.check(source,revision);if(db.portfolios.length>=5)fail('STORE_FULL','Можно сохранить до пяти портфелей');
      const state=initialState();state.mode='demo';state.onboarded=true;state.plan=clone(source.state.plan);state.plan.name=(state.plan.name+' · модель').slice(0,80);
      const p={id:randomUUID(),revision:1,state,updatedAt:new Date().toISOString()};db.portfolios.push(p);return {...snapshot(p),sourceId:id,simulated:true};
    });
  }
  async previewQuotes(id,revision,getQuote){
    const original=await this.get(id);this.check(original,revision);
    const plan=clone(original.state.plan),quotes=[];
    // Bound outbound concurrency and change nothing if any quote fails.
    for(const asset of plan.assets){const quote=await getQuote(asset.ticker);asset.price=String(quote.price);asset.lot=String(quote.lot);asset.priceSource=quote.source;asset.quoteAt=quote.quoteAt;quotes.push(quote);}
    return {plan,quotes,portfolioId:id,expectedRevision:revision};
  }
  async refresh(id,revision,getQuote){
    const preview=await this.previewQuotes(id,revision,getQuote);
    const portfolio=await this.updatePlan(id,revision,preview.plan);return {portfolio,quotes:preview.quotes,executesTrades:false};
  }
}
