// Synthetic transport fixture; never used by the normal MCP entry point.
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {createMcpServer} from './server.mjs';
const market={
 async quote(ticker){if(ticker==='FAIL')throw Error('Fixture source unavailable');return {ticker,title:ticker,price:1000,lot:1,board:'TQBR',source:'Synthetic fixture, not live MOEX',quoteAt:'2026-10-23',receivedAt:'2026-10-23T10:00:00Z',delayed:true};},
 async search(query){return [{ticker:'SBER',title:'Synthetic search fixture',board:'TQBR'}];}
};
serveStdio(()=>createMcpServer({market}));
