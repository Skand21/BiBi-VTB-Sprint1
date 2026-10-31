export function editorContent({draft,step,isNew,mode,e,icon,max}) {
  const row = (a,i) => `<section class="editor-row" data-index="${i}">
    <div class="editor-row-head"><div><h3>${e(a.title||a.ticker||'Новая бумага')}</h3>${a.title&&a.ticker?`<span class="small muted">${e(a.ticker)}</span>`:''}</div><button class="icon-button" type="button" data-action="remove-asset" data-index="${i}" aria-label="Убрать бумагу ${i+1}">${icon('trash')}</button></div>
    <div class="position-fields"><label>Уже есть, шт.<input data-field="quantity" inputmode="numeric" value="${e(a.quantity)}"></label><label>Цена за штуку, ₽<input data-field="price" inputmode="decimal" value="${e(a.price)}" placeholder="Цена у брокера"></label></div>
    <div class="row wrap space-between quote-line"><span class="quote-note" data-quote-note="${i}">${e(a.priceSource||'Введено вручную')}${a.quoteAt?' · '+e(a.quoteAt):''}</span><button type="button" class="text-button" data-action="quote" data-index="${i}" ${!a.ticker||location.protocol==='file:'?'disabled':''}>Обновить цену</button></div>
    <details class="asset-details" ${!a.ticker?'open':''}><summary>Тикер, название и лот</summary><div class="editor-fields"><label>Тикер<input data-field="ticker" maxlength="16" value="${e(a.ticker)}" placeholder="SBER" autocomplete="off"></label><label class="title-field">Название<input data-field="title" maxlength="80" value="${e(a.title)}" placeholder="Название бумаги" autocomplete="off"></label><label>Штук в лоте<input data-field="lot" inputmode="numeric" value="${e(a.lot)}"></label></div></details>
  </section>`;
  return `<div class="editor-tabs" role="group" aria-label="Настройка портфеля"><button type="button" data-action="editor-step" data-step="1" aria-pressed="${step===1}">Бумаги</button><button type="button" data-action="editor-next" aria-pressed="${step===2}">Доли и тариф</button></div>
  <form id="editor-form" novalidate>
  ${step===1?`
    <div class="security-search"><label for="security-query">Найти акцию или фонд</label><div class="search-field">${icon('search')}<input id="security-query" type="search" autocomplete="off" placeholder="Название или тикер" ${location.protocol==='file:'?'disabled':''} aria-describedby="security-search-status"></div><div id="security-search-status" class="small muted" role="status">${location.protocol==='file:'?'В офлайн-версии бумаги можно ввести вручную':'Данные Московской биржи'}</div><div id="security-results"></div></div>
    <div id="editor-assets">${draft.assets.map(row).join('')}</div>
    ${!draft.assets.length?'<p class="editor-empty">Добавьте хотя бы две бумаги. Если их пока нет, укажите количество 0</p>':''}
    <button type="button" class="text-button" data-action="add-asset" ${draft.assets.length>=max?'disabled':''}>${icon('plus')}Ввести бумагу вручную</button>
    <label class="section-gap">Свободные деньги, ₽<input name="cash" inputmode="decimal" value="${e(draft.cash)}"></label>
  `:`
    <label>Название портфеля<input name="plan-name" maxlength="80" value="${e(draft.name)}" autocomplete="off"></label>
    <div class="weights-title"><h3>Какие доли хотите держать?</h3><button class="text-button" type="button" data-action="equal-weights">Поровну</button></div>
    <div class="weight-rows">${draft.assets.map((a,i)=>`<label class="weight-row"><span><strong>${e(a.ticker)}</strong><small>${e(a.title)}</small></span><span class="weight-input"><input data-weight-index="${i}" aria-label="Доля ${e(a.ticker)}, %" inputmode="decimal" value="${e(a.weight)}"><span>%</span></span></label>`).join('')}</div>
    <div class="editor-summary"><span>Сумма долей</span><strong id="weight-total"></strong></div>
    <details class="tariff" open><summary>Комиссия брокера</summary><div class="two-fields"><label>За покупку, %<input name="feePercent" inputmode="decimal" value="${e(draft.feePercent)}"></label><label>Минимум за заявку, ₽<input name="minimumFee" inputmode="decimal" value="${e(draft.minimumFee)}"></label></div><p class="quiet">Укажите свой тариф. Значение 0,05% в примере условное</p></details>
  `}
  <div id="editor-error" role="alert" tabindex="-1"></div>
  <div class="dialog-actions"><button class="btn" type="button" data-action="${step===2?'editor-back':'close-dialog'}">${step===2?'Назад':'Отмена'}</button>${step===1&&isNew?`<button class="btn primary" type="button" data-action="editor-next">Далее: доли ${icon('arrow')}</button>`:`<button class="btn primary" type="submit">${isNew?'Создать портфель':'Сохранить изменения'}</button>`}</div>
  </form>`;
}
