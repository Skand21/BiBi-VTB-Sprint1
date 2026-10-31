import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function validateFeedback(data){
  const fields=['schema','mode','understood','commission','repeat'];
  if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!fields.includes(k))||data.schema!==1||!['demo','personal'].includes(data.mode)||['understood','commission','repeat'].some(k=>typeof data[k]!=='boolean'))
    throw new Error('Отзыв должен содержать только три ответа и режим расчёта');
  return {schema:1,mode:data.mode,understood:data.understood,commission:data.commission,repeat:data.repeat};
}
const zero=()=>({responses:0,understood:0,commission:0,repeat:0});
export class FeedbackStore{
  constructor(directory){this.directory=directory;this.queue=Promise.resolve();}
  add(raw){
    const payload=validateFeedback(raw);
    const operation=this.queue.then(async()=>{
      await mkdir(this.directory,{recursive:true,mode:0o700});
      const file=path.join(this.directory,'feedback-aggregates.json');let data;
      try{data=JSON.parse(await readFile(file,'utf8'));if(data.schema!==1||!data.totals||!data.days)throw new Error('Неверная структура хранилища');}
      catch(err){if(err.code!=='ENOENT')throw err;data={schema:1,totals:{demo:zero(),personal:zero()},days:{}};}
      const day=new Date().toISOString().slice(0,10);
      data.days[day]??={demo:zero(),personal:zero()};
      for(const counters of [data.totals[payload.mode],data.days[day][payload.mode]]){
        counters.responses++;for(const key of ['understood','commission','repeat'])if(payload[key])counters[key]++;
      }
      for(const key of Object.keys(data.days).sort().slice(0,-365))delete data.days[key];
      const temporary=file+'.'+process.pid+'.tmp';await writeFile(temporary,JSON.stringify(data),{mode:0o600});await rename(temporary,file);
    });
    this.queue=operation.catch(()=>{});return operation;
  }
}
