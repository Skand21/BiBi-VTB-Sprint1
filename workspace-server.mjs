import {createServer} from './server.mjs';
import {WorkspaceStore} from './lib/workspace.mjs';
import {createWorkspaceHTTP} from './lib/workspace-http.mjs';
import {createMcpMarket} from './lib/mcp-market.mjs';
const port=Number(process.env.BIBI_WORKSPACE_PORT||4188);
const server=createServer({workspace:createWorkspaceHTTP(new WorkspaceStore()),market:createMcpMarket()});
server.listen(port,'127.0.0.1',()=>console.log(`BiBi: http://127.0.0.1:${port}/ — общий портфель для браузера и MCP, только на этом компьютере`));
server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'Порт локальной версии занят': 'Не удалось запустить локальную версию');process.exitCode=1;});
process.on('SIGTERM',()=>server.close());
