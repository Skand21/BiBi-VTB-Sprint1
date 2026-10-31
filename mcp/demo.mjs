import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { initialState } from '../src/state.mjs';

const transport=new StdioClientTransport({command:process.execPath,args:['--max-old-space-size=128',fileURLToPath(new URL('server.mjs',import.meta.url))],stderr:'pipe',maxBufferSize:65_536});
const client=new Client({name:'bibi-synthetic-demo',version:'1.0.0'});
try {
  await client.connect(transport);
  const tools=await client.listTools();console.log('Tools:',tools.tools.map(t=>t.name).join(', '));
  const sample=JSON.parse((await client.readResource({uri:'bibi://examples/two-assets'})).contents[0].text);
  const first=await client.callTool({name:'bibi_calculate_contribution',arguments:{plan:sample.plan,contribution:sample.contribution}});
  if(first.isError)throw new Error('Synthetic calculation failed');
  const r=first.structuredContent;
  console.log(JSON.stringify({synthetic:true,modelWasNotInvoked:true,first:{purchases:r.purchases,feesKopecks:r.feesKopecks,cashKopecks:r.cashKopecks}},null,2));
  const state=initialState();
  state.plan.assets.forEach((a,i)=>{a.quantity=String(r.positions[i].afterQuantity);});state.plan.cash=(r.cashKopecks/100).toFixed(2);
  const next=await client.callTool({name:'bibi_calculate_contribution',arguments:{plan:state.plan,contribution:'20000'}});
  if(next.isError)throw new Error('Second calculation failed');
  console.log(JSON.stringify({second:{purchasesKopecks:next.structuredContent.purchasesKopecks,feesKopecks:next.structuredContent.feesKopecks,cashKopecks:next.structuredContent.cashKopecks},executesTrades:false},null,2));
} finally { await client.close(); }
