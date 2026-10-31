import { allocate, validatePlan, deviation, valueFor, MAX_ASSETS } from './allocator.mjs';
import { STORE_KEY, COLORS, clone, demoPlan, blankPlan, initialState, normalizePlan, fingerprint, loadState, decodeState, applyDemo, bookPurchases } from './state.mjs';
import { editorContent } from './editor.mjs';
import { serializeCSV } from './export.mjs';
import { createWorkspaceClient } from './workspace-client.mjs';

const root = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const toastBox = document.querySelector('#toast');
const e = value => String(value ?? '').replace(/[&<>"']/g, x => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const rub = (kopecks, digits = 2) => new Intl.NumberFormat('ru-RU', { minimumFractionDigits: Number.isInteger(kopecks / 100) ? 0 : digits, maximumFractionDigits: digits }).format(kopecks / 100) + ' ₽';
const num = value => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 }).format(value);
const pct = value => value == null ? 'нет позиций' : num(Math.round(value * 10) / 10) + '%';
const pp = value => value == null ? 'нет позиций' : num(Math.round(value * 10) / 10) + ' п.п.';
const width = n => Math.max(0, Math.min(100, Number(n) || 0));
const lotWord = n => n%10===1&&n%100!==11?'лот':n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?'лота':'лотов';
const dateLabel = date => {
  const d = new Date(date);
  return Number.isFinite(d.getTime()) ? new Intl.DateTimeFormat('ru-RU', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }).format(d) : 'Дата не указана';
};
const paths = {
  portfolio:'M3 7h18v13H3zM7 7V4h10v3M3 11h18M10 11v3h4v-3',
  plus:'M12 5v14M5 12h14', history:'M3 12a9 9 0 1 0 3-6M3 3v6h6M12 7v5l3 2',
  arrow:'M5 12h14M13 6l6 6-6 6', settings:'M4 7h16M8 4v6M4 17h16M16 14v6',
  edit:'m14 5 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 15z', check:'m5 12 4 4L19 6',
  close:'m6 6 12 12M6 18 18 6', download:'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  copy:'M8 8h12v13H8zM4 16H3V3h12v1', info:'M12 11v6M12 7h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  chart:'M4 20h16M7 16v-5M12 16V7M17 16V4', trash:'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7',
  refresh:'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M18 18A8 8 0 0 1 4 12',
  search:'m21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  moon:'M21 13A9 9 0 0 1 11 3a9 9 0 1 0 10 10',
  sun:'M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  menu:'M4 6h16M4 12h16M4 18h16'
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.info}"/></svg>`;
const logo = `<svg width="36" height="36" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="16" fill="#4263eb"/><path d="M16 16v32h12a12 12 0 1 0 0-24h-4v-8zm8 16h4a4 4 0 0 1 0 8h-4zM46 24h6v24h-6zM46 15h6v6h-6z" fill="#fff"/></svg>`;
let loaded;
try { loaded = loadState(localStorage); } catch { loaded = {state:initialState(),error:'Браузер запретил сохранение. До закрытия вкладки данные останутся в памяти. Скачайте копию в настройках.'}; }
let state = loaded.state;
let storageWarning = loaded.error || '';
let protectedStorage = Boolean(loaded.raw);
let view = state.onboarded ? 'portfolio' : 'welcome', record = null, draft = null, draftMode = 'demo', contribution = '20000';
let timer, flowStarted = null, editorReturnFocus = null;
let workspaceClient=null,workspaceStatus=null;
let editorStep=1, editorIsNew=false, searchTimer, searchAbort, searchGeneration=0;
let theme='dark', collapsed=false;
try{theme=localStorage.getItem('bibi.theme')==='light'?'light':'dark';collapsed=localStorage.getItem('bibi.sidebar')==='1';}catch{}
document.documentElement.dataset.theme=theme;
const emit = (type, details = {}) => {
  state.events.push({type,at:new Date().toISOString(),mode:state.mode,...details});
  state.events = state.events.slice(-300);
};
function persist() {
  if (protectedStorage) return;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch { storageWarning='Не удалось сохранить в браузере. Скачайте резервную копию в настройках.'; toast(storageWarning); }
  workspaceClient?.save(state);
}
function toast(message) {
  clearTimeout(timer);toastBox.textContent=message;toastBox.classList.add('visible');
  timer=setTimeout(()=>toastBox.classList.remove('visible'),4800);
}
function navigate(next) {
  clearTimeout(timer);toastBox.classList.remove('visible');
  view=next;render();window.scrollTo({top:0,behavior:'instant'});
  const heading=document.querySelector('h1');heading?.setAttribute('tabindex','-1');heading?.focus({preventScroll:true});
}
function openDialog(content, narrow = false) {
  editorReturnFocus=document.activeElement;
  dialog.innerHTML=`<div class="dialog-inner">${content}</div>`;
  dialog.style.maxWidth=narrow?'570px':'900px';
  if(!dialog.open)dialog.showModal();
}
function closeDialog() {clearTimeout(searchTimer);searchAbort?.abort();searchGeneration++;dialog.close();draft=null;editorReturnFocus?.focus?.();}
function dialogHead(title,copy='') {
  return `<div class="dialog-head"><div><h2 id="dialog-title">${e(title)}</h2>${copy?`<p>${e(copy)}</p>`:''}</div><button class="icon-button" type="button" data-action="close-dialog" aria-label="Закрыть">${icon('close')}</button></div>`;
}
function demoBanner() {
  if(state.mode!=='demo')return '';
  return `<div class="demo-banner"><span>Пример · условные бумаги и цены</span><div class="row"><button class="text-button" data-action="scenarios">Другой пример</button><button class="text-button" data-action="${state.personalBackup?'restore-personal':'new-plan'}">${state.personalBackup?'Мой портфель':'Создать свой'}</button></div></div>`;
}
function heading(title,copy,actions='') {
  return `<div class="page-heading"><div><h1>${e(title)}</h1><p>${e(copy)}</p></div>${actions}</div>`;
}
function shell(content) {
  const themeButton=`<button class="icon-button" data-action="toggle-theme" aria-label="${theme==='dark'?'Светлая тема':'Тёмная тема'}" title="${theme==='dark'?'Светлая тема':'Тёмная тема'}">${icon(theme==='dark'?'sun':'moon')}</button>`;
  if(view==='welcome')return `<div class="welcome-shell"><header class="welcome-header"><a class="brand" href="#" data-action="home">${logo}<b>bibi</b></a>${themeButton}</header><main class="welcome-main" id="main" tabindex="-1">${storageWarning?`<div class="note warning" role="alert">${e(storageWarning)}</div>`:''}${content}</main></div>`;
  const feedbackLink=view==='result'?'<button class="text-button feedback-link" data-action="feedback">Оставить отзыв</button>':'';
  const active=view==='result'?'contribution':view;
  const nav=(mobile=false)=>[['portfolio','Портфель','portfolio'],['contribution','Пополнение','plus'],['history','История','history']].map(([key,label,glyph])=>`<button data-action="nav" data-view="${key}" ${active===key?'aria-current="page"':''} title="${label}">${icon(glyph)}<span class="nav-label">${label}</span>${!mobile&&key==='history'&&state.history.length?`<span class="nav-count">${state.history.length}</span>`:''}</button>`).join('');
  return `<div class="shell ${collapsed?'is-collapsed':''}"><aside class="sidebar"><a class="brand" href="#" data-action="nav" data-view="portfolio" aria-label="BiBi, мой портфель">${logo}<b>bibi</b></a><nav class="nav" aria-label="Основная навигация">${nav()}</nav><div class="sidebar-bottom"><button class="settings-button" data-action="settings" title="Настройки">${icon('settings')}<span class="settings-label">Настройки</span></button><p class="privacy">Портфель хранится<br>на вашем устройстве</p></div></aside><div class="main-wrap"><header class="topbar"><div class="header-leading"><button class="icon-button desktop-only" data-action="toggle-sidebar" aria-label="${collapsed?'Развернуть меню':'Свернуть меню'}" aria-expanded="${!collapsed}">${icon('menu')}</button><div class="header-mobile-brand"><a class="brand" href="#" data-action="nav" data-view="portfolio" aria-label="BiBi, мой портфель">${logo}<b>bibi</b></a></div><span class="header-title">${e(state.plan.name)}</span></div><div class="header-actions">${state.mode==='demo'?'<span class="mode">Пример</span>':''}${themeButton}<button class="icon-button" data-action="settings" aria-label="Настройки">${icon('settings')}</button></div></header><main class="main" id="main" tabindex="-1">${storageWarning?`<div class="note warning state-warning" role="alert">${e(storageWarning)}</div>`:''}${demoBanner()}${content}<footer class="footer">${feedbackLink}<button class="text-button" data-action="about">Помощь</button></footer></main></div><nav class="mobile-nav" aria-label="Мобильная навигация">${nav(true)}</nav></div>`;
}
function ring(assets,values,total) {
  let offset=0;
  const circles=assets.map((a,i)=>{const share=total?values[i]/total*100:0;const circle=`<circle cx="70" cy="70" r="52" fill="none" stroke="${COLORS[i]}" stroke-width="13" pathLength="100" stroke-dasharray="${share} ${100-share}" stroke-dashoffset="${-offset}" transform="rotate(-90 70 70)"/>`;offset+=share;return circle;}).join('');
  return `<svg class="ring" viewBox="0 0 140 140" role="img" aria-label="Структура портфеля: ${e(assets.map((a,i)=>`${a.ticker} ${pct(total?values[i]/total*100:0)}`).join(', '))}"><circle cx="70" cy="70" r="52" fill="none" stroke="#edf0f6" stroke-width="13"/>${circles}<text x="70" y="67" text-anchor="middle" font-size="23" font-weight="600" fill="#18253e">${assets.length}</text><text x="70" y="86" text-anchor="middle" font-size="11" fill="#606d83">актива</text></svg>`;
}
function identity(a,i) {return `<div class="asset-identity"><span class="asset-mark" style="--asset:${COLORS[i%COLORS.length]}">${e(a.ticker.slice(0,2))}</span><div><div class="asset-name">${e(a.ticker)}</div><div class="asset-caption">${e(a.title)}</div></div></div>`;}
function shortcuts(){return `<div class="shortcuts">${['5000','20000','50000'].map(n=>`<button class="shortcut" type="button" data-action="amount" data-amount="${n}">${num(Number(n))} ₽</button>`).join('')}</div>`;}
function portfolioView() {
  const p=validatePlan(state.plan),values=p.assets.map(a=>a.value),total=values.reduce((s,v)=>s+v,0),drift=deviation(values,p.assets);
  const under=p.assets.map(a=>({a,share:total?a.value/total*100:0})).filter(({a,share})=>total&&share<a.weight/100-.1).sort((x,y)=>(y.a.weight/100-y.share)-(x.a.weight/100-x.share))[0];
  return heading(p.name,'',`<div class="row wrap"><button class="btn primary mobile-calc" data-action="nav" data-view="contribution">${icon('plus')}Пополнить</button><button class="btn" data-action="edit-plan">${icon('edit')}Настроить</button></div>`)+
  `<div class="grid"><section class="panel"><div class="panel-title"><h2>Стоимость бумаг</h2>${state.mode==='personal'?'<button class="text-button" data-action="refresh-prices">Обновить цены</button>':''}</div><div class="overview"><div><div class="total">${rub(total)}</div><p class="overview-note">Свободно ${rub(p.cash)}</p></div>${ring(p.assets,values,total)}</div><div class="stacked" aria-hidden="true">${p.assets.map((a,i)=>`<span style="width:${total?a.value/total*100:0}%;background:${COLORS[i]}"></span>`).join('')}</div><div class="portfolio-heading"><h3>Состав портфеля</h3><div class="legend"><span><i class="dash"></i>целевая доля</span></div></div>${p.assets.map((a,i)=>{const share=total?a.value/total*100:0;return `<div class="asset-line" style="--asset:${COLORS[i]}"><div class="asset-info">${identity(a,i)}<div class="asset-value">${rub(a.value)}<div class="asset-caption">${num(a.quantity)} шт. × ${num(a.price/10000)} ₽</div></div></div><div class="allocation" role="img" aria-label="${e(a.ticker)}: сейчас ${e(pct(share))}, цель ${e(pct(a.weight/100))}"><span class="fill" style="width:${width(share)}%"></span><span class="target" style="left:${width(a.weight/100)}%"></span></div><div class="asset-meta"><span>${pct(share)} сейчас</span><span>${pct(a.weight/100)} по плану</span></div></div>`;}).join('')}<div class="drift-line"><span>Отклонение от плана</span><span class="drift-value">${pp(drift)}</span></div><p class="asset-source-note">${state.mode==='demo'?'Цены в примере условные':p.assets.some(a=>a.quoteAt)?'Даты котировок доступны в настройке бумаг. Цены могут быть задержанными':'Расчёт по введённым вами ценам'}</p></section><aside class="panel"><h2>Пополнение</h2><form id="quick-form" novalidate><label class="section-gap" for="quick-amount">Новый взнос</label><div class="amount-field"><input id="quick-amount" name="amount" inputmode="decimal" value="${e(contribution)}" autocomplete="off"><span>₽</span></div>${shortcuts()}${p.cash?`<div class="budget-line"><span>Плюс свободные деньги</span><strong>${rub(p.cash)}</strong></div>`:''}<div id="quick-error" role="alert"></div><button class="btn primary wide" type="submit">Рассчитать покупки ${icon('arrow')}</button></form>${under?`<div class="hint"><strong>${e(under.a.ticker)} ниже цели</strong><p>${pct(under.share)} в портфеле при плане ${pct(under.a.weight/100)}</p></div>`:''}<p class="quiet">Комиссия ${e(state.plan.feePercent)}%${Number(state.plan.minimumFee)?`, минимум ${rub(p.minimumFee)} за заявку`:''} · <button class="text-button" data-action="edit-tariff">изменить</button></p></aside></div>`;
}
function contributionView() {
  const p=validatePlan(state.plan);
  return heading('Пополнить портфель',p.name)+`<div class="grid"><section class="panel"><h2>Сколько хотите вложить?</h2><form id="contribution-form" novalidate><label class="section-gap" for="contribution-amount">Новый взнос</label><div class="amount-field"><input id="contribution-amount" name="amount" inputmode="decimal" autocomplete="off" value="${e(contribution)}"><span>₽</span></div>${shortcuts()}${p.cash?`<div class="budget-line"><span>Свободно в портфеле</span><strong>${rub(p.cash)}</strong></div>`:''}<details class="tariff"><summary>Тариф брокера: ${e(state.plan.feePercent)}%</summary><div class="two-fields"><label>Комиссия, %<input name="feePercent" inputmode="decimal" value="${e(state.plan.feePercent)}"></label><label>Минимум за заявку, ₽<input name="minimumFee" inputmode="decimal" value="${e(state.plan.minimumFee)}"></label></div></details><div id="contribution-error" role="alert"></div><button class="btn primary wide calc-action" type="submit">Рассчитать покупки ${icon('arrow')}</button></form><div class="hint"><div class="row wrap space-between"><span>Используются ${state.mode==='demo'?'условные':'сохранённые'} цены</span>${state.mode==='personal'?'<button class="text-button" data-action="refresh-prices">Обновить с MOEX</button>':''}</div></div></section><aside class="panel"><div class="panel-title"><h2>Ваши доли</h2><button class="text-button" data-action="edit-tariff">Изменить</button></div>${p.assets.map((a,i)=>`<div class="asset-line"><div class="asset-info">${identity(a,i)}<strong class="money">${pct(a.weight/100)}</strong></div></div>`).join('')}</aside></div>`;
}
function valueForUI(a){return valueFor(a.price,a.lot);}
function resultView() {
  if(!record)return contributionView();
  const r=record.result,bought=r.rows.filter(a=>a.lots),saved=state.history.some(h=>h.id===record.id);
  const improved=r.beforeDeviation!=null&&r.afterDeviation!=null&&r.afterDeviation<r.beforeDeviation-.001;
  const title=!bought.length?'Покупок на эту сумму пока нет':bought.length===1?`Докупить ${bought[0].ticker}`:`Докупить ${bought.map(a=>a.ticker).join(', ')}`;
  const why=!bought.length?'Доступных денег не хватает на подходящий лот с комиссией либо покупка сильнее отдаляет портфель от плана. Деньги остаются для следующего пополнения.':improved?'Доли учитывают весь портфель, а не только новый взнос':'Целые лоты могут оставить часть денег для следующего пополнения';
  const appliedLabel=record.applied?`<div class="note success section-gap">Покупки условно учтены в учебном портфеле. Можно рассчитать следующий взнос</div>`:'';
  return heading('Распределение взноса',`${r.name} · взнос ${rub(r.contribution)}`,`<button class="btn" data-action="nav" data-view="contribution">Другой взнос</button>`)+
  `<div class="result-hero">${icon('chart').replace('class="icon"','class="hero-icon"')}<div class="kicker">Расчёт готов</div><h2>${e(title)}</h2><p>${e(why)}</p></div><div class="grid"><section class="panel"><div class="panel-title"><h2>Что купить</h2><span class="small muted">${record.mode==='demo'?'Условные данные':'По вашим ценам'}</span></div>${r.startingCash?`<div class="note">К взносу ${rub(r.contribution)} добавлены ${rub(r.startingCash)} из портфеля. Всего доступно ${rub(r.budget)}</div>`:''}<div class="balance"><div><label>Покупки</label><strong>${rub(r.purchaseTotal)}</strong></div><div><label>Комиссия</label><strong>${rub(r.fees)}</strong></div><div><label>Останется деньгами</label><strong>${rub(r.cash)}</strong></div></div>${bought.length?`<table class="table"><thead><tr><th>Бумага</th><th>Купить</th><th>Сумма</th></tr></thead><tbody>${bought.map(a=>{const i=r.rows.indexOf(a);return `<tr><td>${identity(a,i)}</td><td><strong>${num(a.buyQuantity)} шт.</strong><div class="sub">${num(a.lots)} ${lotWord(a.lots)} × ${num(a.lot)} шт.</div><div class="sub">Цена ${num(a.price/10000)} ₽</div></td><td class="money"><strong>${rub(a.amount)}</strong><div class="sub">+ ${rub(a.fee)} комиссия</div></td></tr>`;}).join('')}</tbody></table>`:`<div class="note warning">Увеличьте взнос или вернитесь к расчёту после следующего пополнения</div>`}<p class="quiet">Доступно ${rub(r.budget)}. После записи покупок остаток будет учтён при следующем взносе</p><div class="action-bar">${record.mode==='demo'&&state.mode==='demo'?`<button class="btn primary" data-action="apply-demo" ${record.applied?'disabled':''}>${record.applied?'Учтено в примере':'Применить в примере'}</button>`:`<button class="btn primary" data-action="book-purchases" ${record.booked?'disabled':''}>${record.booked?'Покупки записаны':'Записать покупки'}</button>`}<button class="btn" data-action="copy-result">${icon('copy')}Копировать</button>${saved?`<span class="saved-label">${icon('check')}Сохранено</span>`:`<button class="text-button" data-action="save-result">Сохранить расчёт</button>`}<button class="text-button" data-action="export-csv">Скачать CSV</button></div><p class="record-date">${e(dateLabel(record.date))}</p><details class="explain"><summary>Почему выбраны именно эти покупки?</summary><p>BiBi сравнивает стоимость ваших позиций с целевыми долями, затем ищет состав покупок в пределах доступных денег. Учитываются целые лоты и комиссия по каждой заявке</p>${r.rows.filter(a=>!a.lots).map(a=>`<p><strong>${e(a.ticker)}</strong>: ${a.targetWeight===0?'вы задали целевую долю 0%':a.beforeWeight>a.targetWeight?'текущая доля выше выбранной цели':'в этом расчёте покупка лота не улучшает распределение с учётом бюджета и комиссии'}</p>`).join('')}<p>Продаже существующих бумаг расчёт не требует. Цены исполнения у брокера могут отличаться от введённых</p><small>Для небольшого числа вариантов выполняется полный перебор. Для больших задач используется ограниченный поиск; глобальный оптимум не обещается</small></details><details class="explain"><summary>Цены, лоты и тариф</summary>${r.rows.map(a=>`<p><strong>${e(a.ticker)}</strong> · цена ${num(a.price/10000)} ₽ · лот ${num(a.lot)} шт.<br><span class="muted">${e(a.priceSource)}${a.quoteAt?' · '+e(a.quoteAt):''}</span></p>`).join('')}<small>Комиссия ${e(record.plan.feePercent)}% от суммы каждой заявки, минимум ${e(record.plan.minimumFee)} ₽ за заявку. Сверьте тариф, лотность и доступность бумаги у своего брокера</small></details><details class="explain"><summary>А если разделить только новый взнос?</summary><div class="comparison"><div><span>Взнос по фиксированным долям</span><strong>${pp(r.baseline.deviation)}</strong><span>Отклонение после расчётных покупок</span><div>Комиссия ${rub(r.baseline.fees)}<br>Остаток ${rub(r.baseline.cash)}</div></div><div class="preferred"><span>С учётом всего портфеля</span><strong>${pp(r.afterDeviation)}</strong><span>Отклонение после расчётных покупок</span><div>Комиссия ${rub(r.fees)}<br>Остаток ${rub(r.cash)}</div></div></div><small>Одинаковые цены, доступные деньги и тариф. Слева каждая доля бюджета ограничена вашей целевой долей без перераспределения остатка. Сравнивается соответствие плану; доходность не рассчитывается</small></details>${appliedLabel}</section><aside class="panel"><div class="panel-title"><h2>Расчётные доли</h2></div><div class="legend" style="margin-bottom:24px"><span><i></i>сейчас</span><span><i style="background:var(--blue)"></i>после</span><span><i class="dash"></i>цель</span></div><div class="result-list">${r.rows.map((a,i)=>`<div style="--asset:${COLORS[i]}"><div class="result-asset-head"><strong class="asset-name">${e(a.ticker)}</strong><span class="small muted">цель ${pct(a.targetWeight)}</span></div><div class="result-rails"><span>Сейчас</span><div class="allocation current"><span class="fill" style="width:${width(a.beforeWeight)}%"></span><span class="target" style="left:${width(a.targetWeight)}%"></span></div><span class="right">${pct(a.beforeWeight)}</span><span>После</span><div class="allocation after"><span class="fill" style="width:${width(a.afterWeight)}%"></span><span class="target" style="left:${width(a.targetWeight)}%"></span></div><span class="right">${pct(a.afterWeight)}</span></div><div class="asset-caption" style="margin-top:10px">${num(a.quantity)} → ${num(a.afterQuantity)} шт. · ${rub(a.afterValue)}</div></div>`).join('')}</div><div class="drift-line"><span>Отклонение<br>от плана</span><span class="drift-value">${r.beforeDeviation==null?'—':num(Math.round(r.beforeDeviation*10)/10)} → ${pp(r.afterDeviation)}</span></div>${r.beforeDeviation!=null&&r.afterDeviation>r.beforeDeviation+.001?'<p class="note warning section-gap">Из-за целых лотов доли бумаг временно расходятся с целью сильнее. Сравните покупки и остаток перед решением</p>':''}<p class="quiet">Доли от стоимости бумаг ${rub(r.afterTotal)}. Отдельно остаётся ${rub(r.cash)} деньгами</p></aside></div>`;
}
function historyView(){return heading('Сохранённые расчёты','Каждый расчёт хранит свой портфель, цены и комиссию. Его можно открыть и сравнить с новым пополнением.')+`<section class="panel">${!state.history.length?`<div class="empty">${icon('history')}<h2>Первый расчёт ещё впереди</h2><p>Распределите взнос и сохраните результат. Он останется здесь после закрытия браузера</p><button class="btn primary" data-action="nav" data-view="contribution">Рассчитать пополнение ${icon('arrow')}</button></div>`:state.history.map(h=>`<div class="history-row"><div><div class="history-title">${rub(h.result.contribution)} <span class="small muted">новый взнос</span></div><div class="history-caption">${e(h.result.name)} · ${e(dateLabel(h.date))}<br>${h.mode==='demo'?'Учебный портфель':'Собственный портфель'} · ${h.applied?'<span class="applied">условно учтено в примере</span>':h.booked?'покупки записаны':'сохранённый расчёт'}</div></div><div style="text-align:right"><div class="money" style="margin-bottom:8px">${rub(h.result.purchaseTotal)} <span class="small muted">покупки</span></div><button class="btn small" data-action="open-record" data-id="${e(h.id)}">Открыть ${icon('arrow')}</button></div></div>`).join('')}</section>`;}
function render(){root.innerHTML=shell(view==='welcome'?welcomeView():view==='portfolio'?portfolioView():view==='contribution'?contributionView():view==='history'?historyView():resultView());renderWorkspaceStatus();}
function renderWorkspaceStatus(){
  if(!workspaceStatus?.enabled)return;
  let notice=document.querySelector('#workspace-notice');
  if(!notice){notice=document.createElement('section');notice.id='workspace-notice';notice.className='note workspace-notice';document.querySelector('#main')?.prepend(notice);}
  const s=workspaceStatus;
  notice.innerHTML=`<div><strong>Портфель доступен вашему ИИ</strong><p role="status">${e(s.conflict?s.message:s.message||'Изменения сохраняются на этом компьютере и появляются в BiBi и Codex')}</p></div><div class="row">${s.portfolios.length?`<label>Портфель <select id="workspace-select" aria-label="Сохранённый портфель">${s.portfolios.map(p=>`<option value="${e(p.id)}" ${p.id===s.id?'selected':''}>${e(p.name)}${p.mode==='demo'?' · модель':''}</option>`).join('')}</select></label>`:'<span>Сохраните первый портфель или создайте его через ИИ</span>'}<button class="btn small" type="button" data-action="workspace-reload" ${s.saving?'disabled':''}>Загрузить свежую версию</button></div>`;
  notice.classList.toggle('warning',s.conflict);
}
function renderEditor(){
  clearTimeout(searchTimer);searchAbort?.abort();searchGeneration++;
  openDialog(`${dialogHead(editorIsNew?'Создать портфель':'Настроить портфель')}${editorContent({draft,step:editorStep,isNew:editorIsNew,mode:draftMode,e,icon,max:MAX_ASSETS})}`);
  dialog.scrollTop=0;updateWeightTotal();
}
function readDraft(){
  const form=document.querySelector('#editor-form');if(!form||!draft)return;
  const data=new FormData(form);
  if(data.has('plan-name'))draft.name=String(data.get('plan-name'));
  for(const name of ['cash','feePercent','minimumFee'])if(data.has(name))draft[name]=String(data.get(name));
  form.querySelectorAll('.editor-row').forEach(row=>row.querySelectorAll('[data-field]').forEach(input=>draft.assets[Number(row.dataset.index)][input.dataset.field]=input.value));
  form.querySelectorAll('[data-weight-index]').forEach(input=>draft.assets[Number(input.dataset.weightIndex)].weight=input.value);
}
function updateWeightTotal(){
  if(!draft)return;const total=draft.assets.reduce((s,a)=>s+(Number(String(a.weight).replace(',','.'))||0),0);
  const node=document.querySelector('#weight-total');if(node){node.textContent=`${num(total)} из 100%`;node.closest('.editor-summary').classList.toggle('invalid',Math.abs(total-100)>.00001);}
}
function editPlan(fresh=false){draft=fresh?blankPlan():clone(state.plan);if(fresh)draft.assets=[];draftMode=fresh?'personal':state.mode;editorStep=1;editorIsNew=fresh;renderEditor();}
function calculate(amount,tariff){
  const start=performance.now(),snapshot=clone(state.plan);if(tariff){snapshot.feePercent=tariff.feePercent;snapshot.minimumFee=tariff.minimumFee;}
  const result=allocate(snapshot,amount);state.plan=normalizePlan(snapshot);contribution=String(amount);
  record={id:crypto.randomUUID(),date:new Date().toISOString(),plan:clone(state.plan),contribution,result,mode:state.mode,fingerprint:fingerprint(state.plan),applied:false};
  emit('calculated',{durationMs:Math.round(performance.now()-start),...(flowStarted==null?{}:{flowMs:Math.round(performance.now()-flowStarted)})});flowStarted=null;persist();navigate('result');
}
function saveResult(){
  if(!record)return;if(state.history.some(h=>h.id===record.id))return;
  if(state.history.length>=30){toast('В истории уже 30 расчётов. Скачайте копию и очистите историю в настройках');return;}
  state.history.unshift(record);emit('calculation_saved');persist();render();toast('Расчёт сохранён');
}
function download(name,text,type='application/json'){
  const a=document.createElement('a'),url=URL.createObjectURL(new Blob([text],{type}));a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);
}
function csv(){
  const r=record.result;
  const rows=[['BiBi: план покупок',r.name],['Создан',record.date],['Данные',record.mode==='demo'?'Учебный пример':'Пользовательский ввод'],['Сохранение не является сделкой'],[],['Тикер','Купить, шт.','Лотов','Цена, ₽','Сумма, ₽','Комиссия, ₽','После, шт.','Цена: источник','Дата котировки'],...r.rows.map(a=>[a.ticker,a.buyQuantity,a.lots,(a.price/10000).toFixed(4),(a.amount/100).toFixed(2),(a.fee/100).toFixed(2),a.afterQuantity,a.priceSource,a.quoteAt]),[],['Новый взнос, ₽',(r.contribution/100).toFixed(2)],['Начальные деньги, ₽',(r.startingCash/100).toFixed(2)],['Покупки, ₽',(r.purchaseTotal/100).toFixed(2)],['Комиссия, ₽',(r.fees/100).toFixed(2)],['Остаток, ₽',(r.cash/100).toFixed(2)]];
  return serializeCSV(rows);
}
function settings(){openDialog(`${dialogHead('Настройки','Количества бумаг, доли и суммы хранятся на этом устройстве')}<div class="settings-section"><h3>Резервная копия</h3><p>Скачайте файл, чтобы сохранить портфель или перенести его на другое устройство</p><div class="row"><button class="btn small" data-action="export-backup">${icon('download')}Скачать копию</button><label class="btn small file-label">Загрузить копию<input type="file" id="import-file" accept=".json,application/json"></label></div><div id="import-error" role="alert"></div></div>${loaded.raw?`<div class="settings-section"><h3>Исходный повреждённый файл</h3><p>Он остаётся в хранилище, пока вы не восстановите копию или не начнёте заново</p><button class="btn small" data-action="export-raw">Скачать исходный файл</button></div>`:''}<div class="settings-section"><h3>Данные для проверки продукта</h3><p>Технические события этой копии: расчёты и сохранения. Они не содержат состав портфеля</p><button class="btn small" data-action="export-events">Скачать события</button></div><div class="settings-section"><h3>Очистка</h3><p>Скачайте резервную копию перед удалением</p><div class="row"><button class="btn small danger" data-action="clear-history">Очистить историю</button><button class="btn small danger" data-action="reset">Удалить все локальные данные</button></div></div>`,true);}
function about(){openDialog(`${dialogHead('Помощь')}<div class="settings-section"><h3>Как пополнять портфель</h3><p>Задайте свои бумаги и доли, затем сумму взноса. Расчёт учитывает текущие позиции, целые лоты, комиссию и свободные деньги</p><p>После покупки у брокера нажмите «Записать покупки» и внесите исполненные количества. Следующий взнос будет рассчитан по обновлённому портфелю</p></div><div class="settings-section"><h3>Почему остаются деньги?</h3><p>Нельзя купить часть лота. Остаток можно добавить к следующему взносу. Если цена изменилась, обновите её перед новым расчётом</p></div><div class="settings-section"><h3>Данные и цены</h3><p>Портфель хранится в этом браузере. Чтобы перенести его на другое устройство, скачайте копию в настройках</p><p>MOEX публикует котировки с возможной задержкой. В выходной может отображаться цена прошлой сессии. Тариф 0,05% в примере условный</p><a href="https://www.moex.com/a2920" target="_blank" rel="noopener noreferrer">Об источнике котировок</a></div><details class="explain"><summary>Метод расчёта</summary><p>Снижается квадратичное отклонение стоимостей позиций от заданных долей. Остаток денег также учитывается. Для небольших задач выполняется полный перебор, для больших используется ограниченный поиск</p><p>Показатель отклонения на графике — половина суммы абсолютных разниц долей бумаг в процентных пунктах. Деньги показаны отдельно. Доходность не рассчитывается</p></details>`,true);}
function scenarios(){openDialog(`${dialogHead('Выберите учебный пример','Условные активы и цены. Ваш собственный план можно будет вернуть')}<div class="scenario">${[['two','Портфель 70/30','Цель 50/50. Восстановление долей новым взносом'],['three','Три актива','Разные цены и целевые доли 40/35/25'],['empty','Первое пополнение','Пустой портфель. Постройте план с первой покупки']].map(([key,title,copy])=>`<button class="btn" data-action="load-scenario" data-kind="${key}"><span><strong>${e(title)}</strong><small>${e(copy)}</small></span>${icon('arrow')}</button>`).join('')}</div>`,true);}
function confirmDialog(title,copy,action,label){openDialog(`${dialogHead(title)}<p class="muted">${e(copy)}</p><div class="dialog-actions"><button class="btn" data-action="close-dialog">Отмена</button><button class="btn primary" data-action="${action}">${e(label)}</button></div>`,true);}

function welcomeView(){return `<h1>Пополняйте портфель<br>по своему плану</h1><p>Выберите бумаги и доли. BiBi посчитает, что докупить на новый взнос с учётом того, что у вас уже есть</p><div class="welcome-actions"><button class="btn primary" data-action="new-plan">Создать портфель ${icon('arrow')}</button><button class="btn" data-action="start-demo">Посмотреть пример</button></div><div class="welcome-facts"><span>Акции и биржевые фонды в рублях</span><span>Целые лоты и комиссия брокера</span></div><p class="welcome-note"><button class="text-button" data-action="settings">Загрузить сохранённый портфель</button></p><p class="welcome-note">Без регистрации. Количества бумаг, доли и суммы хранятся в вашем браузере</p>`;}
function validateEditorPositions(){
  readDraft();const candidate=clone(draft);candidate.name=candidate.name||'Мой портфель';candidate.feePercent='0';candidate.minimumFee='0';candidate.assets.forEach((a,i)=>a.weight=i===0?'100':'0');validatePlan(candidate);
}
function editorError(error){const target=dialog.querySelector('#editor-error');if(target){target.className='error';target.textContent=error.message;target.focus();}else toast(error.message);}
async function searchSecurities(query){
  const target=dialog.querySelector('#security-results'),status=dialog.querySelector('#security-search-status');
  if(!target||!status)return;searchAbort?.abort();const generation=++searchGeneration;
  if(query.trim().length<2){target.innerHTML='';status.textContent='Данные Московской биржи';return;}
  searchAbort=new AbortController();status.textContent='Ищем бумаги…';
  try{
    const response=await fetch(`./api/search?q=${encodeURIComponent(query.trim())}`,{signal:searchAbort.signal,credentials:'omit'});
    const data=await response.json();if(!response.ok)throw new Error(data.error||'Поиск недоступен');
    if(generation!==searchGeneration||!dialog.open)return;
    const list=Array.isArray(data.items)?data.items:[];
    target.innerHTML=list.map(a=>`<button class="security-result" type="button" data-action="pick-security" data-ticker="${e(a.ticker)}"><span><strong>${e(a.title)}</strong><small>${e(a.ticker)}</small></span>${icon('plus')}</button>`).join('');
    status.textContent=list.length?'Выберите бумагу из списка':'Бумага не найдена. Её можно ввести вручную';
  }catch(err){if(err.name==='AbortError')return;status.textContent='Поиск недоступен. Бумаги можно ввести вручную';target.innerHTML='';}
}
async function refreshPrices(button){
  if(location.protocol==='file:'){toast('В офлайн-версии цены обновляются вручную');return;}
  const snapshot=fingerprint(state.plan),next=clone(state.plan),failed=[];button.disabled=true;button.textContent='Обновляем…';
  try{
    for(let start=0;start<next.assets.length;start+=3){
      await Promise.all(next.assets.slice(start,start+3).map(async a=>{
        try{const response=await fetch(`./api/quote/${encodeURIComponent(a.ticker)}`,{signal:AbortSignal.timeout(12000),credentials:'omit'});const q=await response.json();if(!response.ok)throw new Error();a.price=String(q.price);a.lot=String(q.lot);a.priceSource=q.source;a.quoteAt=q.quoteAt;}
        catch{failed.push(a.ticker);}
      }));
    }
    if(fingerprint(state.plan)!==snapshot)throw new Error('Портфель изменился. Повторите обновление цен');
    state.plan=normalizePlan(next);state.revision++;emit('prices_updated');persist();render();
    toast(failed.length?`Не обновлены ${failed.join(', ')}. Для них оставлены прежние цены`:'Цены обновлены. Дата источника сохранена');
  }finally{if(button.isConnected){button.disabled=false;button.textContent='Обновить цены';}}
}
function bookDialog(){
  if(!record||record.mode!=='personal')return;
  openDialog(`${dialogHead('Записать покупки','Укажите, сколько купили у брокера, и фактический остаток')}<form id="book-form" novalidate>${record.result.rows.map((a,i)=>`<label class="book-row"><span><strong>${e(a.ticker)}</strong><small>В расчёте ${num(a.buyQuantity)} шт.</small></span><input data-book-index="${i}" inputmode="numeric" value="${a.buyQuantity}" aria-label="Куплено ${e(a.ticker)}, шт."></label>`).join('')}<label class="section-gap">Свободные деньги после покупок, ₽<input name="actualCash" inputmode="decimal" value="${(record.result.cash/100).toFixed(2)}"></label><div id="book-error" role="alert" tabindex="-1"></div><div class="dialog-actions"><button type="button" class="btn" data-action="close-dialog">Отмена</button><button type="submit" class="btn primary">Записать в портфель</button></div></form>`,true);
}
function feedbackDialog(){
  if(!record){toast('Сначала посмотрите расчёт взноса');return;}
  if(record.feedback){toast('Спасибо, отзыв уже отправлен');return;}
  if(location.protocol==='file:'){toast('Отправка отзыва доступна в опубликованной версии');return;}
  const questions=[['understood','Понятно, какие бумаги и сколько купить?'],['commission','Понятны комиссия и остаток?'],['repeat','Использовали бы при следующем пополнении?']];
  openDialog(`${dialogHead('Как вам расчёт?')}<form id="feedback-form">${questions.map(([key,title])=>`<fieldset class="feedback-question"><legend>${e(title)}</legend><div class="row"><label class="feedback-option"><input type="radio" name="${key}" value="yes" required>Да</label><label class="feedback-option"><input type="radio" name="${key}" value="no" required>Нет</label></div></fieldset>`).join('')}<p class="quiet">В команду BiBi отправятся только эти ответы и отметка о режиме примера. Состав и суммы портфеля не передаются</p><div id="feedback-error" role="alert"></div><div class="dialog-actions"><button type="button" class="btn" data-action="close-dialog">Отмена</button><button type="submit" class="btn primary">Отправить отзыв</button></div></form>`,true);
}

document.addEventListener('submit',async ev=>{
  const form=ev.target;if(!['quick-form','contribution-form','editor-form','book-form','feedback-form'].includes(form.id))return;ev.preventDefault();
  try{
    if(form.id==='book-form'){
      if(!state.history.some(h=>h.id===record.id)&&state.history.length>=30)throw new Error('История заполнена. Сначала скачайте копию и очистите историю');
      const quantities=Array.from(form.querySelectorAll('[data-book-index]')).map(input=>input.value);
      bookPurchases(state,record,quantities,String(new FormData(form).get('actualCash')));
      if(!state.history.some(h=>h.id===record.id))state.history.unshift(record);
      emit('purchases_booked');persist();closeDialog();navigate('portfolio');toast('Покупки записаны');
    }else if(form.id==='feedback-form'){
      const feedbackRecord=record,feedbackState=state;
      const data=new FormData(form),payload={schema:1,mode:record.mode};for(const key of ['understood','commission','repeat']){if(!['yes','no'].includes(data.get(key)))throw new Error('Ответьте на все три вопроса');payload[key]=data.get(key)==='yes';}
      const button=form.querySelector('[type=submit]');button.disabled=true;button.textContent='Отправляем…';
      try{
        const response=await fetch('./api/feedback',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)});
        if(!response.ok)throw new Error('Не удалось отправить отзыв. Попробуйте позже');
        if(state!==feedbackState)return;
        feedbackRecord.feedback=true;emit('feedback_submitted',{mode:feedbackRecord.mode});persist();
        // A late response must not close another dialog or mark a newer calculation.
        if(dialog.open&&dialog.querySelector('#feedback-form')===form){closeDialog();toast('Спасибо за отзыв');}
      }finally{if(button.isConnected){button.disabled=false;button.textContent='Отправить отзыв';}}
    }else if(form.id==='editor-form'){
      readDraft();state.plan=normalizePlan(draft);state.mode=draftMode;if(state.mode==='personal')delete state.personalBackup;
      state.onboarded=true;
      state.revision++;emit('plan_saved');persist();closeDialog();record=null;navigate('portfolio');toast('Портфель сохранён');
    }else{const data=new FormData(form);calculate(String(data.get('amount')),form.id==='contribution-form'?{feePercent:String(data.get('feePercent')),minimumFee:String(data.get('minimumFee'))}:null);}
  }catch(err){const target=form.querySelector('[role=alert]');if(target){target.className='error';target.textContent=err.message;target.scrollIntoView({block:'nearest'});}else toast(err.message);}
});
document.addEventListener('input',ev=>{
  if(ev.target.id==='security-query'){clearTimeout(searchTimer);searchTimer=setTimeout(()=>searchSecurities(ev.target.value),300);return;}
  if(ev.target.closest('#editor-form')){
    const row=ev.target.closest('.editor-row');if(row&&ev.target.dataset.field==='price'){
      const a=draft.assets[Number(row.dataset.index)];a.priceSource='Введено вручную';a.quoteAt='';row.querySelector('.quote-note').textContent='Введено вручную';
    }
    readDraft();updateWeightTotal();
  }
  if(ev.target.name==='amount')contribution=ev.target.value;
});
document.addEventListener('focusin',ev=>{if(ev.target.name==='amount'&&flowStarted==null){flowStarted=performance.now();emit('contribution_opened');}});
document.addEventListener('change',async ev=>{
  if(ev.target.id==='workspace-select'){try{await workspaceClient.select(ev.target.value);}catch(e){toast(e.message);}return;}
  if(ev.target.id!=='import-file')return;const file=ev.target.files?.[0];if(!file)return;
  const target=document.querySelector('#import-error');
  try{
    if(file.size>1_000_000)throw new Error('Файл больше 1 МБ. Выберите резервную копию BiBi');
    const candidate=decodeState(await file.text());
    openDialog(`${dialogHead('Восстановить эту копию?')}<p>План «${e(candidate.plan.name)}», активов: ${candidate.plan.assets.length}, расчётов: ${candidate.history.length}. Текущий план и история будут заменены</p><div class="dialog-actions"><button class="btn" data-action="settings">Отмена</button><button class="btn primary" id="confirm-import">Восстановить</button></div>`,true);
    document.querySelector('#confirm-import').onclick=()=>{state=candidate;state.onboarded=true;protectedStorage=false;loaded.raw=null;storageWarning='';persist();closeDialog();record=null;navigate('portfolio');toast('Копия восстановлена');};
  }catch(err){if(target){target.className='error';target.textContent=err.message;}else toast(err.message);}
});
document.addEventListener('click',async ev=>{
  const button=ev.target.closest('[data-action]');if(!button||button.disabled)return;ev.preventDefault();
  const action=button.dataset.action;
  try{
    if(action==='home')navigate(state.onboarded?'portfolio':'welcome');
    else if(action==='start-demo'){state.onboarded=true;state.mode='demo';emit('demo_opened');persist();navigate('portfolio');}
    else if(action==='toggle-theme'){theme=theme==='dark'?'light':'dark';document.documentElement.dataset.theme=theme;try{localStorage.setItem('bibi.theme',theme);}catch{}document.querySelector('meta[name=theme-color]')?.setAttribute('content',theme==='dark'?'#161619':'#f8fafc');render();}
    else if(action==='toggle-sidebar'){collapsed=!collapsed;try{localStorage.setItem('bibi.sidebar',collapsed?'1':'0');}catch{}render();}
    else if(action==='nav'){if(button.dataset.view==='contribution'){flowStarted=performance.now();emit('contribution_opened');}navigate(state.onboarded?button.dataset.view:'welcome');}
    else if(action==='settings')settings();
    else if(action==='about')about();
    else if(action==='close-dialog')closeDialog();
    else if(action==='edit-plan')editPlan();
    else if(action==='new-plan')editPlan(true);
    else if(action==='edit-tariff'){editPlan();editorStep=2;renderEditor();}
    else if(action==='editor-next'){try{validateEditorPositions();editorStep=2;renderEditor();}catch(err){editorError(err);}}
    else if(action==='editor-back'||action==='editor-step'){readDraft();editorStep=1;renderEditor();}
    else if(action==='equal-weights'){readDraft();const basis=Math.floor(10000/draft.assets.length);draft.assets.forEach((a,i)=>a.weight=((i===draft.assets.length-1?10000-basis*(draft.assets.length-1):basis)/100).toFixed(2));renderEditor();}
    else if(action==='pick-security'){
      readDraft();const editing=draft;if(draft.assets.length>=MAX_ASSETS)throw new Error(`Можно добавить до ${MAX_ASSETS} бумаг`);
      if(draft.assets.some(a=>a.ticker===button.dataset.ticker))throw new Error('Эта бумага уже добавлена');
      button.disabled=true;
      try{const response=await fetch(`./api/quote/${encodeURIComponent(button.dataset.ticker)}`,{credentials:'omit',signal:AbortSignal.timeout(12000)});const q=await response.json();if(!response.ok)throw new Error(q.error||'Цена недоступна');
        if(draft!==editing)return;draft.assets.push({ticker:q.ticker,title:q.title,price:String(q.price),lot:String(q.lot),quantity:'0',weight:'0',priceSource:q.source,quoteAt:q.quoteAt});renderEditor();
      }finally{if(button.isConnected)button.disabled=false;}
    }
    else if(action==='refresh-prices')await refreshPrices(button);
    else if(action==='book-purchases')bookDialog();
    else if(action==='feedback')feedbackDialog();
    else if(action==='amount'){contribution=button.dataset.amount;const input=document.querySelector('input[name=amount]');if(input){input.value=contribution;input.focus();}}
    else if(action==='add-asset'){readDraft();if(draft.assets.length<MAX_ASSETS){draft.assets.push({ticker:'',title:'',weight:'0',price:'',lot:'1',quantity:'0',priceSource:'Введено вручную',quoteAt:''});renderEditor();}}
    else if(action==='remove-asset'){readDraft();if(draft.assets.length){draft.assets.splice(Number(button.dataset.index),1);renderEditor();}}
    else if(action==='quote'){
      const previousLabel=button.textContent;
      readDraft();const i=Number(button.dataset.index),a=draft.assets[i],ticker=a.ticker.trim().toUpperCase();
      if(!/^[A-Z0-9._-]{1,16}$/.test(ticker))throw new Error('Введите биржевой тикер латиницей, например SBER');
      button.disabled=true;button.textContent='Получаем данные…';
      try{
        const response=await fetch(`./api/quote/${encodeURIComponent(ticker)}`,{signal:AbortSignal.timeout(12000),credentials:'omit'});
        const quote=await response.json();if(!response.ok)throw new Error(quote.error||'Котировка недоступна');
        const row=document.querySelector(`.editor-row[data-index="${i}"]`);
        if(!draft||draft.assets[i]!==a||!row)return;
        a.price=String(quote.price);a.lot=String(quote.lot);if(!a.title)a.title=quote.title;
        a.priceSource=quote.source;a.quoteAt=quote.quoteAt;
        row.querySelector('[data-field=price]').value=a.price;row.querySelector('[data-field=lot]').value=a.lot;row.querySelector('[data-field=title]').value=a.title;
        row.querySelector('.quote-note').textContent=`${quote.source} · ${quote.quoteAt}`;toast('Цена и лот обновлены. Проверьте дату котировки');
      }catch(err){
        if(err.name==='TypeError'||err.name==='TimeoutError'||err.name==='AbortError')throw new Error('Источник котировок не ответил. Введите цену и лот вручную');
        throw err;
      }finally{button.disabled=false;button.textContent=previousLabel;}
    }
    else if(action==='save-result')saveResult();
    else if(action==='open-record'){record=state.history.find(h=>h.id===button.dataset.id);navigate('result');}
    else if(action==='export-csv')download('BiBi-план-покупок.csv',csv(),'text/csv;charset=utf-8');
    else if(action==='copy-result'){
      const r=record.result,text=`BiBi · ${r.name}\n${record.mode==='demo'?'Учебный пример\n':''}Новый взнос: ${rub(r.contribution)}\n${r.rows.filter(a=>a.lots).map(a=>`${a.ticker}: ${num(a.buyQuantity)} шт., ${rub(a.amount)}, комиссия ${rub(a.fee)}`).join('\n')}\nПокупки: ${rub(r.purchaseTotal)}\nКомиссия: ${rub(r.fees)}\nОстаток: ${rub(r.cash)}\nЭто расчёт, сделки не совершались`;
      try{await navigator.clipboard.writeText(text);toast('План покупок скопирован');}catch{openDialog(`${dialogHead('План покупок')}<textarea id="copy-text" readonly style="width:100%;height:220px;font:inherit;padding:12px">${e(text)}</textarea><p class="quiet">Выделите текст и скопируйте</p>`,true);document.querySelector('#copy-text').select();}
    }
    else if(action==='apply-demo')confirmDialog('Применить покупки в примере?','Обновим количество бумаг и остаток в учебном портфеле. Это позволит рассчитать следующий взнос','confirm-apply','Учесть в примере');
    else if(action==='confirm-apply'){
      if(!state.history.some(h=>h.id===record.id)&&state.history.length>=30)throw new Error('В истории уже 30 расчётов. Сначала скачайте копию и очистите историю');
      applyDemo(state,record);if(!state.history.some(h=>h.id===record.id))state.history.unshift(record);
      emit('demo_applied');persist();closeDialog();navigate('portfolio');toast('Покупки учтены в примере');
    }
    else if(action==='scenarios')scenarios();
    else if(action==='load-scenario'){
      if(state.mode==='personal')state.personalBackup=clone(state.plan);
      state.mode='demo';state.onboarded=true;state.plan=demoPlan(button.dataset.kind);state.revision++;record=null;emit('demo_opened');persist();closeDialog();contribution='20000';navigate('portfolio');
    }
    else if(action==='restore-personal'){if(state.personalBackup){state.plan=state.personalBackup;delete state.personalBackup;state.mode='personal';state.revision++;record=null;persist();navigate('portfolio');}}
    else if(action==='export-backup')download('BiBi-резервная-копия.json',JSON.stringify(state,null,2));
    else if(action==='export-raw')download('BiBi-исходный-файл.json',loaded.raw||'');
    else if(action==='export-events')download('BiBi-локальные-события.json',JSON.stringify({description:'Локальные события этой копии, включая демо и автоматические проверки. Не исследование реальных пользователей.',events:state.events},null,2));
    else if(action==='clear-history')confirmDialog('Очистить историю?','Сохранённые расчёты будут удалены. Сам план и фактические позиции останутся.','confirm-clear-history','Очистить историю');
    else if(action==='confirm-clear-history'){state.history=[];record=null;persist();closeDialog();navigate('portfolio');toast('История очищена');}
    else if(action==='reset')confirmDialog('Удалить локальные данные?','План и история в этом браузере будут удалены. Скачайте копию заранее. Откроется начальный экран.','confirm-reset','Удалить данные');
    else if(action==='confirm-reset'){localStorage.removeItem(STORE_KEY);state=initialState();protectedStorage=false;loaded.raw=null;storageWarning='';record=null;persist();closeDialog();navigate('welcome');}
  }catch(err){toast(err.message||'Не удалось выполнить действие');}
});
dialog.addEventListener('click',ev=>{if(ev.target===dialog){const r=dialog.getBoundingClientRect();if(ev.clientX<r.left||ev.clientX>r.right||ev.clientY<r.top||ev.clientY>r.bottom)closeDialog();}});
dialog.addEventListener('cancel',()=>{draft=null;});
document.addEventListener('click',async ev=>{if(ev.target.closest('[data-action=workspace-reload]')){try{await workspaceClient.reload();toast('Портфель обновлён');}catch(e){toast(e.message);}}});
window.addEventListener('storage',ev=>{if(ev.key===STORE_KEY){storageWarning='В другой вкладке изменились данные. Сохраните копию и обновите страницу перед продолжением';protectedStorage=true;render();}});
render();
workspaceClient=createWorkspaceClient({
  getState:()=>state,isEditing:()=>dialog.open||Boolean(document.activeElement?.matches('input,textarea,select')),
  onStatus:s=>{workspaceStatus=s;renderWorkspaceStatus();},
  onRemote:remote=>{
    state=decodeState(remote);loaded.raw=null;protectedStorage=false;storageWarning='';
    record=record?state.history.find(h=>h.id===record.id)||null:null;
    if(view==='welcome'||view==='result'&&!record)view=state.onboarded?'portfolio':'welcome';
    try{localStorage.setItem(STORE_KEY,JSON.stringify(state));}catch{}
    render();
  }
});
void workspaceClient.start();
