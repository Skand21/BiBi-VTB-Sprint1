import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=name=>readFile(path.join(base,name),'utf8');
let html=await read('index.html');
let fontCSS=await read('assets/inter.css');
for(const name of ['latin','latin-ext','cyrillic','cyrillic-ext']){
  const bytes=await readFile(path.join(base,`assets/fonts/inter-${name}.woff2`));
  fontCSS=fontCSS.replace(`./fonts/inter-${name}.woff2`,()=>`data:font/woff2;base64,${bytes.toString('base64')}`);
}
const css=fontCSS+'\n'+await read('src/styles.css')+'\n'+await read('src/kiton.css');
const script=(await Promise.all(['src/allocator.mjs','src/state.mjs','src/editor.mjs','src/export.mjs','src/workspace-client.mjs','src/app.mjs'].map(read))).map(s=>s.replace(/^import .*?;\r?\n/gm,'').replace(/^export /gm,'')).join('\n\n');
const syntax=spawnSync(process.execPath,['--check','--input-type=module'],{input:script,encoding:'utf8'});
if(syntax.status!==0)throw new Error(syntax.stderr||'Ошибка синтаксиса переносимой версии');
const favicon='data:image/svg+xml,'+encodeURIComponent(await read('assets/icon.svg'));
// Callback replacements preserve literal $` / $' in JavaScript regular expressions.
html=html.replace('href="./assets/icon.svg"',()=>`href="${favicon}"`).replace('<link rel="stylesheet" href="./src/styles.css">',()=>`<style>\n${css}\n</style>`).replace('<script type="module" src="./src/app.mjs"></script>',()=>`<script type="module">\n${script.replace(/<\/script/gi,'<\\/script')}\n</script>`);
html=html.replace('<link rel="stylesheet" href="./assets/inter.css">','').replace('<link rel="stylesheet" href="./src/kiton.css">','');
const license=await read('assets/fonts/OFL.txt');
html=html.replace('</body>',()=>`<template id="inter-font-license">${license.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</template>\n</body>`);
await mkdir(path.join(base,'dist'),{recursive:true});await writeFile(path.join(base,'dist/BiBi.html'),html,'utf8');
console.log('dist/BiBi.html готов: '+Buffer.byteLength(html)+' bytes, no external dependencies');
