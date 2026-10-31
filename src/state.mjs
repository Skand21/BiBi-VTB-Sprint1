import { allocate, validatePlan, ENGINE_VERSION } from './allocator.mjs';

export const STORE_KEY = 'bibi.portfolio.v1';
export const COLORS = Array.from({length:12},(_,i)=>`var(--chart-${i%8+1})`);
export const clone = x => JSON.parse(JSON.stringify(x));
export function demoPlan(kind = 'two') {
  const base = { name: 'Мой портфель', cash: '0', feePercent: '0.05', minimumFee: '0',
    assets: [
      { ticker: 'ALFA', title: 'Актив А', weight: '50', price: '1000', lot: '1', quantity: '70', priceSource: 'Условная цена', quoteAt: '' },
      { ticker: 'BETA', title: 'Актив Б', weight: '50', price: '1000', lot: '1', quantity: '30', priceSource: 'Условная цена', quoteAt: '' }
    ] };
  if (kind === 'three' || kind === 'empty') {
    base.assets[0] = { ...base.assets[0], weight: '40', quantity: kind === 'empty' ? '0' : '60' };
    base.assets[1] = { ...base.assets[1], weight: '35', quantity: kind === 'empty' ? '0' : '25' };
    base.assets.push({ ticker: 'GAMMA', title: 'Актив В', weight: '25', price: '500', lot: '1', quantity: kind === 'empty' ? '0' : '30', priceSource: 'Условная цена', quoteAt: '' });
  }
  return base;
}
export function blankPlan() {
  return { name: 'Мой портфель', cash: '0', feePercent: '0.05', minimumFee: '0',
    assets: [0, 1].map(() => ({ ticker: '', title: '', weight: '50', price: '', lot: '1', quantity: '0', priceSource: 'Введено вручную', quoteAt: '' })) };
}
export function initialState() {
  return { schema: 1, mode: 'demo', onboarded: false, plan: demoPlan(), history: [], events: [], revision: 1, createdAt: new Date().toISOString() };
}
export function normalizePlan(plan) {
  const p = validatePlan(plan);
  const compact = (n, places) => n.toFixed(places).replace(/\.?0+$/, '');
  return { name: p.name, cash: compact(p.cash / 100, 2), feePercent: compact(p.feeRate / 10_000, 4), minimumFee: compact(p.minimumFee / 100, 2),
    assets: p.assets.map(a => ({ ticker: a.ticker, title: a.title, price: compact(a.price / 10_000, 4),
      lot: String(a.lot), quantity: String(a.quantity), weight: compact(a.weight / 100, 2), priceSource: a.priceSource, quoteAt: a.quoteAt })) };
}
export function fingerprint(plan) { return JSON.stringify(normalizePlan(plan)); }
export function decodeState(raw) {
  const source = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!source || source.schema !== 1 || !['demo', 'personal'].includes(source.mode)) throw new Error('Формат файла не поддерживается');
  const state = { schema: 1, mode: source.mode, onboarded: source.onboarded !== false, plan: normalizePlan(source.plan), history: [], events: [], revision: 1,
    createdAt: typeof source.createdAt === 'string' ? source.createdAt.slice(0, 40) : new Date().toISOString() };
  if (source.personalBackup) state.personalBackup = normalizePlan(source.personalBackup);
  if (!Array.isArray(source.history) || source.history.length > 30) throw new Error('В файле должно быть не больше 30 сохранённых расчётов');
  const ids = new Set();
  state.history = source.history.map(h => {
    if (!h || typeof h.id !== 'string' || h.id.length > 80 || ids.has(h.id)) throw new Error('Некорректная история расчётов');
    ids.add(h.id);
    const plan = normalizePlan(h.plan), contribution = String(h.contribution);
    const result = allocate(plan, contribution);
    return { id: h.id, date: typeof h.date === 'string' ? h.date.slice(0, 40) : '', plan, contribution, result,
      mode: h.mode === 'demo' ? 'demo' : 'personal', applied: h.applied === true, booked: h.booked === true, feedback: h.feedback === true, fingerprint: fingerprint(plan), version: ENGINE_VERSION };
  });
  if (Array.isArray(source.events)) state.events = source.events.slice(-300).filter(e => e && typeof e.type === 'string' && typeof e.at === 'string').map(e => ({ type: e.type.slice(0, 60), at: e.at.slice(0, 40), mode: e.mode === 'demo' ? 'demo' : 'personal', durationMs: Number.isFinite(e.durationMs) ? Math.max(0, e.durationMs) : undefined, flowMs: Number.isFinite(e.flowMs) ? Math.max(0, e.flowMs) : undefined }));
  return state;
}

export function bookPurchases(state, record, quantities, cash) {
  if (state.mode !== 'personal' || record.mode !== 'personal') throw new Error('Запись покупок доступна в собственном портфеле');
  if (record.booked) throw new Error('Эти покупки уже записаны');
  if (fingerprint(state.plan) !== record.fingerprint) throw new Error('Портфель изменился. Сначала обновите расчёт');
  if (!Array.isArray(quantities) || quantities.length !== record.result.rows.length) throw new Error('Проверьте количества бумаг');
  const next = clone(state.plan);
  quantities.forEach((q,i) => {
    if (!/^\d+$/.test(String(q))) throw new Error('Количество покупки должно быть целым неотрицательным числом');
    const count = Number(q);
    if (!Number.isSafeInteger(count) || count > 100_000_000) throw new Error('Слишком большое количество бумаг');
    next.assets[i].quantity = String(Number(next.assets[i].quantity) + count);
  });
  next.cash = String(cash);
  const normalized = normalizePlan(next); // Commit only after complete validation.
  state.plan = normalized; record.booked = true; state.revision++;
}
export function loadState(storage) {
  const raw = storage.getItem(STORE_KEY);
  if (!raw) return { state: initialState(), error: null };
  try { return { state: decodeState(raw), error: null }; }
  catch { return { state: initialState(), error: 'Сохранённый файл повреждён. Пока открыт пример; исходные данные не перезаписаны. В настройках можно скачать исходную копию или начать заново.', raw }; }
}
export function applyDemo(state, record) {
  if (state.mode !== 'demo' || record.mode !== 'demo') throw new Error('Условные покупки доступны только в примере');
  if (record.applied) throw new Error('Этот расчёт уже учтён');
  if (fingerprint(state.plan) !== record.fingerprint) throw new Error('Портфель изменился. Рассчитайте пополнение заново');
  state.plan.assets.forEach((a, i) => { a.quantity = String(record.result.rows[i].afterQuantity); });
  state.plan.cash = (record.result.cash / 100).toFixed(2);
  record.applied = true;
  state.revision++;
}
