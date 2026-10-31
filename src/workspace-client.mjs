export function createWorkspaceClient({getState,onRemote,onStatus,isEditing}){
  let enabled=false,id=null,revision=0,portfolios=[],latest=null,saving=false,conflict=false,timer,stopped=false,generation=0;
  let message='';const status=next=>{if(next!==undefined)message=next;onStatus({enabled,id,revision,portfolios,saving,conflict,message});};
  async function request(body){
    const response=await fetch('./api/workspace',{method:body?'POST':'GET',credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(8000)});
    if(!response.ok){const data=await response.json().catch(()=>({}));const error=new Error(data.error||'Общий портфель недоступен');error.conflict=response.status===409;throw error;}
    return response.json();
  }
  function accept(data,apply){
    portfolios=data.portfolios;const p=data.active;id=p?.id||null;revision=p?.revision||0;
    if(apply&&p)onRemote(p.state);status('');
  }
  async function flush(){
    if(!enabled||saving||conflict||!latest)return;
    saving=true;generation++;status('Сохраняем');
    try{
      while(latest&&!conflict){const snapshot=latest;latest=null;const data=await request(id?{action:'replace',portfolioId:id,expectedRevision:revision,state:snapshot}:{action:'create',state:snapshot});accept(data,false);}
      status('Сохранено на этом компьютере');
    }catch(e){conflict=true;latest=null;status(e.conflict?'Портфель изменился в ИИ или другой вкладке. Скачайте копию своих правок и загрузите свежую версию':'Не удалось сохранить общую копию. Ваши правки остались в браузере. Скачайте копию перед обновлением');}
    finally{saving=false;status();}
  }
  async function poll(){
    if(!enabled||saving||latest||conflict||isEditing())return;
    const started=++generation,startedId=id,startedRevision=revision;
    try{const data=await request();if(started!==generation||id!==startedId||revision!==startedRevision||saving||latest||conflict||isEditing())return;
      if(data.active?.id===id&&data.active.revision<revision)return;
      if(data.active?.id!==id||data.active?.revision!==revision)accept(data,true);else portfolios=data.portfolios;
    }catch{status('Нет связи с общей копией. Следующая запись проверит актуальность портфеля');}
  }
  return {
    async start(){
      if(!['127.0.0.1','localhost','[::1]'].includes(location.hostname)||location.protocol!=='http:')return;
      try{const data=await request();if(!data.enabled)return;enabled=true;accept(data,true);timer=setInterval(()=>{if(!stopped)void poll();},1500);}
      catch{ /* Ordinary web/offline versions keep browser-only storage. */ }
    },
    save(state){if(!enabled||conflict||!state.onboarded)return;latest=structuredClone(state);void flush();},
    async reload(){if(saving)throw new Error('Дождитесь сохранения');generation++;const data=await request();conflict=false;latest=null;accept(data,true);},
    async select(portfolioId){if(saving||latest||conflict)throw new Error('Сначала завершите сохранение или загрузите свежую версию');generation++;accept(await request({action:'select',portfolioId}),true);},
    stop(){stopped=true;clearInterval(timer);},
    get enabled(){return enabled;}
  };
}
